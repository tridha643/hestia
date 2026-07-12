import { describe, expect, test } from "bun:test";
import { compareVersions } from "../src/index.ts";

describe("compareVersions", () => {
  test("orders release versions by numeric component", () => {
    expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.2")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
  });

  test("tolerates differing component counts", () => {
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    expect(compareVersions("1.1.1", "1.1")).toBeGreaterThan(0);
  });

  test("treats a pre-release as older than the same release", () => {
    expect(compareVersions("1.0.1-rc.1", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.0.1", "1.0.1-rc.1")).toBeGreaterThan(0);
    // a newer pre-release core still beats an older release
    expect(compareVersions("1.1.0-rc.1", "1.0.9")).toBeGreaterThan(0);
  });

  test("an upgrade is only available when latest strictly exceeds current", () => {
    // mirrors the `available = compareVersions(latest, current) > 0` gate
    expect(compareVersions("1.0.1", "1.0.1") > 0).toBeFalse();
    expect(compareVersions("1.0.0", "1.0.1") > 0).toBeFalse();
    expect(compareVersions("1.0.2", "1.0.1") > 0).toBeTrue();
  });
});
