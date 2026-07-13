import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePort,
  inspectPort,
  isLive,
  openProcAttemptLog,
  startTimeOf,
  substitutePort,
  withLock,
} from "../src/index.ts";
import { startProc } from "../src/proc/supervisor.ts";
import { stopProcTree } from "../src/proc/shutdown.ts";
import { probeProcessIdentity, readPidfile } from "../src/proc/pidfile.ts";
import { RotatingLogWriter } from "../src/proc/proc-relay.ts";

const tmpDirs: string[] = [];
const cleanupPgids: number[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "hestia-proc-"));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const pgid of cleanupPgids) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("substitutePort", () => {
  test("substitutes {port}, escapes {{port}}, leaves plain args alone", () => {
    expect(
      substitutePort(["dev", "-p", "{port}", "fmt={{port}}", "a b"], 4321),
    ).toEqual(["dev", "-p", "4321", "fmt={port}", "a b"]);
  });
});

describe("detached spawn survives the spawning process (the Bun compat assumption)", () => {
  test("grandchild is alive after its parent exited", () => {
    // parent script: spawn a detached sleeper via node:child_process, print
    // its pid, exit immediately — exactly what the CLI does.
    const parent = `
      const { spawn } = require("node:child_process");
      const c = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      c.unref();
      console.log(c.pid);
    `;
    const out = execFileSync("bun", ["-e", parent], { encoding: "utf8" });
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    cleanupPgids.push(pid);
    // the parent bun process has exited (execFileSync returned); the detached
    // child must still be alive and be its own process-group leader
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(startTimeOf(pid)).not.toBeNull();
    process.kill(-pid, "SIGKILL");
  });
});

describe("pidfile liveness (verbatim lstart guard)", () => {
  test("tri-state identity distinguishes live processes from clean mismatches", () => {
    const startTime = startTimeOf(process.pid)!;
    expect(probeProcessIdentity({ pid: process.pid, startTime })).toBe("live");
    expect(probeProcessIdentity({ pid: process.pid, startTime: "wrong start" })).toBe("dead");
    expect(probeProcessIdentity({ pid: 999_999_999, startTime: "gone" })).toBe("dead");
  });

  test("process identity stays stable across caller locales", () => {
    const originalLcAll = process.env.LC_ALL;
    const originalLang = process.env.LANG;
    try {
      process.env.LC_ALL = "en_DK.UTF-8";
      process.env.LANG = "en_DK.UTF-8";
      const danishCaller = startTimeOf(process.pid);
      process.env.LC_ALL = "C";
      process.env.LANG = "C";
      expect(startTimeOf(process.pid)).toBe(danishCaller);
    } finally {
      if (originalLcAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLcAll;
      if (originalLang === undefined) delete process.env.LANG;
      else process.env.LANG = originalLang;
    }
  });

  test("pre-normalization locale ordering remains live during upgrade", () => {
    const canonical = startTimeOf(process.pid)!;
    const [weekday, month, day, time, year] = canonical.split(/\s+/);
    const legacyLocaleOrder = `${weekday} ${day} ${month} ${time} ${year}`;
    expect(isLive({ pid: process.pid, startTime: legacyLocaleOrder })).toBe(true);
  });

  test("translated pre-normalization locale remains live during upgrade", () => {
    const locale = "fr_FR.UTF-8";
    const parent = `
      const { spawn } = require("node:child_process");
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
      console.log(child.pid);
    `;
    const pid = Number(execFileSync("bun", ["-e", parent], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: locale, LANG: locale },
    }).trim());
    cleanupPgids.push(pid);
    const translated = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: locale, LANG: locale },
    }).trim();
    expect(translated).not.toBe(startTimeOf(pid));
    expect(isLive({ pid, startTime: translated })).toBe(true);
    process.kill(-pid, "SIGKILL");
  });

  test("live process matches; wrong startTime reads as dead", () => {
    const out = execFileSync(
      "bun",
      ["-e", `const {spawn}=require("node:child_process");const c=spawn("sleep",["30"],{detached:true,stdio:"ignore"});c.unref();console.log(c.pid);`],
      { encoding: "utf8" },
    );
    const pid = Number(out.trim());
    cleanupPgids.push(pid);
    const startTime = startTimeOf(pid)!;
    expect(isLive({ pid, startTime })).toBe(true);
    // a recycled pid would carry a different start time
    expect(isLive({ pid, startTime: "Thu Jan  1 00:00:00 1970" })).toBe(false);
    process.kill(-pid, "SIGKILL");
    // give the kernel a beat, then the same identity must read dead
    Bun.sleepSync(50);
    expect(isLive({ pid, startTime })).toBe(false);
  });
});

