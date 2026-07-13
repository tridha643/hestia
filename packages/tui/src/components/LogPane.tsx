import type { FleetLogRow } from "../fleet-log-rows.ts";
import { fitFleetText, fleetTextWidth, padFleetText } from "../fleet-text.ts";
import { fleetTheme } from "../fleet-theme.ts";
import { fleetMouseScrollDelta } from "../fleet-scroll.ts";

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
  const position = visible.length === 0 ? "0/0" : `${start + 1}–${end}/${rows.length}`;
  const rawStatus = follow ? "following" : `paused · ${position}${unseen > 0 ? ` · ${unseen} new` : ""}`;
  const headerWidth = Math.max(1, width - 4);
  const status = fitFleetText(rawStatus, Math.max(1, headerWidth - Math.min(8, headerWidth - 1)));
  const titleWidth = Math.max(0, headerWidth - fleetTextWidth(status));
  const title = fitFleetText(`Logs — ${label}`, titleWidth);

  return (
    <box
      onMouseScroll={(event) => {
        const delta = fleetMouseScrollDelta(event);
        if (delta === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onScroll?.(delta);
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
          {padFleetText(title, titleWidth)}
        </text>
        <text fg={follow ? fleetTheme.healthy : fleetTheme.warning}>
          {status}
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
