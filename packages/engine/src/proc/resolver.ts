import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HestiaError } from "@hestia/core";

/**
 * Env resolution by argv composition, not integration: when the repo uses
 * varlock (.env.schema + a local binary), prefix the spawn with
 * `varlock run --no-redact-stdout --` — the repo's own dev pattern. varlock
 * resolves the schema env into the child while values already present in the
 * process env win (verified against varlock 1.1.0), so hestia's injected
 * PORT, HESTIA_* and --env overrides pass through untouched.
 */
export function detectVarlock(worktreeRoot: string, workingDirectory = worktreeRoot): string | null {
  const root = resolve(worktreeRoot);
  const cwd = resolve(workingDirectory);
  if (!existsSync(join(cwd, ".env.schema"))) return null;
  let directory = cwd;
  for (;;) {
    const bin = join(directory, "node_modules", ".bin", "varlock");
    if (existsSync(bin)) return bin;
    if (directory === root) return null;
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(root)) return null;
    directory = parent;
  }
}

export function wrapWithVarlock(bin: string, argv: string[]): string[] {
  return [bin, "run", "--no-redact-stdout", "--", ...argv];
}

export function requireVarlock(worktreeRoot: string, workingDirectory = worktreeRoot): string {
  const bin = detectVarlock(worktreeRoot, workingDirectory);
  if (bin === null) {
    throw new HestiaError(
      "varlock-missing",
      `--varlock requires ${join(workingDirectory, ".env.schema")} and a local ` +
        `node_modules/.bin/varlock between that directory and the worktree root`,
    );
  }
  return bin;
}
