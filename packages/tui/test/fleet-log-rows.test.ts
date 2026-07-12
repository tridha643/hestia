import { describe, expect, test } from "bun:test";
import type { LogLine } from "@hestia/core";
import { buildFleetLogRows } from "../src/fleet-log-rows.ts";

function line(text: string, meta = false): LogLine {
  return { project: "p", service: "api", source: "proc", text, meta };
}

describe("buildFleetLogRows", () => {
  test("wraps to the pane width and keys rows stably across ring eviction", () => {
    const first = line("abcdefgh");
    const second = line("zz");
    const rows = buildFleetLogRows([first, second], 4);
    expect(rows.map((row) => row.text)).toEqual(["abcd", "efgh", "zz"]);
    // Same line object keeps its key after the ring evicts earlier lines.
    const evicted = buildFleetLogRows([second], 4);
    expect(evicted[0]!.key).toBe(rows[2]!.key);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  test("tags hestia meta lines and pads their continuation rows", () => {
    const rows = buildFleetLogRows([line("restarted because the port was stolen", true)], 24);
    expect(rows[0]!.tag).toBe("hestia │ ");
    expect(rows[0]!.meta).toBeTrue();
    expect(rows[1]!.tag).toBe(" ".repeat("hestia │ ".length));
    const plain = buildFleetLogRows([line("ready")], 24);
    expect(plain[0]!.tag).toBeUndefined();
  });
});
