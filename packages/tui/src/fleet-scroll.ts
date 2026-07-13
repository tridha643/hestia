/** Minimal OpenTUI mouse-scroll payload consumed by Fleet panes. */
export interface FleetMouseScrollEvent {
  scroll?: { direction?: string; delta?: number };
}

/** Translate OpenTUI's scroll payload into a signed Fleet row delta. */
export function fleetMouseScrollDelta(event: FleetMouseScrollEvent, rows = 3): number | undefined {
  if (event.scroll?.direction === "up") return -rows;
  if (event.scroll?.direction === "down") return rows;
  return undefined;
}
