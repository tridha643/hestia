import type { FleetEndpointView, FleetServiceView, FleetStackView } from "@hestia/core";
import { padFleetText } from "../fleet-text.ts";
import { fleetTheme } from "../fleet-theme.ts";
import { sanitizeFleetTerminalText } from "../terminal-text.ts";

function serviceColor(service: FleetServiceView): string {
  if (service.state === "healthy") return fleetTheme.healthy;
  if (service.state === "unknown" || service.state === "unhealthy") return fleetTheme.warning;
  return fleetTheme.danger;
}

function endpointReach(endpoint: FleetEndpointView): string {
  return endpoint.localUrl ?? endpoint.publicUrl ?? endpoint.url ?? `${endpoint.host}:${endpoint.port}`;
}

/** Render workload rows for lifecycle/log selection and child endpoints for reachability actions. */
export function ServicePane({
  stack,
  selectedService,
  selectedEndpoint,
  onSelectService,
  onSelectEndpoint,
}: {
  stack?: FleetStackView;
  selectedService?: string;
  selectedEndpoint?: string;
  onSelectService?: (service: string) => void;
  onSelectEndpoint?: (service: string, endpoint: string) => void;
}) {
  return (
    <box style={{ height: "100%", width: "100%", flexDirection: "column", border: true, borderColor: fleetTheme.border }}>
      <box style={{ height: 1, paddingLeft: 1, backgroundColor: fleetTheme.panelAlt }}>
        <text fg={fleetTheme.text}>
          {stack === undefined ? "Workloads" : `Workloads — ${sanitizeFleetTerminalText(stack.branch)}`}
        </text>
      </box>
      {stack?.services.length ? stack.services.flatMap((service) => {
        const workloadSelected = service.name === selectedService && selectedEndpoint === undefined;
        const endpoints = service.endpoints ?? (service.endpoint === undefined ? [] : [service.endpoint]);
        const workloadRow = (
          <box
            key={`workload:${service.name}`}
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
              backgroundColor: workloadSelected ? fleetTheme.selected : fleetTheme.background,
            }}
          >
            <text fg={workloadSelected ? "#ffffff" : serviceColor(service)}>{workloadSelected ? "▸ " : "  "}</text>
            <text fg={workloadSelected ? "#ffffff" : fleetTheme.text}>
              {padFleetText(sanitizeFleetTerminalText(service.name), 20)}
            </text>
            <text fg={workloadSelected ? "#ffffff" : fleetTheme.muted}>{padFleetText(service.backend, 10)}</text>
            <text fg={workloadSelected ? "#ffffff" : serviceColor(service)}>{service.state}</text>
          </box>
        );
        const endpointRows = endpoints.map((endpoint, index) => {
          const endpointSelected = service.name === selectedService && endpoint.name === selectedEndpoint;
          const connector = index === endpoints.length - 1 ? "└─" : "├─";
          const kind = (endpoint.kind ?? "http").toUpperCase();
          const selector = `${endpoint.workload ?? service.name}:${endpoint.binding ?? endpoint.port}`;
          return (
            <box
              key={`endpoint:${service.name}:${endpoint.name}`}
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                onSelectEndpoint?.(service.name, endpoint.name);
              }}
              style={{
                height: 1,
                paddingLeft: 2,
                paddingRight: 1,
                flexDirection: "row",
                backgroundColor: endpointSelected ? fleetTheme.selected : fleetTheme.background,
              }}
            >
              <text fg={endpointSelected ? "#ffffff" : fleetTheme.muted}>{endpointSelected ? "▸ " : `${connector} `}</text>
              <text fg={endpointSelected ? "#ffffff" : fleetTheme.accent}>
                {padFleetText(sanitizeFleetTerminalText(endpoint.name), 18)}
              </text>
              <text fg={endpointSelected ? "#ffffff" : fleetTheme.muted}>{padFleetText(kind, 8)}</text>
              <text fg={endpointSelected ? "#ffffff" : fleetTheme.muted}>
                {padFleetText(sanitizeFleetTerminalText(selector), 20)}
              </text>
              <text fg={endpointSelected ? "#ffffff" : fleetTheme.text}>
                {sanitizeFleetTerminalText(endpointReach(endpoint))}
              </text>
            </box>
          );
        });
        return [workloadRow, ...endpointRows];
      }) : (
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text fg={fleetTheme.muted}>No workloads recorded</text>
        </box>
      )}
    </box>
  );
}
