import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HestiaError } from "@hestia/core";
import { isLive, startTimeOf } from "./pidfile.ts";

/**
 * Advisory per-worktree mutation lock. Parallel agents in one worktree are the
 * product premise; unserialized read-modify-write of stack.json loses records.
 * Held across every state-mutating command (up/run/stop/down).
 */

const RETRY_MS = 100;

function lockPath(worktreeRoot: string): string {
  return join(worktreeRoot, ".hestia", "lock");
}

export async function withLock<T>(
  worktreeRoot: string,
  fn: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const path = lockPath(worktreeRoot);
  const privateDirectory = join(worktreeRoot, ".hestia");
  mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(privateDirectory, 0o700);
  const me = JSON.stringify({
    pid: process.pid,
    startTime: startTimeOf(process.pid),
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(path, me, { flag: "wx", mode: 0o600 });
      break;
    } catch {
      // Held — break it if the holder is dead (crashed CLI), else wait.
      try {
        const holder = JSON.parse(readFileSync(path, "utf8")) as {
          pid: number;
          startTime: string;
        };
        if (!isLive(holder)) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        // unreadable/corrupt lock — treat as stale
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new HestiaError(
          "lock-timeout",
          `could not acquire ${path} within ${Math.round(timeoutMs / 1000)}s`,
        );
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
