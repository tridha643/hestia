import type { ReactNode } from "react";
import { fleetTheme } from "../fleet-theme.ts";

/** Centered modal with a mouse-catching backdrop so destructive keys cannot leak through. */
export function FleetModal({
  title,
  terminalWidth,
  terminalHeight,
  children,
}: {
  title: string;
  terminalWidth: number;
  terminalHeight: number;
  children: ReactNode;
}) {
  const width = Math.min(78, Math.max(36, terminalWidth - 4));
  const height = Math.min(22, Math.max(8, terminalHeight - 4));
  return (
    <>
      <box style={{ position: "absolute", top: 0, left: 0, width: terminalWidth, height: terminalHeight, zIndex: 50 }} />
      <box
        style={{
          position: "absolute",
          top: Math.max(1, Math.floor((terminalHeight - height) / 2)),
          left: Math.max(1, Math.floor((terminalWidth - width) / 2)),
          width,
          height,
          zIndex: 60,
          border: true,
          borderColor: fleetTheme.accent,
          backgroundColor: fleetTheme.panel,
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        }}
      >
        <box style={{ height: 1, flexDirection: "row" }}>
          <box style={{ flexGrow: 1 }}>
            <text fg={fleetTheme.accent}>{title}</text>
          </box>
          <text fg={fleetTheme.faint}>Esc closes</text>
        </box>
        <box style={{ height: 1 }} />
        {children}
      </box>
    </>
  );
}
