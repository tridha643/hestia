import { describe, expect, test } from "bun:test";
import {
  isDoctorKey,
  isEscapeKey,
  isFollowBottomKey,
  isPlainKey,
  isScrollTopKey,
} from "../src/fleet-keys.ts";

describe("fleet key predicates", () => {
  test("escape matches every terminal alias", () => {
    expect(isEscapeKey({ name: "escape" })).toBeTrue();
    expect(isEscapeKey({ name: "esc" })).toBeTrue();
    expect(isEscapeKey({ name: "unknown", sequence: "\x1b" })).toBeTrue();
    expect(isEscapeKey({ name: "e" })).toBeFalse();
  });

  test("plain keys reject modifier chords", () => {
    expect(isPlainKey({ name: "d" }, "d")).toBeTrue();
    expect(isPlainKey({ name: "d", ctrl: true }, "d")).toBeFalse();
    expect(isPlainKey({ name: ",", sequence: "," }, ",")).toBeTrue();
  });

  test("g scrolls to top while G follows the tail", () => {
    expect(isScrollTopKey({ name: "g", sequence: "g" })).toBeTrue();
    expect(isScrollTopKey({ name: "g", sequence: "G", shift: true })).toBeFalse();
    expect(isFollowBottomKey({ name: "g", sequence: "G", shift: true })).toBeTrue();
    expect(isFollowBottomKey({ name: "g", sequence: "g" })).toBeFalse();
  });

  test("shifted d opens doctor instead of down", () => {
    expect(isDoctorKey({ name: "d", sequence: "D", shift: true })).toBeTrue();
    expect(isDoctorKey({ name: "d", sequence: "d" })).toBeFalse();
  });
});
