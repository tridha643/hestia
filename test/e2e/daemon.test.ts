import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// hestiad end-to-end, NO docker required, fully isolated via HESTIA_HOME:
// the CLI auto-spawns the daemon, the cap admits/queues/denies stacks, a
// killed daemon is respawned by the next command (single-instance guarded),
// `daemon stop` never touches running stacks, and a dead adopted-tunnel
// connector (stub cloudflared) is revived by the daemon's first sweep tick.

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "proc-repo");
const STUB_DIR = join(import.meta.dir, "..", "fixtures", "tunnel-stub");

let tmpRoot: string;
let home: string;
let repoDir: string;
let wtA: string;
let wtB: string;
let wtC: string;
let env: Record<string, string>;
const uuid = `dmn-uuid-${Math.random().toString(36).slice(2, 10)}`;

function runCli(cwd: string, args: string[]): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hestia",
      GIT_AUTHOR_EMAIL: "hestia@test",
      GIT_COMMITTER_NAME: "hestia",
      GIT_COMMITTER_EMAIL: "hestia@test",
    },
  });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonJson(): { pid: number; port: number } | null {
  const p = join(home, "daemon", "daemon.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { pid: number; port: number };
  } catch {
    return null;
  }
}

function connectorPid(): number | null {
  const p = join(home, "tunnel", uuid, ".hestia", "procs", "connector.json");
  if (!existsSync(p)) return null;
  const pf = JSON.parse(readFileSync(p, "utf8")) as { pid: number };
  return alive(pf.pid) ? pf.pid : null;
}

async function serving(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

function firstError(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line) as { error?: { code?: string } };
      if (parsed.error?.code !== undefined) return parsed.error.code;
    } catch {}
  }
  return undefined;
}