describe("port ownership oracle", () => {
  test("member-owned port is ready; foreign-owned port is a steal", async () => {
    const port = await allocatePort();
    expect(port).toBeGreaterThan(0);

    // occupy the port from a DIFFERENT process group (this test's own child,
    // not detached into a new group we track) — simulates the stealer
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    try {
      // some unrelated pgid (a detached sleeper) does NOT own the port
      const out = execFileSync(
        "bun",
        ["-e", `const {spawn}=require("node:child_process");const c=spawn("sleep",["10"],{detached:true,stdio:"ignore"});c.unref();console.log(c.pid);`],
        { encoding: "utf8" },
      );
      const strangerPgid = Number(out.trim());
      cleanupPgids.push(strangerPgid);
      const view = await inspectPort(strangerPgid, port);
      expect(view.owner).toBeDefined(); // someone owns it (us)
      expect(view.ownerIsMember).toBe(false); // …but not that pgid → steal
      process.kill(-strangerPgid, "SIGKILL");

      // and the owner IS a member of its own process tree (root = ourselves)
      const own = await inspectPort(process.pid, port);
      expect(own.ownerIsMember).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("startProc", () => {
  test("rotating relay bounds the current log plus three archives", () => {
    const root = scratch();
    const path = join(root, "bounded.log");
    const writer = new RotatingLogWriter(path, 32, 3);
    writer.write(Buffer.alloc(32 * 6, "x"));
    writer.close();
    expect(existsSync(`${path}.4`)).toBe(false);
    for (const candidate of [path, `${path}.1`, `${path}.2`, `${path}.3`]) {
      expect(statSync(candidate).size).toBeLessThanOrEqual(32);
    }
  });

  test("fresh attempts truncate while port-steal retries append a sentinel", () => {
    const logPath = join(scratch(), "retry.log");
    writeFileSync(logPath, "stale output\n");
    closeSync(openProcAttemptLog(logPath, 1));
    expect(readFileSync(logPath, "utf8")).toBe("");
    writeFileSync(logPath, "first attempt\n");
    closeSync(openProcAttemptLog(logPath, 2));
    expect(readFileSync(logPath, "utf8")).toBe(
      "first attempt\n--- hestia: proc restarted (port stolen) ---\n",
    );
  });

  test("no-port proc gets env layered correctly (spec.env wins) and stops cleanly", async () => {
    const wt = scratch();
    const outFile = join(wt, "env.json");
    const result = await startProc(
      wt,
      {
        name: "envdump",
        argv: [
          "bun",
          "-e",
          `require("node:fs").writeFileSync(process.env.OUT, JSON.stringify({A: process.env.A, B: process.env.B})); setTimeout(()=>{}, 20_000);`,
        ],
        env: { OUT: outFile, B: "from-spec" },
        port: "none",
      },
      { A: "from-stack", B: "stack-loses" },
    );
    cleanupPgids.push(result.pidfile.pgid);
    expect(result.error).toBeUndefined();
    expect(result.record.state).toBe("healthy");
    const dumped = JSON.parse(readFileSync(outFile, "utf8"));
    expect(dumped.A).toBe("from-stack");
    expect(dumped.B).toBe("from-spec"); // --env beats stack env
    const persisted = readFileSync(join(wt, ".hestia", "procs", "envdump.json"), "utf8");
    expect(persisted).not.toContain("from-spec");
    expect(persisted).not.toContain("writeFileSync(process.env.OUT");
    expect(JSON.parse(persisted).specFingerprint).toMatch(/^[0-9a-f]{64}$/);

    await stopProcTree(result.pidfile);
    expect(isLive(result.pidfile)).toBe(false);
    expect(readPidfile(wt, "envdump")).not.toBeNull(); // caller removes it
  });

  test("{port} argv substitution + ownership readiness + live HTTP", async () => {
    const wt = scratch();
    writeFileSync(
      join(wt, "server.ts"),
      `const port = Number(process.argv[2]);
       Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
       setTimeout(() => {}, 30_000);`,
    );
    const result = await startProc(
      wt,
      {
        name: "web",
        argv: ["bun", "server.ts", "{port}"],
        port: "auto",
        readyTimeoutMs: 15_000,
      },
      {},
    );
    cleanupPgids.push(result.pidfile.pgid);
    expect(result.error).toBeUndefined();
    expect(result.record.state).toBe("healthy");
    const res = await fetch(`http://127.0.0.1:${result.record.publishedPort}/`);
    expect(await res.text()).toBe("ok");
    await stopProcTree(result.pidfile);
    expect(isLive(result.pidfile)).toBe(false);
  });

  test("crash before ready → proc-exited with log pointer", async () => {
    const wt = scratch();
    await expect(
      startProc(
        wt,
        {
          name: "crasher",
          argv: ["bun", "-e", `console.error("boom"); process.exit(3);`],
          port: "auto",
          readyTimeoutMs: 10_000,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "proc-exited" });
    const log = readFileSync(join(wt, ".hestia", "logs", "crasher.log"), "utf8");
    expect(log).toContain("boom");
    expect(readPidfile(wt, "crasher")).toBeNull(); // cleaned up
  });

  test("never-binding proc times out, is left running, hints --no-port", async () => {
    const wt = scratch();
    const result = await startProc(
      wt,
      {
        name: "quiet",
        argv: ["sleep", "30"],
        port: "auto",
        readyTimeoutMs: 2_000,
      },
      {},
    );
    cleanupPgids.push(result.pidfile.pgid);
    expect(result.error?.code).toBe("proc-ready-timeout");
    expect(result.error?.message).toContain("--no-port");
    expect(result.record.state).toBe("unhealthy");
    expect(isLive(result.pidfile)).toBe(true); // left running for inspection
    await stopProcTree(result.pidfile);
  });

  test("invalid name is rejected", async () => {
    await expect(
      startProc(scratch(), { name: "../evil", argv: ["true"] }, {}),
    ).rejects.toMatchObject({ code: "name-conflict" });
  });
});

describe("withLock", () => {
  test("serializes critical sections and breaks stale locks", async () => {
    const wt = scratch();
    const order: number[] = [];
    await Promise.all([
      withLock(wt, async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 300));
        order.push(2);
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 50)); // let #1 acquire first
        await withLock(wt, async () => {
          order.push(3);
        });
      })(),
    ]);
    expect(order).toEqual([1, 2, 3]);

    // stale: lock held by a long-dead pid is broken immediately
    mkdirSync(join(wt, ".hestia"), { recursive: true });
    writeFileSync(
      join(wt, ".hestia", "lock"),
      JSON.stringify({ pid: 999999, startTime: "gone" }),
    );
    let ran = false;
    await withLock(wt, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
