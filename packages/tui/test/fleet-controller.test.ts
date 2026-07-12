import { describe, expect, test } from "bun:test";
import type { FleetSnapshot, RepoId } from "@hestia/core";
import {
  createFleetUiState,
  reconcileFleetSelection,
  reduceFleetUiState,
  visibleFleetStacks,
} from "../src/fleet-controller.ts";
import { sanitizeFleetTerminalText } from "../src/terminal-text.ts";

const repoId = "repo-1234567890abcdef" as RepoId;
const snapshot: FleetSnapshot = {
  repoId,
  observedAt: new Date(0).toISOString(),
  capacity: { maxStacks: 5, live: 2, reserved: 0, queued: 0 },
  shared: [],
  warnings: [],
  stacks: [
    {
      project: "modem-alpha",
      repoId,
      repo: "modem",
      branch: "alpha",
      worktree: "/tmp/alpha",
      phase: "up",
      services: [{ name: "dashboard", backend: "proc", state: "healthy" }],
    },
    {
      project: "modem-beta",
      repoId,
      repo: "modem",
      branch: "beta",
      worktree: "/tmp/beta",
      phase: "degraded",
      services: [{ name: "ingest", backend: "wrangler", state: "unhealthy" }],
    },
  ],
};

describe("Fleet selection reducer", () => {
  test("prefers the invoking project and clamps a removed selection", () => {
    expect(reconcileFleetSelection({}, snapshot, "modem-beta")).toEqual({
      project: "modem-beta",
      service: "ingest",
    });
    const withoutBeta = { ...snapshot, stacks: snapshot.stacks.slice(0, 1) };
    expect(reconcileFleetSelection({ project: "modem-beta", service: "ingest" }, withoutBeta))
      .toEqual({ project: "modem-alpha", service: "dashboard" });
  });

  test("moves stable stack/service IDs and preserves a paused log viewport", () => {
    let state = reduceFleetUiState(createFleetUiState(), {
      type: "reconcile",
      snapshot,
      preferredProject: "modem-alpha",
    });
    state = reduceFleetUiState(state, { type: "move-stack", delta: 1, snapshot });
    expect(state.selection).toEqual({ project: "modem-beta", service: "ingest" });
    state = reduceFleetUiState(state, { type: "scroll-logs", delta: -1 });
    state = reduceFleetUiState(state, { type: "new-lines", count: 3 });
    expect(state.follow).toBe(false);
    expect(state.logOffset).toBe(4);
    expect(state.unseenLines).toBe(3);
    state = reduceFleetUiState(state, { type: "follow", follow: true });
    expect(state.logOffset).toBe(0);
    expect(state.unseenLines).toBe(0);
  });

  test("filters only the daemon-projected managed rows", () => {
    expect(visibleFleetStacks(snapshot, "ingest").map((stack) => stack.project))
      .toEqual(["modem-beta"]);
  });

  test("selects exact stack and service IDs for mouse interactions", () => {
    const alphaWithTwoServices = {
      ...snapshot.stacks[0]!,
      services: [
        ...snapshot.stacks[0]!.services,
        { name: "postgres", backend: "docker" as const, state: "healthy" as const },
      ],
    };
    const mouseSnapshot = { ...snapshot, stacks: [alphaWithTwoServices, snapshot.stacks[1]!] };
    let state = reduceFleetUiState(createFleetUiState(), {
      type: "select-stack",
      project: "modem-beta",
      snapshot: mouseSnapshot,
    });
    expect(state.selection).toEqual({ project: "modem-beta", service: "ingest" });
    expect(state.focus).toBe("stacks");
    state = reduceFleetUiState(state, {
      type: "select-stack",
      project: "modem-alpha",
      snapshot: mouseSnapshot,
    });
    state = reduceFleetUiState(state, {
      type: "select-service",
      service: "postgres",
      snapshot: mouseSnapshot,
    });
    expect(state.selection).toEqual({ project: "modem-alpha", service: "postgres" });
    expect(state.focus).toBe("services");
  });

  test("pins a down confirmation independently of snapshot reconciliation", () => {
    let state = reduceFleetUiState(createFleetUiState(), {
      type: "confirm-down",
      stack: snapshot.stacks[0],
    });
    state = reduceFleetUiState(state, {
      type: "reconcile",
      snapshot: { ...snapshot, stacks: snapshot.stacks.slice(1) },
    });
    expect(state.selection.project).toBe("modem-beta");
    expect(state.confirmDown?.project).toBe("modem-alpha");
  });
});

describe("shared hostname overlay reducer", () => {
  test("open resets selection to 0; close preserves it", () => {
    let state = createFleetUiState();
    state = reduceFleetUiState(state, { type: "move-shared", delta: 2, count: 5 });
    expect(state.sharedSelection).toBe(2);
    state = reduceFleetUiState(state, { type: "shared", open: true });
    expect(state.sharedOpen).toBeTrue();
    expect(state.sharedSelection).toBe(0);
    state = reduceFleetUiState(state, { type: "move-shared", delta: 1, count: 3 });
    state = reduceFleetUiState(state, { type: "shared", open: false });
    expect(state.sharedOpen).toBeFalse();
    expect(state.sharedSelection).toBe(1);
  });

  test("move-shared clamps within [0, count-1] and handles an empty list", () => {
    let state = createFleetUiState();
    state = reduceFleetUiState(state, { type: "move-shared", delta: -5, count: 3 });
    expect(state.sharedSelection).toBe(0);
    state = reduceFleetUiState(state, { type: "move-shared", delta: 99, count: 3 });
    expect(state.sharedSelection).toBe(2);
    state = reduceFleetUiState(state, { type: "move-shared", delta: 1, count: 0 });
    expect(state.sharedSelection).toBe(0);
  });
});

describe("terminal text sanitization", () => {
  test("removes OSC52, CSI, DCS, carriage return, and backspace controls", () => {
    const malicious = "safe\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1bPpayload\x1b\\\rX\bY";
    const sanitized = sanitizeFleetTerminalText(malicious);
    expect(sanitized).toBe("safeXY");
    expect(sanitized).not.toContain("\x1b");
  });
});
