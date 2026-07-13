import { memo } from "react";
import type { FleetServiceView, FleetStackView } from "@hestia/core";
import { endpointReach } from "../fleet-endpoints.ts";
import { buildFleetServiceRows } from "../fleet-service-rows.ts";
import { fitFleetText, padFleetText } from "../fleet-text.ts";
import {
  backendColor,
  fleetTheme,
  serviceStateColor,
  serviceStateGlyph,
} from "../fleet-theme.ts";
import { sanitizeFleetTerminalText } from "../terminal-text.ts";
import { fleetMouseScrollDelta } from "../fleet-scroll.ts";

function portLabel(service: FleetServiceView): string {
  if (service.publishedPort === undefined) return "—";
  return `:${service.publishedPort}`;
}

/** Render workload rows for lifecycle/log selection and child endpoints for reachability actions. */
export const ServicePane = memo(function ServicePane({
  stack,
  uptime,
  selectedService,
  selectedEndpoint,
  offset = 0,
  viewportRows = 1,
  width = 80,
  focused = false,
  onSelectService,
  onSelectEndpoint,
  onScroll,
}: {
  stack?: FleetStackView;
  uptime?: string;
  selectedService?: string;
  selectedEndpoint?: string;
  offset?: number;
  viewportRows?: number;
  width?: number;
  focused?: boolean;
  onSelectService?: (service: string) => void;
  onSelectEndpoint?: (service: string, endpoint: string) => void;
  onScroll?: (delta: number) => void;
}) {
  const nameWidth = Math.min(24, Math.max(12, Math.floor(width * 0.28)));
  const backendWidth = 10;
  const stateWidth = 10;
  const portWidth = 7;
  const title = stack === undefined
    ? "Workloads"
    : `Workloads — ${sanitizeFleetTerminalText(stack.branch)}`;
  const warning = stack?.warning === undefined
    ? undefined
    : sanitizeFleetTerminalText(stack.warning);
  const rows = buildFleetServiceRows(stack);
  const maxOffset = Math.max(0, rows.length - viewportRows);
  const clampedOffset = Math.min(maxOffset, Math.max(0, offset));
  const visibleRows = rows.slice(clampedOffset, clampedOffset + viewportRows);
  const hiddenAbove = clampedOffset;
  const hiddenBelow = Math.max(0, rows.length - clampedOffset - visibleRows.length);

  const overflowIndicator = (index: number): string | undefined => {
    const first = index === 0 && hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : undefined;
    const last = index === visibleRows.length - 1 && hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : undefined;
    return [first, last].filter(Boolean).join(" · ") || undefined;
  };

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
          {fitFleetText(title, Math.max(8, width - 14))}
        </text>
        {uptime === undefined ? null : <text fg={fleetTheme.faint}> · up {uptime}</text>}
      </box>
      {warning === undefined ? null : (
        <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text fg={fleetTheme.warning}>{fitFleetText(`⚠ ${warning}`, Math.max(8, width - 4))}</text>
        </box>
      )}
      {stack?.services.length ? (
        <>
          <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row" }}>
            <text fg={fleetTheme.faint}>{padFleetText("", 4)}</text>
            <text fg={fleetTheme.faint}>{padFleetText("NAME", nameWidth)}</text>
            <text fg={fleetTheme.faint}>{padFleetText("BACKEND", backendWidth)}</text>
            <text fg={fleetTheme.faint}>{padFleetText("STATE", stateWidth)}</text>
            <text fg={fleetTheme.faint}>{padFleetText("PORT", portWidth)}</text>
          </box>
          {visibleRows.map((row, visibleIndex) => {
            const service = row.service;
            const workloadSelected = service.name === selectedService && selectedEndpoint === undefined;
            const state = sanitizeFleetTerminalText(service.state);
            const workloadBg = workloadSelected ? fleetTheme.selectedBg : fleetTheme.background;
            const indicator = overflowIndicator(visibleIndex);
            if (row.kind === "workload") return (
              <box
                key={`workload:${service.name}`}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectService?.(service.name);
                }}
                style={{ height: 1, paddingRight: 1, flexDirection: "row", backgroundColor: workloadBg }}
              >
                <text fg={fleetTheme.stripe}>{workloadSelected ? "▎" : " "}</text>
                <text fg={serviceStateColor(service.state)}>
                  {" "}{serviceStateGlyph(service.state)}{" "}
                </text>
                <text fg={workloadSelected ? fleetTheme.bright : fleetTheme.text}>
                  {padFleetText(sanitizeFleetTerminalText(service.name), nameWidth)}
                </text>
                <text fg={backendColor(service.backend)}>
                  {padFleetText(service.backend, backendWidth)}
                </text>
                <text fg={serviceStateColor(service.state)}>
                  {padFleetText(state, stateWidth)}
                </text>
                <text fg={fleetTheme.muted}>
                  {padFleetText(portLabel(service), portWidth)}
                </text>
                {indicator === undefined ? null : <text fg={fleetTheme.faint}>{indicator}</text>}
              </box>
            );
            const endpoint = row.endpoint;
            const endpointSelected = service.name === selectedService && endpoint.name === selectedEndpoint;
            const endpointCount = service.endpoints?.length ?? (service.endpoint === undefined ? 0 : 1);
            const connector = row.endpointIndex === endpointCount - 1 ? "└─" : "├─";
            const kind = (endpoint.kind ?? "http").toUpperCase();
            const reach = sanitizeFleetTerminalText(endpointReach(endpoint));
            const aliasWidth = Math.min(18, Math.max(10, Math.floor(width * 0.22)));
            const pub = endpoint.publicUrl === undefined ? "" : " pub";
            const endpointBg = endpointSelected ? fleetTheme.selectedBg : fleetTheme.background;
            return (
              <box
                key={`endpoint:${service.name}:${endpoint.name}`}
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectEndpoint?.(service.name, endpoint.name);
                }}
                style={{ height: 1, paddingRight: 1, flexDirection: "row", backgroundColor: endpointBg }}
              >
                <text fg={fleetTheme.stripe}>{endpointSelected ? "▎" : " "}</text>
                <text fg={fleetTheme.faint}>{`  ${connector} `}</text>
                <text fg={endpointSelected ? fleetTheme.bright : fleetTheme.accent}>
                  {padFleetText(sanitizeFleetTerminalText(endpoint.name), aliasWidth)}
                </text>
                <text fg={fleetTheme.muted}>{padFleetText(kind, 6)}</text>
                <text fg={fleetTheme.text}>
                  {fitFleetText(reach, Math.max(12, width - aliasWidth - 19 - pub.length))}
                </text>
                <text fg={fleetTheme.publicBadge}>{pub}</text>
                {indicator === undefined ? null : <text fg={fleetTheme.faint}>{indicator}</text>}
              </box>
            );
          })}
        </>
      ) : (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={fleetTheme.muted}>
            {stack?.phase === "queued" || stack?.phase === "reserved"
              ? "Waiting for a machine slot — services appear once startup begins."
              : "No workloads recorded"}
          </text>
        </box>
      )}
    </box>
  );
});
