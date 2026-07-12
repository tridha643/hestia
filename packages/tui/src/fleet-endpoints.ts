import type { FleetEndpointView, FleetServiceView } from "@hestia/core";

/** Normalize the legacy singular `endpoint` field with the plural list. */
export function serviceEndpoints(service: FleetServiceView): FleetEndpointView[] {
  return service.endpoints ?? (service.endpoint === undefined ? [] : [service.endpoint]);
}

/** The one address a human should reach for, in preference order. */
export function endpointReach(endpoint: FleetEndpointView): string {
  return endpoint.localUrl ?? endpoint.publicUrl ?? endpoint.url ?? `${endpoint.host}:${endpoint.port}`;
}
