import { describe, expect, test } from "bun:test";
import { fleetCapacitySummary, resolveStatusNotice } from "../src/fleet-status.ts";

describe("fleet status line", () => {
  test("capacity summary includes queue depth only when someone waits", () => {
    expect(fleetCapacitySummary({ maxStacks: 5, live: 2, reserved: 0, queued: 0 }, true))
      .toBe("2/5 · daemon ok");
    expect(fleetCapacitySummary({ maxStacks: 5, live: 5, reserved: 1, queued: 2 }, true))
      .toBe("5/5 · 1 reserved · 2 queued · daemon ok");
    expect(fleetCapacitySummary({ maxStacks: 5, live: 2, reserved: 0, queued: 0 }, false))
      .toBe("daemon unreachable");
  });

  test("fresh toasts outrank the standing connection banner, which returns after expiry", () => {
    expect(resolveStatusNotice("disconnected: boom", "down failed: x")).toBe("down failed: x");
    expect(resolveStatusNotice("disconnected: boom", undefined)).toBe("disconnected: boom");
    expect(resolveStatusNotice(undefined, "copied url")).toBe("copied url");
    expect(resolveStatusNotice(undefined, undefined)).toBeUndefined();
  });
});
