import { describe, expect, test } from "bun:test";
import {
  fleetPaneWidths,
  resolveFleetLayout,
  servicePaneHeight,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SPLIT_MIN_WIDTH,
} from "../src/fleet-layout.ts";

describe("fleet layout math", () => {
  test("auto layout collapses to stacked below the split threshold", () => {
    expect(resolveFleetLayout("auto", SPLIT_MIN_WIDTH)).toBe("split");
    expect(resolveFleetLayout("auto", SPLIT_MIN_WIDTH - 1)).toBe("stack");
    expect(resolveFleetLayout("split", 60)).toBe("split");
    expect(resolveFleetLayout("stack", 200)).toBe("stack");
  });

  test("split pane widths clamp the sidebar and leave the rest to the main pane", () => {
    const narrow = fleetPaneWidths("split", 110);
    expect(narrow.sidebar).toBe(SIDEBAR_MIN_WIDTH);
    expect(narrow.sidebar + narrow.main).toBe(110);
    const wide = fleetPaneWidths("split", 300);
    expect(wide.sidebar).toBe(SIDEBAR_MAX_WIDTH);
    expect(wide.main).toBe(300 - SIDEBAR_MAX_WIDTH);
    expect(fleetPaneWidths("stack", 90)).toEqual({ sidebar: 90, main: 90 });
  });

  test("service pane height fits title, column header, and rows under a cap", () => {
    expect(servicePaneHeight(0, 14)).toBe(5);
    expect(servicePaneHeight(3, 14)).toBe(7);
    expect(servicePaneHeight(40, 14)).toBe(14);
  });
});
