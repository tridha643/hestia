import { createHash } from "node:crypto";

const REPO_MAX = 20;
const BRANCH_MAX = 30;

/**
 * Lowercase, collapse any run of non-[a-z0-9] to a single "-", trim "-", and
 * guarantee a leading alphanumeric (compose project + DNS label requirement).
 * `feat/foo_bar` -> `feat-foo-bar`.
 */
export function slug(input: string): string {
  let s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s === "" || !/^[a-z0-9]/.test(s)) s = `x${s}`;
  return s;
}

function routeHash(worktreePath: string, branch: string): string {
  return createHash("sha256")
    .update(`${worktreePath}\0${branch}`)
    .digest("hex")
    .slice(0, 6);
}

function dnsServiceLabel(service: string): string {
  const full = slug(service);
  if (full.length <= 50) return full;
  const hash = createHash("sha256").update(service).digest("hex").slice(0, 6);
  return `${full.slice(0, 43)}-${hash}`;
}

/** Build collision-safe service, branch, and repository labels for local URLs. */
export function localRouteLabels(
  service: string,
  repo: string,
  branch: string,
  worktreePath: string,
): { service: string; branch: string; repo: string } {
  const repoFull = slug(repo);
  const branchFull = slug(branch);
  const repoLabel = repoFull.slice(0, REPO_MAX);
  let branchLabel = branchFull.slice(0, BRANCH_MAX);
  if (repoLabel !== repoFull || branchLabel !== branchFull) {
    branchLabel = `${branchLabel}-${routeHash(worktreePath, branch)}`;
  }
  return { service: dnsServiceLabel(service), branch: branchLabel, repo: repoLabel };
}

/**
 * Collision-safe compose project identity. The readable prefix is bounded,
 * while the hash always covers the exact repository identity, branch, and
 * canonical worktree path. Always hashing is intentional: distinct clones,
 * normalized branch slugs, and short names must not collide either.
 */
export function projectName(
  repoId: string,
  repo: string,
  branch: string,
  worktreePath: string,
): string {
  const repoFull = slug(repo);
  const branchFull = slug(branch);
  const repoPart = repoFull.slice(0, REPO_MAX);
  const branchPart = branchFull.slice(0, BRANCH_MAX);
  const hash = createHash("sha256")
    .update(repoId)
    .update("\0")
    .update(branch)
    .update("\0")
    .update(worktreePath)
    .digest("hex")
    .slice(0, 10);
  return `${repoPart}-${branchPart}-${hash}`;
}

export const LABELS = {
  stack: "dev.hestia.stack",
  repo: "dev.hestia.repo",
  branch: "dev.hestia.branch",
  worktree: "dev.hestia.worktree",
} as const;
