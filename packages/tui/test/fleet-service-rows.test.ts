import { describe, expect, test } from "bun:test";
import type { FleetStackView } from "@hestia/core";
import {
  buildFleetServiceRows,
  ensureFleetServiceRowVisible,
  selectedFleetServiceRowIndex,
} from "../src/fleet-service-rows.ts";
import { fleetMouseScrollDelta } from "../src/fleet-scroll.ts";

const stack: FleetStackView = {
  project: "modem-alpha",
  repo: "modem",
  branch: "alpha",
  worktree: "/tmp/alpha",
  phase: "up",
  services: [
    {
      name: "web",
      backend: "proc",
      state: "healthy",
      endpoints: [
        { name: "direct", host: "127.0.0.1", port: 4100 },
        { name: "public", host: "127.0.0.1", port: 4100 },
      ],
    },
    { name: "worker", backend: "wrangler", state: "healthy" },
  ],
};

describe("Fleet service rows", () => {
  test("flattens workloads and endpoints in rendered order", () => {
    const rows = buildFleetServiceRows(stack);
    expect(rows.map((row) => `${row.kind}:${row.service.name}`)).toEqual([
      "workload:web", "endpoint:web", "endpoint:web", "workload:worker",
    ]);
    expect(selectedFleetServiceRowIndex(rows, "web", "public")).toBe(2);
    expect(selectedFleetServiceRowIndex(rows, "worker", undefined)).toBe(3);
  });

  test("keeps a selected row inside a bounded viewport", () => {
    expect(ensureFleetServiceRowVisible(0, 3, 2, 4)).toBe(2);
    expect(ensureFleetServiceRowVisible(2, 0, 2, 4)).toBe(0);
    expect(ensureFleetServiceRowVisible(99, -1, 2, 4)).toBe(2);
    expect(ensureFleetServiceRowVisible(2, -1, 2, 4)).toBe(2);
  });
});

describe("Fleet mouse scrolling", () => {
  test("uses OpenTUI scroll directions instead of legacy wheel buttons", () => {
    expect(fleetMouseScrollDelta({ scroll: { direction: "up", delta: 1 } })).toBe(-3);
    expect(fleetMouseScrollDelta({ scroll: { direction: "down", delta: 1 } })).toBe(3);
    expect(fleetMouseScrollDelta({ scroll: { direction: "left", delta: 1 } })).toBeUndefined();
  });
});
