import type { LogLine } from "@hestia/core";
import { fitFleetText, padFleetText } from "../fleet-text.ts";
import { fleetTheme } from "../fleet-theme.ts";

/** Render only visible selected-service log rows plus a tiny overscan window. */
export function LogPane({
  lines,
  height,
  width,
  offset,
  follow,
  unseen,
  label,
}: {
  lines: LogLine[];
  height: number;
  width: number;
  offset: number;
  follow: boolean;
  unseen: number;
  label: string;
}) {
  const viewportRows = Math.max(1, height - 3);
  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - viewportRows - 2);
  const visible = lines.slice(start, end).slice(-viewportRows);
  return (
    <box style={{ height: "100%", width: "100%", flexDirection: "column", border: true, borderColor: fleetTheme.border }}>
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", backgroundColor: fleetTheme.panelAlt }}>
        <text fg={fleetTheme.text}>{padFleetText(`Logs — ${label}`, Math.max(1, width - 24))}</text>
        <text fg={follow ? fleetTheme.healthy : fleetTheme.warning}>
          {follow ? "following" : `paused${unseen > 0 ? ` · ${unseen} new` : ""}`}
        </text>
      </box>
      {visible.length === 0 ? (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={fleetTheme.muted}>Waiting for log lines…</text>
        </box>
      ) : visible.map((line, index) => (
        <box key={`${start + index}-${line.text}`} style={{ height: 1, paddingLeft: 1 }}>
          <text fg={line.meta ? fleetTheme.warning : fleetTheme.text}>
            {fitFleetText(line.meta ? `[hestia] ${line.text}` : line.text, Math.max(1, width - 4))}
          </text>
        </box>
      ))}
    </box>
  );
}
