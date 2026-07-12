import type { FleetLogRow } from "../fleet-log-rows.ts";
import { fitFleetText, padFleetText } from "../fleet-text.ts";
import { fleetTheme } from "../fleet-theme.ts";

/** Render only visible selected-service log rows; the host owns wrapping and offsets. */
export function LogPane({
  rows,
  height,
  width,
  offset,
  follow,
  unseen,
  label,
  focused = false,
  onScroll,
}: {
  rows: FleetLogRow[];
  height: number;
  width: number;
  offset: number;
  follow: boolean;
  unseen: number;
  label: string;
  focused?: boolean;
  onScroll?: (delta: number) => void;
}) {
  const viewportRows = Math.max(1, height - 3);
  const maxOffset = Math.max(0, rows.length - viewportRows);
  const clamped = Math.min(offset, maxOffset);
  const end = Math.max(0, rows.length - clamped);
  const start = Math.max(0, end - viewportRows);
  const visible = rows.slice(start, end);
  const title = fitFleetText(`Logs — ${label}`, Math.max(8, width - 28));

  return (
    <box
      onMouseScroll={(event) => {
        if (event.button !== 4 && event.button !== 5) return;
        event.preventDefault();
        event.stopPropagation();
        onScroll?.(event.button === 4 ? -3 : 3);
      }}
      style={{
        height: "100%",
        width: "100%",
        flexDirection: "column",
        border: true,
        borderColor: focused ? fleetTheme.accent : fleetTheme.border,
        backgroundColor: fleetTheme.background,
      }}
    >
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", backgroundColor: fleetTheme.panelAlt }}>
        <text fg={focused ? fleetTheme.accent : fleetTheme.text}>
          {padFleetText(title, Math.max(1, width - 24))}
        </text>
        <text fg={follow ? fleetTheme.healthy : fleetTheme.warning}>
          {follow ? "following" : `paused${unseen > 0 ? ` · ${unseen} new` : ""}`}
        </text>
      </box>
      {visible.length === 0 ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={fleetTheme.muted}>No log output yet — waiting for this workload.</text>
        </box>
      ) : visible.map((row) => (
        <box key={row.key} style={{ height: 1, paddingLeft: 1, flexDirection: "row" }}>
          {row.tag === undefined ? null : <text fg={fleetTheme.accent}>{row.tag}</text>}
          <text fg={row.meta ? fleetTheme.warning : fleetTheme.text}>{row.text}</text>
        </box>
      ))}
    </box>
  );
}
