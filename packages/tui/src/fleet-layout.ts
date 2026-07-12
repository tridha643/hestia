/**
 * Pure layout math for the Fleet cockpit (hunk pattern: bucketed responsive
 * decisions and measured pane widths live outside React so they are testable).
 */

export type FleetLayoutMode = "auto" | "split" | "stack";
export type FleetEffectiveLayout = "split" | "stack";

/** Auto-collapse the split layout under ~110 columns, per the TUI spec. */
export const SPLIT_MIN_WIDTH = 110;
export const SIDEBAR_MIN_WIDTH = 28;
export const SIDEBAR_MAX_WIDTH = 44;

export function resolveFleetLayout(mode: FleetLayoutMode, terminalWidth: number): FleetEffectiveLayout {
  if (mode === "auto") return terminalWidth >= SPLIT_MIN_WIDTH ? "split" : "stack";
  return mode;
}

export interface FleetPaneWidths {
  sidebar: number;
  main: number;
}

export function fleetPaneWidths(layout: FleetEffectiveLayout, terminalWidth: number): FleetPaneWidths {
  if (layout === "stack") return { sidebar: terminalWidth, main: terminalWidth };
  const sidebar = Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.floor(terminalWidth * 0.26)),
  );
  return { sidebar, main: Math.max(20, terminalWidth - sidebar) };
}

/** Box height for a service table with `rows` content rows: border + title + column header. */
export function servicePaneHeight(rows: number, maxHeight: number): number {
  const content = Math.max(2, rows + 1);
  return Math.min(maxHeight, content + 3);
}

/** Box height for the stacked-layout sidebar: border (2) + title (1) + stack rows. */
export function stackSidebarHeight(stackCount: number): number {
  return Math.min(9, Math.max(4, stackCount + 3));
}
