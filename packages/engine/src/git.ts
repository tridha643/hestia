import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { RepoId } from "@hestia/core";

const pexec = promisify(execFile);

export interface RepoInfo {
  repo: string;
  repoId: RepoId;
  branch: string;
  worktreeRoot: string;
}

/** Hash a canonical git common directory into the stable repository ID used by Fleet. */
export function createRepoId(commonDirectory: string): RepoId {
  let canonical = resolve(commonDirectory);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // Non-git fallback paths may not exist yet; the resolved path is still stable.
  }
  return `repo-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}` as RepoId;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, timeout: 10_000 });
  return stdout.trim();
}

/**
 * Resolve (repo, branch, worktreeRoot) for a worktree. `repo` is derived from
 * the *common* git dir so every worktree of one repo shares a repo name; only
 * the branch differs. Falls back to the directory name if not a git repo.
 */
export async function getRepoInfo(cwd: string): Promise<RepoInfo> {
  try {
    const worktreeRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
    let branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD" || branch === "") {
      // detached — use the short SHA so the name is still stable & unique
      branch = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    }
    let commonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
    // Git reports --git-common-dir relative to the caller's cwd, not relative
    // to the worktree root. Resolving against cwd keeps nested invocations on
    // the same repository identity as root-level invocations.
    if (!isAbsolute(commonDir)) commonDir = resolve(cwd, commonDir);
    // commonDir is ".../<repo>/.git" -> repo = basename(dirname(commonDir))
    const repo =
      basename(commonDir) === ".git"
        ? basename(dirname(commonDir))
        : basename(worktreeRoot);
    return { repo, repoId: createRepoId(commonDir), branch, worktreeRoot };
  } catch {
    const worktreeRoot = resolve(cwd);
    return {
      repo: basename(worktreeRoot),
      repoId: createRepoId(worktreeRoot),
      branch: "nobranch",
      worktreeRoot,
    };
  }
}
