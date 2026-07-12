import { describe, expect, test } from "bun:test";
import { fitFleetText, padFleetText, wrapFleetText } from "../src/fleet-text.ts";

describe("fleet text helpers", () => {
  test("fitFleetText ellipsis-truncates by display width", () => {
    expect(fitFleetText("abcdef", 4)).toBe("abc…");
    expect(padFleetText("ab", 4)).toBe("ab  ");
  });

  test("wrapFleetText keeps long log lines readable across rows", () => {
    expect(wrapFleetText("abcdefghij", 4, 3)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapFleetText("abcdefghijklmnop", 4, 3)).toEqual(["abcd", "efgh", "ijk…"]);
    expect(wrapFleetText("short", 20, 3)).toEqual(["short"]);
  });
});
