import type { FleetStackView } from "@hestia/core";
import { envKey } from "@hestia/engine";
import { serviceEndpoints } from "./fleet-endpoints.ts";

/** Compact uptime label ("45s", "12m", "3h12m", "2d4h") from a stack birth time. */
export function formatUptime(createdAt: string, now: number): string | undefined {
  const born = Date.parse(createdAt);
  if (!Number.isFinite(born)) return undefined;
  const seconds = Math.max(0, Math.floor((now - born) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 === 0 ? "" : `${minutes % 60}m`}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 === 0 ? "" : `${hours % 24}h`}`;
}

/**
 * Best-effort projection of the injected env surface from one stack's Fleet
 * view: `HESTIA_<ENVKEY>_PORT` per service and endpoint alias plus the
 * `_URL`/`_LOCAL_URL`/`_DIRECT_URL` triple per endpoint. The snapshot does not
 * carry per-binding protocol keys — `hestia env` remains authoritative.
 */
export function buildEnvBlock(stack: FleetStackView): string {
  const lines: string[] = [];
  for (const service of stack.services) {
    if (service.backend === "tunnel") continue;
    if (service.publishedPort !== undefined) {
      lines.push(`HESTIA_${envKey(service.name)}_PORT=${service.publishedPort}`);
      if (service.backend === "docker") {
        lines.push(`HESTIA_${envKey(service.name)}_MAIN_TCP_PORT=${service.publishedPort}`);
      }
    }
    for (const endpoint of serviceEndpoints(service)) {
      const alias = envKey(endpoint.name);
      lines.push(`HESTIA_${alias}_PORT=${endpoint.port}`);
      if (endpoint.publicUrl !== undefined) lines.push(`HESTIA_${alias}_URL=${endpoint.publicUrl}`);
      if (endpoint.localUrl !== undefined) lines.push(`HESTIA_${alias}_LOCAL_URL=${endpoint.localUrl}`);
      if (endpoint.url !== undefined) lines.push(`HESTIA_${alias}_DIRECT_URL=${endpoint.url}`);
    }
  }
  return [...new Set(lines)].join("\n");
}
