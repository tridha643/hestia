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

function shortHash(worktreePath: string, branch: string): string {
  return createHash("sha256")
    .update(`${worktreePath}\0${branch}`)
    .digest("hex")
    .slice(0, 6);
}

/**
 * Deterministic compose project name = slug(repo)-slug(branch), each length
 * capped. If either side had to be truncated the result is ambiguous, so we
 * append a 6-hex hash of (worktreePath, branch) to keep it collision-free and
 * stable across re-`up` of the same worktree.
 */
export function projectName(
  repo: string,
  branch: string,
  worktreePath: string,
): string {
  const repoFull = slug(repo);
  const branchFull = slug(branch);
  const repoPart = repoFull.slice(0, REPO_MAX);
  const branchPart = branchFull.slice(0, BRANCH_MAX);
  const truncated = repoPart !== repoFull || branchPart !== branchFull;
  const base = `${repoPart}-${branchPart}`;
  return truncated ? `${base}-${shortHash(worktreePath, branch)}` : base;
}

export const LABELS = {
  stack: "dev.hestia.stack",
  repo: "dev.hestia.repo",
  branch: "dev.hestia.branch",
  worktree: "dev.hestia.worktree",
} as const;
