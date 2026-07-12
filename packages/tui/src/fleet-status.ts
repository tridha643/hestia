import type { FleetCapacityView } from "@hestia/core";

export interface FleetKeyHint {
  keys: string;
  label: string;
}

/** Persistent footer hints, keycap-styled by the renderer (spec status bar). */
export const FLEET_KEY_HINTS: FleetKeyHint[] = [
  { keys: ", .", label: "stack" },
  { keys: "[ ]", label: "svc" },
  { keys: "o", label: "open" },
  { keys: "y", label: "yank" },
  { keys: "?", label: "help" },
];

/** Right-aligned daemon summary: capacity, queue depth, connection state. */
export function fleetCapacitySummary(capacity: FleetCapacityView, connected: boolean): string {
  if (!connected) return "daemon unreachable";
  const parts = [`${capacity.live}/${capacity.maxStacks}`];
  if (capacity.reserved > 0) parts.push(`${capacity.reserved} reserved`);
  if (capacity.queued > 0) parts.push(`${capacity.queued} queued`);
  parts.push("daemon ok");
  return parts.join(" · ");
}

/**
 * Fresh action feedback (a copy result, a failed down) outranks the standing
 * connection banner — a toast expires in seconds and the banner returns, but a
 * masked failure toast would expire unseen.
 */
export function resolveStatusNotice(
  connectionNotice: string | undefined,
  toast: string | undefined,
): string | undefined {
  return toast ?? connectionNotice;
}
