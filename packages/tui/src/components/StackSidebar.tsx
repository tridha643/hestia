import { memo } from "react";
import type { FleetCapacityView, FleetStackView } from "@hestia/core";
import stringWidth from "string-width";
import { fitFleetText, padFleetText } from "../fleet-text.ts";
import { fleetTheme, stackPhaseColor, stackPhaseGlyph } from "../fleet-theme.ts";
import { sanitizeFleetTerminalText } from "../terminal-text.ts";

/** Render only the managed stack rows supplied by the daemon Fleet snapshot. */
export const StackSidebar = memo(function StackSidebar({
  stacks,
  capacity,
  selectedProject,
  width,
  focused = false,
  spinnerFrame = 0,
  onSelectProject,
}: {
  stacks: FleetStackView[];
  capacity: FleetCapacityView;
  selectedProject?: string;
  width: number;
  focused?: boolean;
  spinnerFrame?: number;
  onSelectProject?: (project: string) => void;
}) {
  const branchWidth = Math.max(6, width - 17);
  const slots = capacity.maxStacks > 0 ? ` · ${capacity.live}/${capacity.maxStacks} slots` : "";
  return (
    <box
      style={{
        width,
        height: "100%",
        flexDirection: "column",
        border: true,
        borderColor: focused ? fleetTheme.accent : fleetTheme.border,
        backgroundColor: fleetTheme.background,
      }}
    >
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", backgroundColor: fleetTheme.panelAlt }}>
        <text fg={focused ? fleetTheme.accent : fleetTheme.text}>Stacks</text>
        <text fg={fleetTheme.faint}>{slots}</text>
      </box>
      {stacks.length === 0 ? (
        <box style={{ paddingLeft: 1, paddingTop: 1, flexDirection: "column" }}>
          <text fg={fleetTheme.muted}>No managed stacks.</text>
          <text fg={fleetTheme.faint}>`hestia up` starts one here.</text>
        </box>
      ) : stacks.map((stack) => {
        const selected = stack.project === selectedProject;
        const branch = sanitizeFleetTerminalText(stack.branch);
        const phase = sanitizeFleetTerminalText(stack.phase);
        const glyph = stackPhaseGlyph(stack.phase, spinnerFrame);
        const meta = stack.services.length > 0 ? ` ·${stack.services.length}` : "";
        const warn = stack.warning === undefined ? "" : " ⚠";
        const available = Math.max(4, branchWidth - stringWidth(meta) - stringWidth(warn));
        const rowBg = selected ? fleetTheme.selectedBg : fleetTheme.background;
        return (
          <box
            key={stack.project}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              onSelectProject?.(stack.project);
            }}
            style={{ height: 1, paddingRight: 1, flexDirection: "row", backgroundColor: rowBg }}
          >
            <text fg={fleetTheme.stripe}>{selected ? "▎" : " "}</text>
            <text fg={stackPhaseColor(stack.phase)}>{glyph} </text>
            <text fg={selected ? fleetTheme.bright : fleetTheme.text}>
              {padFleetText(fitFleetText(branch, available), available)}
            </text>
            <text fg={fleetTheme.warning}>{warn}</text>
            <text fg={fleetTheme.faint}>{meta}</text>
            <text fg={stackPhaseColor(stack.phase)}>{` ${padFleetText(phase, 8)}`}</text>
          </box>
        );
      })}
    </box>
  );
});
