import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../../packages/engine/src/index.ts";

// The single interface: zero-config. NO hestia.yml anywhere. `hestia up` reads
// the repo's compose file, publishes ephemeral ports, and returns each service's
// port as HESTIA_<SVC>_PORT + endpoints[]; the caller wires its own URL.

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "repo");

const hasDocker = await dockerAvailable();
const suite = hasDocker ? describe : describe.skip;
if (!hasDocker) {
  console.warn("[e2e] docker not available — skipping isolation integration test");
}

interface UpResult {
  project: string;
  state: string;
  env: Record<string, string>;
  endpoints: Array<{ name: string; host: string; port: number }>;
}

function runCli(cwd: string, args: string[]): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function upJson(cwd: string): UpResult {
  const { code, stdout } = runCli(cwd, ["up", "--json"]);
  if (code !== 0) throw new Error(`hestia up failed in ${cwd}: ${stdout}`);
  return JSON.parse(stdout) as UpResult;
}

function tcpOpens(port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

let tmpRoot: string;
let repoDir: string;
let wtA: string;
let wtB: string;

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

suite("per-worktree compose isolation (zero-config)", () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-e2e-"));
    repoDir = join(tmpRoot, "myrepo");
    cpSync(FIXTURE, repoDir, { recursive: true }); // compose file only, no hestia.yml
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    wtA = join(tmpRoot, "wt-a");
    wtB = join(tmpRoot, "wt-b");
    git(repoDir, ["worktree", "add", "-q", "-b", "branch-a", wtA]);
    git(repoDir, ["worktree", "add", "-q", "-b", "branch-b", wtB]);
  });

  afterAll(() => {
    for (const wt of [wtA, wtB]) if (wt) runCli(wt, ["down", "--destroy"]);
    // stop the daemon these runs may have auto-spawned (next real command
    // respawns a clean one — never leave one carrying test env)
    if (tmpRoot) runCli(tmpRoot, ["daemon", "stop"]);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test(
    "two worktrees get isolated stacks on distinct ephemeral ports",
    async () => {
      // 1. up A — inferred service, ephemeral port surfaced + connectable.
      const a = upJson(wtA);
      expect(a.state).toBe("up");
      expect(a.project).toBe("myrepo-branch-a");
      const portA = Number(a.env.HESTIA_DB_PORT);
      expect(portA).toBeGreaterThan(0);
      expect(portA).not.toBe(54329); // the pinned host port was replaced
      expect(a.endpoints.find((e) => e.name === "db")?.port).toBe(portA);
      // caller wires its own URL from the returned port (what an agent does).
      const urlA = `postgresql://postgres:postgres@127.0.0.1:${portA}/app`;
      expect(urlA).toContain(String(portA));
      expect(await tcpOpens(portA)).toBe(true);

      // 2. up B — a second, distinct stack.
      const b = upJson(wtB);
      expect(b.project).toBe("myrepo-branch-b");
      const portB = Number(b.env.HESTIA_DB_PORT);
      expect(portB).not.toBe(portA);
      expect(await tcpOpens(portB)).toBe(true);

      // 3. status shows each worktree its own stack only.
      const statusA = JSON.parse(runCli(wtA, ["status", "--json"]).stdout);
      expect(statusA.project).toBe("myrepo-branch-a");

      // 4. down A removes A but leaves B up and still connectable.
      expect(runCli(wtA, ["down"]).code).toBe(0);
      expect(await tcpOpens(portA)).toBe(false);
      expect(await tcpOpens(portB)).toBe(true);
      expect(runCli(wtA, ["status", "--json"]).stdout.trim()).toBe("null");
    },
    240_000,
  );
});
