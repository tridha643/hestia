import type { FleetStackView } from "@hestia/core";
import { padFleetText } from "../fleet-text.ts";
import { fleetTheme } from "../fleet-theme.ts";
import { sanitizeFleetTerminalText } from "../terminal-text.ts";

function phaseColor(phase: FleetStackView["phase"]): string {
  if (phase === "up") return fleetTheme.healthy;
  if (phase === "degraded" || phase === "unknown") return fleetTheme.warning;
  if (phase === "stopped") return fleetTheme.danger;
  return fleetTheme.accent;
}

/** Render only the managed stack rows supplied by the daemon Fleet snapshot. */
export function StackSidebar({
  stacks,
  selectedProject,
  width,
}: {
  stacks: FleetStackView[];
  selectedProject?: string;
  width: number;
}) {
  return (
    <box style={{ width, height: "100%", flexDirection: "column", border: true, borderColor: fleetTheme.border }}>
      <box style={{ height: 1, paddingLeft: 1, backgroundColor: fleetTheme.panelAlt }}>
        <text fg={fleetTheme.text}>Fleet</text>
      </box>
      {stacks.length === 0 ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={fleetTheme.muted}>No managed stacks</text>
        </box>
      ) : stacks.map((stack) => {
        const selected = stack.project === selectedProject;
        const branch = sanitizeFleetTerminalText(stack.branch);
        return (
          <box
            key={stack.project}
            style={{
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
              backgroundColor: selected ? fleetTheme.selected : fleetTheme.background,
            }}
          >
            <text fg={selected ? "#ffffff" : phaseColor(stack.phase)}>{selected ? "▸ " : "  "}</text>
            <text fg={selected ? "#ffffff" : fleetTheme.text}>
              {padFleetText(branch, Math.max(4, width - 13))}
            </text>
            <text fg={selected ? "#ffffff" : phaseColor(stack.phase)}>
              {padFleetText(stack.phase, 9)}
            </text>
          </box>
        );
      })}
    </box>
  );
}
