import {
  closeSync,
  openSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";

const BACKFILL_CHUNK_BYTES = 64 * 1024;
const LOG_POLL_MS = 200;

export type TailEvent =
  | { kind: "line"; text: string }
  | { kind: "reset" }
  | { kind: "gone" }
  | { kind: "absent" };

export interface TailFileOptions {
  follow?: boolean;
  tail?: number;
  signal?: AbortSignal;
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readLastLinesBeforeOffset(path: string, count: number, endOffset: number): string[] {
  if (count <= 0 || endOffset <= 0) return [];
  const fd = openSync(path, "r");
  try {
    let cursor = endOffset;
    let bytes = Buffer.alloc(0);
    let newlineCount = 0;
    while (cursor > 0 && newlineCount <= count) {
      const length = Math.min(BACKFILL_CHUNK_BYTES, cursor);
      cursor -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, cursor);
      const actual = chunk.subarray(0, read);
      newlineCount += actual.reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0);
      bytes = Buffer.concat([actual, bytes]);
    }
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** Read the last complete or unterminated lines from a file in backward chunks. */
export function readLastLines(path: string, count: number): string[] {
  const stat = statOrNull(path);
  if (stat === null) return [];
  return readLastLinesBeforeOffset(path, count, stat.size);
}

function waitForLogPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, LOG_POLL_MS);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}

/** Tail one proc log with ordered backfill, reset detection, and polling cancellation. */
export async function* tailFile(
  path: string,
  options: TailFileOptions = {},
): AsyncGenerator<TailEvent> {
  const follow = options.follow ?? false;
  const tail = Math.max(0, options.tail ?? 50);
  let identity = statOrNull(path);
  let existed = identity !== null;
  let offset = identity?.size ?? 0;
  let pending = "";

  if (identity === null) {
    yield { kind: "absent" };
    if (!follow) return;
  } else {
    // Snapshot the forward cursor first. Backfill can then finish completely
    // before follow reads anything appended after this point.
    const backfill = readLastLinesBeforeOffset(path, tail, offset);
    if (follow && offset > 0) {
      const fd = openSync(path, "r");
      try {
        const lastByte = Buffer.allocUnsafe(1);
        readSync(fd, lastByte, 0, 1, offset - 1);
        if (lastByte[0] !== 10) pending = backfill.pop() ?? "";
      } finally {
        closeSync(fd);
      }
    }
    for (const text of backfill) {
      yield { kind: "line", text };
    }
    if (!follow) return;
  }

  while (!options.signal?.aborted) {
    const current = statOrNull(path);
    if (current === null) {
      if (existed) {
        if (pending !== "") yield { kind: "line", text: pending };
        yield { kind: "gone" };
        return;
      }
      await waitForLogPoll(options.signal);
      continue;
    }

    if (identity === null) {
      identity = current;
      existed = true;
      offset = 0;
    } else if (!sameFile(identity, current) || current.size < offset) {
      identity = current;
      offset = 0;
      pending = "";
      yield { kind: "reset" };
    }

    if (current.size > offset) {
      const length = current.size - offset;
      const fd = openSync(path, "r");
      try {
        const chunk = Buffer.allocUnsafe(length);
        const read = readSync(fd, chunk, 0, length, offset);
        offset += read;
        pending += chunk.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const text of lines) yield { kind: "line", text };
    }
    await waitForLogPoll(options.signal);
  }
}
