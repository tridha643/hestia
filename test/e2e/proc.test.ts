import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Host-process isolation end-to-end, NO docker required: two real git
// worktrees each `hestia run` the same fixture server; they get distinct
// ephemeral ports, teardown kills the whole process tree of one worktree
// while the other keeps serving, and `down --project` still works after the
// worktree directory itself is deleted (via the ~/.hestia mirror).

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "proc-repo");

function runCli(cwd: string, args: string[]): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
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

async function httpJson(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(3000),
    });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let tmpRoot: string;
let repoDir: string;
let wtA: string;
let wtB: string;

interface RunResult {
  project: string;
  env: Record<string, string>;
  services: Array<{ name: string; pid?: number; publishedPort?: number; state: string; logPath?: string }>;
}

describe("per-worktree proc isolation (hestia run)", () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-proc-e2e-"));
    repoDir = join(tmpRoot, "procrepo");
    cpSync(FIXTURE, repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    wtA = join(tmpRoot, "wt-a");
    wtB = join(tmpRoot, "wt-b");
    git(repoDir, ["worktree", "add", "-q", "-b", "proc-a", wtA]);
    git(repoDir, ["worktree", "add", "-q", "-b", "proc-b", wtB]);
  });

  afterAll(() => {
    for (const wt of [wtA, wtB]) {
      if (wt && existsSync(wt)) runCli(wt, ["down"]);
    }
    // mirror-based teardown for anything the direct downs missed
    for (const p of ["procrepo-proc-a", "procrepo-proc-b"]) {
      runCli(tmpRoot, ["down", "--project", p]);
    }
    // stop the daemon these runs may have auto-spawned (next real command
    // respawns a clean one — never leave one carrying test env)
    runCli(tmpRoot, ["daemon", "stop"]);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test(
    "two worktrees run isolated procs; teardown is pgid-wide and mirror-backed",
    async () => {
      // 1. run the same named proc in both worktrees (no compose file at all
      //    — procs-only stacks are legal)
      const runArgs = (marker: string) => [
        "run",
        "--name",
        "web",
        "--env",
        `WORKTREE_MARKER=${marker}`,
        "--json",
        "--",
        "bun",
        "server.ts",
      ];
      const aOut = runCli(wtA, runArgs("A"));
      expect(aOut.code).toBe(0);
      const a = JSON.parse(aOut.stdout) as RunResult;
      const b = JSON.parse(runCli(wtB, runArgs("B")).stdout) as RunResult;

      const portA = Number(a.env.HESTIA_WEB_PORT);
      const portB = Number(b.env.HESTIA_WEB_PORT);
      expect(portA).toBeGreaterThan(0);
      expect(portB).toBeGreaterThan(0);
      expect(portA).not.toBe(portB);

      // 2. both serve, with their own identity and env
      const bodyA = await httpJson(portA);
      const bodyB = await httpJson(portB);
      expect(bodyA?.marker).toBe("A");
      expect(bodyB?.marker).toBe("B");
      const childA = Number(bodyA?.childPid);
      expect(alive(childA)).toBe(true);

      // 3. re-run with the identical command is a no-op (same pid)
      const again = JSON.parse(runCli(wtA, runArgs("A")).stdout) as RunResult;
      expect(again.services.find((s) => s.name === "web")?.pid).toBe(
        a.services.find((s) => s.name === "web")?.pid,
      );

      // 4. re-run with a DIFFERENT command replaces (new pid, port re-probed)
      const replaced = JSON.parse(
        runCli(wtA, runArgs("A-replaced")).stdout,
      ) as RunResult;
      const replacedSvc = replaced.services.find((s) => s.name === "web");
      expect(replacedSvc?.pid).not.toBe(a.services.find((s) => s.name === "web")?.pid);
      const portA2 = Number(replaced.env.HESTIA_WEB_PORT);
      expect((await httpJson(portA2))?.marker).toBe("A-replaced");
      expect(alive(childA)).toBe(false); // old tree died with its group

      // 5. status reflects a healthy proc
      const status = JSON.parse(runCli(wtA, ["status", "--json"]).stdout);
      expect(status.services.find((s: { name: string }) => s.name === "web").state).toBe("healthy");

      // 6. crash surfaces as proc-exited with a log pointer
      const crash = runCli(wtA, [
        "run", "--name", "crasher", "--json", "--",
        "bun", "-e", "console.error('kaboom'); process.exit(2);",
      ]);
      expect(crash.code).toBe(1);
      expect(crash.stdout).toContain("proc-exited");

      // 7. if local state disappears, project teardown falls back to the
      //    surviving mirror instead of orphaning A's live process tree.
      rmSync(join(wtA, ".hestia"), { recursive: true, force: true });
      expect(runCli(tmpRoot, ["down", "--project", a.project]).code).toBe(0);
      expect(await httpJson(portA2)).toBeNull();
      expect((await httpJson(portB))?.marker).toBe("B");

      // 8. delete worktree B entirely — `down --project` works from the mirror
      const bPid = b.services.find((s) => s.name === "web")!.pid!;
      git(repoDir, ["worktree", "remove", "--force", wtB]);
      expect(existsSync(wtB)).toBe(false);
      expect(alive(bPid)).toBe(true); // proc outlived its worktree
      const downB = runCli(tmpRoot, ["down", "--project", b.project]);
      expect(downB.code).toBe(0);
      expect(alive(bPid)).toBe(false);
      expect(await httpJson(portB)).toBeNull();
      expect(existsSync(join(homedir(), ".hestia", "stacks", b.project))).toBe(false);
    },
    120_000,
  );

  test(
    "concurrent runs in one worktree serialize on the stack lock",
    async () => {
      const wt = join(tmpRoot, "wt-c");
      git(repoDir, ["worktree", "add", "-q", "-b", "proc-c", wt]);
      const spawnRun = (name: string) =>
        new Promise<{ code: number; stdout: string }>((resolve) => {
          const child = Bun.spawn(
            ["bun", CLI, "run", "--name", name, "--json", "--", "bun", "server.ts"],
            { cwd: wt, stdout: "pipe", stderr: "pipe" },
          );
          child.exited.then(async (code) =>
            resolve({ code, stdout: await new Response(child.stdout).text() }),
          );
        });
      const [r1, r2] = await Promise.all([spawnRun("one"), spawnRun("two")]);
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      // both procs recorded — no lost update on stack.json
      const status = JSON.parse(runCli(wt, ["status", "--json"]).stdout);
      const names = status.services.map((s: { name: string }) => s.name).sort();
      expect(names).toEqual(["one", "two"]);
      expect(runCli(wt, ["down"]).code).toBe(0);
    },
    120_000,
  );
});
