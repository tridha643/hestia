import { describe, expect, test } from "bun:test";
import type { LogLine } from "@hestia/core";
import { ReconnectLogDeduper } from "../src/log-reconnect-deduper.ts";

function line(text: string): LogLine {
  return { project: "modem-alpha", service: "dashboard", source: "proc", text };
}

function texts(lines: LogLine[]): string[] {
  return lines.map((candidate) => candidate.text);
}

describe("ReconnectLogDeduper", () => {
  test("suppresses a complete reconnect backfill and emits the first new line", () => {
    const deduper = new ReconnectLogDeduper();
    expect(texts(deduper.push(line("a")))).toEqual(["a"]);
    expect(texts(deduper.push(line("b")))).toEqual(["b"]);
    deduper.beginReconnect();
    expect(deduper.push(line("a"))).toEqual([]);
    expect(deduper.push(line("b"))).toEqual([]);
    expect(texts(deduper.push(line("c")))).toEqual(["c"]);
  });

  test("finds a shifted suffix and keeps lines written during disconnection", () => {
    const deduper = new ReconnectLogDeduper();
    for (const text of ["a", "b", "c"]) deduper.push(line(text));
    deduper.beginReconnect();
    expect(deduper.push(line("b"))).toEqual([]);
    expect(deduper.push(line("c"))).toEqual([]);
    expect(texts(deduper.push(line("d")))).toEqual(["d"]);
  });

  test("handles identical adjacent lines without replaying either copy", () => {
    const deduper = new ReconnectLogDeduper();
    deduper.push(line("same"));
    deduper.push(line("same"));
    deduper.beginReconnect();
    expect(deduper.push(line("same"))).toEqual([]);
    expect(deduper.push(line("same"))).toEqual([]);
    expect(texts(deduper.push(line("new")))).toEqual(["new"]);
  });

  test("passes through a reconnect stream with no overlap", () => {
    const deduper = new ReconnectLogDeduper();
    deduper.push(line("old"));
    deduper.beginReconnect();
    expect(texts(deduper.push(line("unrelated")))).toEqual(["unrelated"]);
  });
});
