import type { FleetServiceView, FleetStackView } from "@hestia/core";
import { padFleetText } from "../fleet-text.ts";
import { fleetTheme } from "../fleet-theme.ts";
import { sanitizeFleetTerminalText } from "../terminal-text.ts";

function serviceColor(service: FleetServiceView): string {
  if (service.state === "healthy") return fleetTheme.healthy;
  if (service.state === "unknown" || service.state === "unhealthy") return fleetTheme.warning;
  return fleetTheme.danger;
}

/** Render sanitized service and endpoint observations for the selected stack. */
export function ServicePane({
  stack,
  selectedService,
  onSelectService,
}: {
  stack?: FleetStackView;
  selectedService?: string;
  onSelectService?: (service: string) => void;
}) {
  return (
    <box style={{ height: "100%", width: "100%", flexDirection: "column", border: true, borderColor: fleetTheme.border }}>
      <box style={{ height: 1, paddingLeft: 1, backgroundColor: fleetTheme.panelAlt }}>
        <text fg={fleetTheme.text}>
          {stack === undefined ? "Services" : `Services — ${sanitizeFleetTerminalText(stack.branch)}`}
        </text>
      </box>
      {stack?.services.length ? stack.services.map((service) => {
        const selected = service.name === selectedService;
        const endpoint = service.endpoint;
        const primaryReach = endpoint?.localUrl ?? endpoint?.publicUrl ?? endpoint?.url ?? (
          endpoint !== undefined ? `${endpoint.host}:${endpoint.port}` : "-"
        );
        const directReach = endpoint !== undefined ? `${endpoint.host}:${endpoint.port}` : undefined;
        const reach = endpoint?.localUrl !== undefined && directReach !== undefined
          ? `${primaryReach} · ${directReach}`
          : primaryReach;
        return (
          <box
            key={service.name}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              onSelectService?.(service.name);
            }}
            style={{
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              flexDirection: "row",
              backgroundColor: selected ? fleetTheme.selected : fleetTheme.background,
            }}
          >
            <text fg={selected ? "#ffffff" : serviceColor(service)}>{selected ? "▸ " : "  "}</text>
            <text fg={selected ? "#ffffff" : fleetTheme.text}>
              {padFleetText(sanitizeFleetTerminalText(service.name), 20)}
            </text>
            <text fg={selected ? "#ffffff" : fleetTheme.muted}>{padFleetText(service.backend, 10)}</text>
            <text fg={selected ? "#ffffff" : serviceColor(service)}>{padFleetText(service.state, 11)}</text>
            <text fg={selected ? "#ffffff" : fleetTheme.muted}>{sanitizeFleetTerminalText(reach)}</text>
          </box>
        );
      }) : (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={fleetTheme.muted}>No services recorded</text>
        </box>
      )}
    </box>
  );
}
