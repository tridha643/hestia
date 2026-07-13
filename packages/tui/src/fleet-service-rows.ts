import type { FleetEndpointView, FleetServiceView, FleetStackView } from "@hestia/core";
import { serviceEndpoints } from "./fleet-endpoints.ts";

/** One selectable workload-table row in its rendered order. */
export type FleetServiceRow =
  | { kind: "workload"; service: FleetServiceView }
  | { kind: "endpoint"; service: FleetServiceView; endpoint: FleetEndpointView; endpointIndex: number };

/** Flatten workloads and their endpoints into the exact row order rendered by Fleet. */
export function buildFleetServiceRows(stack: FleetStackView | undefined): FleetServiceRow[] {
  if (stack === undefined) return [];
  return stack.services.flatMap((service) => {
    const endpoints = serviceEndpoints(service);
    return [
      { kind: "workload" as const, service },
      ...endpoints.map((endpoint, endpointIndex) => ({
        kind: "endpoint" as const,
        service,
        endpoint,
        endpointIndex,
      })),
    ];
  });
}

/** Count rendered workload and endpoint rows in the services pane. */
export function fleetServiceRowCount(stack: FleetStackView | undefined): number {
  return buildFleetServiceRows(stack).length;
}

/** Find the rendered row selected by the current workload/endpoint identity. */
export function selectedFleetServiceRowIndex(
  rows: FleetServiceRow[],
  serviceName: string | undefined,
  endpointName: string | undefined,
): number {
  return rows.findIndex((row) => row.service.name === serviceName && (
    endpointName === undefined
      ? row.kind === "workload"
      : row.kind === "endpoint" && row.endpoint.name === endpointName
  ));
}

/** Clamp a services-pane offset so the selected row remains in its viewport. */
export function ensureFleetServiceRowVisible(
  offset: number,
  selectedIndex: number,
  viewportRows: number,
  rowCount: number,
): number {
  const maxOffset = Math.max(0, rowCount - viewportRows);
  const clamped = Math.min(maxOffset, Math.max(0, offset));
  if (selectedIndex < 0) return clamped;
  if (selectedIndex < clamped) return selectedIndex;
  if (selectedIndex >= clamped + viewportRows) {
    return Math.min(maxOffset, selectedIndex - viewportRows + 1);
  }
  return clamped;
}