describe("hestiad admission + supervision (daemon e2e)", () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-daemon-e2e-"));
    home = join(tmpRoot, "home");
    mkdirSync(home, { recursive: true });
    repoDir = join(tmpRoot, "dmnrepo");
    cpSync(FIXTURE, repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    wtA = join(tmpRoot, "wt-a");
    wtB = join(tmpRoot, "wt-b");
    wtC = join(tmpRoot, "wt-c");
    git(repoDir, ["worktree", "add", "-q", "-b", "dmn-a", wtA]);
    git(repoDir, ["worktree", "add", "-q", "-b", "dmn-b", wtB]);
    git(repoDir, ["worktree", "add", "-q", "-b", "dmn-c", wtC]);

    // stub cloudflared world (same fixture as the tunnel e2e), inside tmpRoot
    const stubState = join(tmpRoot, "stub-state");
    mkdirSync(stubState);
    writeFileSync(
      join(stubState, "tunnels.json"),
      JSON.stringify([{ id: uuid, name: "dmntun", connections: [] }]),
    );
    const cfHome = join(tmpRoot, "cf-home");
    mkdirSync(cfHome);
    writeFileSync(join(cfHome, "cert.pem"), "stub-cert");
    writeFileSync(join(cfHome, `${uuid}.json`), JSON.stringify({ TunnelID: uuid }));

    env = {
      HESTIA_HOME: home,
      HESTIA_MAX_STACKS: "2",
      HESTIA_NO_OPEN: "1",
      HESTIA_STUB_STATE: stubState,
      HESTIA_CLOUDFLARED_HOME: cfHome,
      HESTIA_E2E_DNS_RESOLVED: "1",
      PATH: `${STUB_DIR}:${process.env.PATH}`,
    };
  });

  afterAll(() => {
    for (const wt of [wtA, wtB, wtC]) {
      if (wt && existsSync(wt)) runCli(wt, ["down"]);
    }
    if (env !== undefined) runCli(tmpRoot, ["daemon", "stop"]);
    const cpid = connectorPid();
    if (cpid !== null) {
      try {
        process.kill(-cpid, "SIGKILL");
      } catch {}
    }
    const d = daemonJson();
    if (d !== null && alive(d.pid)) {
      try {
        process.kill(d.pid, "SIGKILL");
      } catch {}
    }
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  const run = (wt: string, extra: string[] = []) =>
    runCli(wt, ["run", "--name", "web", ...extra, "--json", "--", "bun", "server.ts"]);

  test(
    "cap: auto-spawned daemon admits 2, denies the 3rd, --wait queues FIFO",
    async () => {
      // first run auto-spawns hestiad and takes slot 1
      expect(run(wtA).code).toBe(0);
      const d = daemonJson();
      expect(d).not.toBeNull();
      expect(alive(d!.pid)).toBe(true);

      // slot 2
      expect(run(wtB).code).toBe(0);

      // an already-admitted project never takes a second slot
      expect(
        runCli(wtB, ["run", "--name", "web2", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);

      // 3rd project: fail fast with the stable code
      const denied = run(wtC);
      expect(denied.code).toBe(1);
      expect(firstError(denied.stdout)).toBe("stack-limit");

      // --wait joins the FIFO queue and proceeds once a slot frees
      const waiter = Bun.spawn(
        ["bun", CLI, "run", "--name", "web", "--wait", "60", "--json", "--", "bun", "server.ts"],
        { cwd: wtC, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
      );
      await new Promise((r) => setTimeout(r, 1_000));
      expect(runCli(wtA, ["down"]).code).toBe(0); // frees a slot → immediate grant
      expect(await waiter.exited).toBe(0);
      const status = runCli(wtC, ["status", "--json"]);
      expect(status.stdout).toContain('"state":"healthy"');
    },
    120_000,
  );

  test("explicit route intent exposes the direct URL without Portless installation", () => {
    const added = runCli(wtB, ["route", "add", "web", "--json"]);
    expect(added.code).toBe(0);
    const record = JSON.parse(added.stdout) as {
      env: Record<string, string>;
      endpoints: Array<{ name: string; url?: string; localUrl?: string }>;
    };
    const endpoint = record.endpoints.find((candidate) => candidate.name === "web");
    if (endpoint?.url === undefined || endpoint.localUrl === undefined) {
      throw new Error("route add did not project direct and local URL surfaces");
    }
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(endpoint.localUrl).toMatch(/^https:\/\/.+\.localhost$/);
    expect(record.env.HESTIA_WEB_DIRECT_URL).toBe(endpoint.url);
    expect(record.env.HESTIA_WEB_LOCAL_URL).toBe(endpoint.localUrl);

    const opened = runCli(wtB, ["open", "web", "--direct"]);
    expect(opened.code).toBe(0);
    expect(opened.stdout.trim()).toBe(endpoint.url);
  });

  test(
    "killed daemon: status honest, next command respawns (fresh pid), start idempotent",
    async () => {
      const before = daemonJson()!;
      process.kill(before.pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));

      expect(runCli(tmpRoot, ["daemon", "status"]).stdout).toContain("not running");

      // any admission-taking command brings it back (wtC is live → no-op grant,
      // but the ensure path still has to spawn a fresh daemon first)
      expect(
        runCli(wtC, ["run", "--name", "web2", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);
      const after = daemonJson()!;
      expect(after.pid).not.toBe(before.pid);
      expect(alive(after.pid)).toBe(true);

      // daemon start against a healthy daemon is a no-op (single instance)
      expect(runCli(tmpRoot, ["daemon", "start"]).code).toBe(0);
      expect(daemonJson()!.pid).toBe(after.pid);
    },
    120_000,
  );

  test(
    "daemon stop pauses supervision but never touches running stacks",
    async () => {
      const status = runCli(wtB, ["status", "--json"]);
      const record = JSON.parse(status.stdout) as { env: Record<string, string> };
      const port = Number(record.env.HESTIA_WEB_PORT);
      expect(await serving(port)).toBe(true);

      expect(runCli(tmpRoot, ["daemon", "stop"]).code).toBe(0);
      expect(runCli(tmpRoot, ["daemon", "status"]).stdout).toContain("not running");
      expect(await serving(port)).toBe(true); // stack untouched
    },
    120_000,
  );

  test(
    "dead adopted-tunnel connector is revived by the daemon's first sweep tick",
    async () => {
      // adopt the stub named tunnel from wtC's live stack
      const exposed = runCli(wtC, ["expose", "web", "--tunnel", "dmntun", "--zone", "stub.test", "--json"]);
      expect(exposed.code).toBe(0);
      const pid1 = connectorPid();
      expect(pid1).not.toBeNull();

      // connector dies while no CLI is running and the daemon is stopped
      process.kill(-pid1!, "SIGKILL");
      await new Promise((r) => setTimeout(r, 300));
      expect(connectorPid()).toBeNull();

      // daemon start → duties run an immediate first tick → revival
      expect(runCli(tmpRoot, ["daemon", "start"]).code).toBe(0);
      let revived: number | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        revived = connectorPid();
        if (revived !== null) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(revived).not.toBeNull();
      expect(revived).not.toBe(pid1);
    },
    120_000,
  );

  test(
    "down on a procs-only stack in a compose repo never touches docker",
    () => {
      // regression (found on modem): repo HAS a compose file but this stack
      // only ever `run` — down used to composeDown a nonexistent override
      writeFileSync(
        join(wtC, "docker-compose.yml"),
        "services:\n  db:\n    image: nope\n",
      );
      expect(runCli(wtC, ["down"]).code).toBe(0);
      expect(existsSync(join(wtC, ".hestia", "stack.json"))).toBe(false);
      // restore wtC's stack for the following tests
      expect(run(wtC).code).toBe(0);
      expect(
        runCli(wtC, ["expose", "web", "--tunnel", "dmntun", "--zone", "stub.test", "--json"]).code,
      ).toBe(0);
    },
    120_000,
  );

  test(
    "doctor: budgeted, report-only, sees the daemon and the stack",
    async () => {
      const started = Date.now();
      const out = runCli(wtC, ["doctor", "--json"]);
      expect(Date.now() - started).toBeLessThan(20_000);
      const rows = JSON.parse(out.stdout) as Array<{ check: string; level: string }>;
      const daemonRow = rows.find((r) => r.check === "daemon");
      expect(daemonRow?.level).toBe("ok");
      expect(rows.find((r) => r.check === "worktree")?.level).toBe("ok");
      // report-only: nothing changed hands — the stack is still serving
      const status = runCli(wtC, ["status", "--json"]);
      expect(status.stdout).toContain('"state":"healthy"');
    },
    120_000,
  );

  // ---- shared hostnames: stable URL, consent handoff, zero-restart switch ----

  function gatewaySocket(): string {
    const raw = JSON.parse(readFileSync(join(home, "daemon", "daemon.json"), "utf8")) as {
      gatewaySocket?: string;
    };
    expect(raw.gatewaySocket).toBeDefined();
    return raw.gatewaySocket!;
  }

  async function gatewayGet(hostname: string): Promise<{ status: number; body: string }> {
    const response = await fetch(`http://${hostname}/`, {
      unix: gatewaySocket(),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.text() };
  }

  function sharedFile(): { holder?: { project: string }; queue?: Array<{ project: string; denied?: boolean }> } {
    return JSON.parse(readFileSync(join(home, "shared", "dmn-shared.json"), "utf8"));
  }

  function projectOf(wt: string): string {
    return (JSON.parse(runCli(wt, ["status", "--json"]).stdout) as { project: string }).project;
  }

  function procGroup(wt: string, name: string): number {
    const pidfile = JSON.parse(
      readFileSync(join(wt, ".hestia", "procs", `${name}.json`), "utf8"),
    ) as { pgid: number };
    return pidfile.pgid;
  }

  async function waitForSharedHolder(project: string | undefined, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sharedFile().holder?.project === project) return;
      await Bun.sleep(100);
    }
    throw new Error(`shared holder did not become ${project ?? "unclaimed"}`);
  }

  test(
    "expose --shared declares + claims a stable hostname routed through the gateway",
    async () => {
      // restart wtC's web with a marker so routing is attributable
      expect(runCli(wtC, ["stop", "web"]).code).toBe(0);
      expect(
        runCli(wtC, ["run", "--name", "web", "--env", "WORKTREE_MARKER=C", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);
      const exposed = runCli(wtC, ["expose", "web", "--shared", "dmn-shared", "--tunnel", "dmntun", "--zone", "stub.test", "--json"]);
      expect(exposed.code).toBe(0);
      expect(sharedFile().holder?.project).toBe(projectOf(wtC));
      // holder-independent static rule in the connector config, Host untouched
      const config = readFileSync(join(home, "tunnel", uuid, "config.yml"), "utf8");
      expect(config).toContain("dmn-shared.stub.test");
      expect(config.split("dmn-shared.stub.test")[1]!.split("- hostname")[0]).not.toContain("httpHostHeader");
      // the stable URL lands in env + endpoints[]
      const status = JSON.parse(runCli(wtC, ["status", "--json"]).stdout) as {
        env: Record<string, string>;
      };
      expect(status.env.HESTIA_WEB_URL).toBe("https://dmn-shared.stub.test");
      // and the gateway routes it to wtC's live process
      const got = await gatewayGet("dmn-shared.stub.test");
      expect(got.status).toBe(200);
      expect(JSON.parse(got.body).marker).toBe("C");
    },
    120_000,
  );

  test(
    "consent handoff: deny keeps the waiter durably queued, allow switches with ZERO connector restart",
    async () => {
      // wtB gets an attributable web too (web2 keeps its slot occupied)
      expect(runCli(wtB, ["stop", "web"]).code).toBe(0);
      expect(
        runCli(wtB, ["run", "--name", "web", "--env", "WORKTREE_MARKER=B", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);
      const connectorBefore = connectorPid();
      expect(connectorBefore).not.toBeNull();

      // fail-fast claim: stable code, durable queue entry
      const denied = runCli(wtB, ["claim", "dmn-shared", "--json"]);
      expect(denied.code).toBe(1);
      expect(firstError(denied.stdout)).toBe("shared-held");
      expect(sharedFile().queue?.map((waiter) => waiter.project)).toEqual([projectOf(wtB)]);

      // blocked claim re-attaches to the same durable entry
      const waiter = Bun.spawn(
        ["bun", CLI, "claim", "dmn-shared", "--wait", "60", "--json"],
        { cwd: wtB, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
      );
      await new Promise((r) => setTimeout(r, 1_500));

      // the holder sees the pending request; deny leaves it queued
      const requests = runCli(wtC, ["share", "requests", "--json"]);
      expect(requests.stdout).toContain(projectOf(wtB));
      expect(runCli(wtC, ["share", "deny", "dmn-shared", "--json"]).code).toBe(0);
      expect(sharedFile().queue?.[0]).toMatchObject({ project: projectOf(wtB), denied: true });
      expect(sharedFile().holder?.project).toBe(projectOf(wtC));

      // allow hands over: the blocked CLI returns — that IS the notification
      expect(runCli(wtC, ["share", "allow", "dmn-shared", "--json"]).code).toBe(0);
      expect(await waiter.exited).toBe(0);
      expect(sharedFile().holder?.project).toBe(projectOf(wtB));

      // the switch was a hestiad route-table update: same connector pid
      expect(connectorPid()).toBe(connectorBefore);
      const got = await gatewayGet("dmn-shared.stub.test");
      expect(got.status).toBe(200);
      expect(JSON.parse(got.body).marker).toBe("B");
    },
    120_000,
  );

  test(
    "dead shared origins auto-release without restarting the connector",
    async () => {
      env.HESTIA_SWEEP_INTERVAL_MS = "500";
      expect(runCli(tmpRoot, ["daemon", "stop"]).code).toBe(0);
      expect(runCli(tmpRoot, ["daemon", "start"]).code).toBe(0);
      const projectB = projectOf(wtB);
      const projectC = projectOf(wtC);
      const connectorBefore = connectorPid();
      const waiter = Bun.spawn(
        ["bun", CLI, "claim", "dmn-shared", "--wait", "60", "--json"],
        { cwd: wtC, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
      );
      await new Promise((r) => setTimeout(r, 1_500));
      expect(sharedFile().queue?.[0]?.project).toBe(projectC);

      // web2 keeps wtB in the admission occupancy set, so this exercises the
      // dead-origin probe rather than the dead-stack fallback.
      process.kill(-procGroup(wtB, "web"), "SIGKILL");
      await waitForSharedHolder(projectC);
      expect(await waiter.exited).toBe(0);
      expect(sharedFile().holder?.project).not.toBe(projectB);
      expect(connectorPid()).toBe(connectorBefore);
      const back = await gatewayGet("dmn-shared.stub.test");
      expect(back.status).toBe(200);
      expect(JSON.parse(back.body).marker).toBe("C");

      // wtC's web2 keeps its slot occupied too; with no queue, the same dead-
      // origin path clears the holder and restores the unclaimed remedy.
      process.kill(-procGroup(wtC, "web"), "SIGKILL");
      await waitForSharedHolder(undefined);
      const unclaimed = await gatewayGet("dmn-shared.stub.test");
      expect(unclaimed.status).toBe(503);
      expect(unclaimed.body).toContain("hestia claim dmn-shared");
    },
    120_000,
  );
});
