import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalRegistryDir } from "../../packages/engine/src/index.ts";

// The wrangler isolation ship gate: two worktrees run the same two workers
// (worker-a service-binds worker-b). Without the private per-worktree dev
// registry, both worker-a's would resolve the binding through ONE global
// registry — whichever worktree registered "fixture-worker-b" last wins, and
// bindings silently cross-wire. This test proves each worktree's binding
// resolves within its own registry, and the global registry is untouched.
//
// Gated like the docker e2e: skips unless the fixture has wrangler installed
// (cd test/fixtures/wrangler-repo && bun install).

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "wrangler-repo");

const wranglerInstalled = existsSync(
  join(FIXTURE, "node_modules", ".bin", "wrangler"),
);
const suite = wranglerInstalled ? describe : describe.skip;
if (!wranglerInstalled) {
  console.warn(
    "[e2e] wrangler not installed in test/fixtures/wrangler-repo — skipping " +
      "(run `bun install` there to enable the isolation ship gate)",
  );
}

function runCli(cwd: string, args: string[]): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
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

async function fetchJson(
  port: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let tmpRoot: string;
let repoDir: string;
let wtA: string;
let wtB: string;

function setupWorktree(wt: string, marker: string): void {
  // the shared fixture install: hestia only requires <worktree>/node_modules/.bin
  symlinkSync(join(FIXTURE, "node_modules"), join(wt, "node_modules"));
  // per-worktree identity for worker-b, the way a dev would use .dev.vars
  writeFileSync(
    join(wt, "apps", "worker-b", ".dev.vars"),
    `MARKER=${marker}\n`,
  );
}

interface UpResult {
  project: string;
  env: Record<string, string>;
  services: Array<{ name: string; backend: string; state: string; publishedPort?: number }>;
}

suite("per-worktree wrangler dev-registry isolation", () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-wrangler-e2e-"));
    repoDir = join(tmpRoot, "wranglerrepo");
    cpSync(FIXTURE, repoDir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    wtA = join(tmpRoot, "wt-a");
    wtB = join(tmpRoot, "wt-b");
    git(repoDir, ["worktree", "add", "-q", "-b", "wr-a", wtA]);
    git(repoDir, ["worktree", "add", "-q", "-b", "wr-b", wtB]);
    setupWorktree(wtA, "A");
    setupWorktree(wtB, "B");
  });

  afterAll(() => {
    for (const wt of [wtA, wtB]) {
      if (wt && existsSync(wt)) runCli(wt, ["down"]);
    }
    // stop the daemon these runs may have auto-spawned (next real command
    // respawns a clean one — never leave one carrying test env)
    if (tmpRoot) runCli(tmpRoot, ["daemon", "stop"]);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test(
    "service bindings resolve within each worktree; global registry untouched",
    async () => {
      const globalBefore = new Set(
        existsSync(globalRegistryDir()) ? readdirSync(globalRegistryDir()) : [],
      );

      // 1. up both worktrees' full worker sets (varlock wrapper auto-detected
      //    from the fixture's .env.schema + local binary)
      const aOut = runCli(wtA, ["up", "--workers", "--json"]);
      expect(aOut.code).toBe(0);
      const a = JSON.parse(aOut.stdout) as UpResult;
      const bOut = runCli(wtB, ["up", "--workers", "--json"]);
      expect(bOut.code).toBe(0);
      const b = JSON.parse(bOut.stdout) as UpResult;

      const portOf = (r: UpResult, name: string) =>
        Number(r.env[`HESTIA_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PORT`]);
      const aA = portOf(a, "fixture-worker-a");
      const bA = portOf(b, "fixture-worker-a");
      expect(aA).toBeGreaterThan(0);
      expect(bA).toBeGreaterThan(0);
      expect(aA).not.toBe(bA);
      expect(portOf(a, "fixture-worker-b")).not.toBe(portOf(b, "fixture-worker-b"));

      // 2. THE isolation assertion: each worker-a's service binding reaches
      //    its own worktree's worker-b (cross-wired registries would flip one)
      const viaA = await fetchJson(aA, 15_000);
      const viaB = await fetchJson(bA, 15_000);
      expect(viaA?.viaBinding).toBe("A");
      expect(viaB?.viaBinding).toBe("B");

      // 3. both names registered privately, in each worktree
      for (const wt of [wtA, wtB]) {
        const names = readdirSync(join(wt, ".hestia", "wrangler-registry"));
        expect(names).toContain("fixture-worker-a");
        expect(names).toContain("fixture-worker-b");
      }

      // 4. the global registry gained none of our names
      const globalAfter = new Set(
        existsSync(globalRegistryDir()) ? readdirSync(globalRegistryDir()) : [],
      );
      for (const n of ["fixture-worker-a", "fixture-worker-b"]) {
        expect(globalAfter.has(n) && !globalBefore.has(n)).toBe(false);
      }

      // 5. teardown isolates: down A, B's binding still works
      expect(runCli(wtA, ["down"]).code).toBe(0);
      expect(await fetchJson(aA)).toBeNull();
      expect((await fetchJson(bA, 15_000))?.viaBinding).toBe("B");
    },
    600_000,
  );
});
