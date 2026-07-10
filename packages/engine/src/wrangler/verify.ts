import { existsSync, readdirSync } from "node:fs";
import { HestiaError } from "@hestia/core";
import { globalRegistryDir } from "./adapter.ts";

function namesIn(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir));
}

export function snapshotGlobalRegistry(): Set<string> {
  return namesIn(globalRegistryDir());
}

/**
 * The isolation assertion: every worker we started must appear in the PRIVATE
 * registry — that proves the redirect env vars took effect in the child. If a
 * name never shows up there, the worker registered somewhere else (or the
 * wrangler version stopped honoring the env var): a real leak, fail hard.
 */
export async function verifyPrivateRegistry(
  privateDir: string,
  workerNames: string[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let missing: string[] = workerNames;
  while (Date.now() < deadline) {
    const present = namesIn(privateDir);
    missing = workerNames.filter((n) => !present.has(n));
    if (missing.length === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new HestiaError(
    "registry-leak",
    `worker(s) ${missing.join(", ")} never registered in the private registry ` +
      `(${privateDir}) — the WRANGLER_REGISTRY_PATH/MINIFLARE_REGISTRY_PATH ` +
      `redirect did not take effect`,
  );
}

/**
 * Advisory only: a global-registry gain of one of our names DURING our up is
 * probably a manual session in another worktree of the same repo (same repo →
 * same worker names). Entries carry no pid, so it cannot be attributed —
 * never fail on it, just surface it.
 */
export function globalGainWarnings(
  before: Set<string>,
  ourNames: string[],
): string[] {
  const after = snapshotGlobalRegistry();
  return ourNames
    .filter((n) => after.has(n) && !before.has(n))
    .map(
      (n) =>
        `global dev registry gained "${n}" while this stack started — ` +
        `likely a non-hestia dev session in another worktree; hestia's own ` +
        `workers are isolated in the private registry`,
    );
}
