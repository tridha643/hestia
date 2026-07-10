import { existsSync } from "node:fs";
import { join } from "node:path";
import { HestiaError } from "@hestia/core";

/**
 * Env resolution by argv composition, not integration: when the repo uses
 * varlock (.env.schema + a local binary), prefix the spawn with
 * `varlock run --no-redact-stdout --` — the repo's own dev pattern. varlock
 * resolves the schema env into the child while values already present in the
 * process env win (verified against varlock 1.1.0), so hestia's injected
 * PORT, HESTIA_* and --env overrides pass through untouched.
 */
export function detectVarlock(worktreeRoot: string): string | null {
  const schema = join(worktreeRoot, ".env.schema");
  const bin = join(worktreeRoot, "node_modules", ".bin", "varlock");
  return existsSync(schema) && existsSync(bin) ? bin : null;
}

export function wrapWithVarlock(bin: string, argv: string[]): string[] {
  return [bin, "run", "--no-redact-stdout", "--", ...argv];
}

export function requireVarlock(worktreeRoot: string): string {
  const bin = detectVarlock(worktreeRoot);
  if (bin === null) {
    throw new HestiaError(
      "varlock-missing",
      `--varlock requires both ${join(worktreeRoot, ".env.schema")} and a local ` +
        `node_modules/.bin/varlock in the worktree`,
    );
  }
  return bin;
}
