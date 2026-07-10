import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const pexec = promisify(execFile);

export interface RepoInfo {
  repo: string;
  branch: string;
  worktreeRoot: string;
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
    if (!isAbsolute(commonDir)) commonDir = resolve(worktreeRoot, commonDir);
    // commonDir is ".../<repo>/.git" -> repo = basename(dirname(commonDir))
    const repo =
      basename(commonDir) === ".git"
        ? basename(dirname(commonDir))
        : basename(worktreeRoot);
    return { repo, branch, worktreeRoot };
  } catch {
    return { repo: basename(cwd), branch: "nobranch", worktreeRoot: cwd };
  }
}
