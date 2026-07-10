import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackRecord } from "@hestia/core";
import { readLastLines, streamStackLogs, tailFile } from "../src/index.ts";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "hestia-logs-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

async function nextWithin<T>(iterator: AsyncIterator<T>, timeoutMs = 2_000): Promise<IteratorResult<T>> {
  return Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for log event")), timeoutMs),
    ),
  ]);
}

describe("readLastLines", () => {
  test("handles short, exact, unterminated, and empty files", () => {
    const dir = scratch();
    const path = join(dir, "app.log");
    writeFileSync(path, "one\ntwo\nthree\n");
    expect(readLastLines(path, 2)).toEqual(["two", "three"]);
    expect(readLastLines(path, 20)).toEqual(["one", "two", "three"]);
    writeFileSync(path, "one\ntwo");
    expect(readLastLines(path, 1)).toEqual(["two"]);
    writeFileSync(path, "");
    expect(readLastLines(path, 5)).toEqual([]);
  });
});

describe("tailFile", () => {
  test("emits complete backfill before lines appended during backfill consumption", async () => {
    const path = join(scratch(), "ordered.log");
    writeFileSync(path, "old-1\nold-2\n");
    const iterator = tailFile(path, { follow: true, tail: 2 });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "old-1" });
    appendFileSync(path, "live\n");
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "old-2" });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "live" });
    await iterator.return(undefined);
  });

  test("buffers partial lines until newline while following", async () => {
    const path = join(scratch(), "partial.log");
    writeFileSync(path, "complete\npart");
    const iterator = tailFile(path, { follow: true, tail: 2 });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "complete" });
    appendFileSync(path, "ial\n");
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "partial" });
    await iterator.return(undefined);
  });

  test("detects shrink resets without replaying old backfill", async () => {
    const path = join(scratch(), "reset.log");
    writeFileSync(path, "old-1\nold-2\nold-3\n");
    const iterator = tailFile(path, { follow: true, tail: 2 });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "old-2" });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "old-3" });
    writeFileSync(path, "new\n");
    expect((await nextWithin(iterator)).value).toEqual({ kind: "reset" });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "new" });
    await iterator.return(undefined);
  });

  test("detects inode replacement and deletion", async () => {
    const dir = scratch();
    const path = join(dir, "rotated.log");
    writeFileSync(path, "old\n");
    const iterator = tailFile(path, { follow: true, tail: 1 });
    await nextWithin(iterator);
    renameSync(path, join(dir, "old.log"));
    writeFileSync(path, "replacement\n");
    expect((await nextWithin(iterator)).value).toEqual({ kind: "reset" });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "replacement" });
    rmSync(path);
    expect((await nextWithin(iterator)).value).toEqual({ kind: "gone" });
    expect((await nextWithin(iterator)).done).toBe(true);
  });

  test("waits for a file created after following begins and aborts promptly", async () => {
    const path = join(scratch(), "late.log");
    const controller = new AbortController();
    const iterator = tailFile(path, { follow: true, signal: controller.signal });
    expect((await nextWithin(iterator)).value).toEqual({ kind: "absent" });
    writeFileSync(path, "arrived\n");
    expect((await nextWithin(iterator)).value).toEqual({ kind: "line", text: "arrived" });
    controller.abort();
    expect((await nextWithin(iterator)).done).toBe(true);
  });
});

function stackWithLogs(paths: string[]): StackRecord {
  return {
    project: "fixture-logs",
    repo: "fixture",
    branch: "logs",
    worktree: "/tmp/fixture",
    state: "up",
    services: paths.map((logPath, index) => ({
      name: `proc-${index + 1}`,
      backend: "proc" as const,
      state: "healthy" as const,
      logPath,
    })),
    env: {},
    endpoints: [],
    createdAt: new Date(0).toISOString(),
  };
}

describe("streamStackLogs", () => {
  test("merges selected file sources and degrades missing files to metadata", async () => {
    const dir = scratch();
    const first = join(dir, "first.log");
    writeFileSync(first, "hello\n");
    const lines = [];
    for await (const line of streamStackLogs(stackWithLogs([first, join(dir, "missing.log")]), {
      tail: 5,
    })) lines.push(line);
    expect(lines).toContainEqual({
      project: "fixture-logs",
      service: "proc-1",
      source: "proc",
      text: "hello",
    });
    expect(lines.find((line) => line.service === "proc-2" && line.meta)?.text).toBe(
      "log file unavailable",
    );
  });

  test("rejects an unknown service before starting any source", async () => {
    const stream = streamStackLogs(stackWithLogs([join(scratch(), "missing.log")]), {
      services: ["unknown"],
    });
    await expect(stream.next()).rejects.toMatchObject({ code: "service-not-found" });
  });

  test("an already-aborted signal ends before starting log sources", async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = streamStackLogs(stackWithLogs([join(scratch(), "missing.log")]), {
      follow: true,
      signal: controller.signal,
    });
    expect((await stream.next()).done).toBe(true);
  });
});
