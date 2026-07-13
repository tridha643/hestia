import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceRecord, StackRecord } from "@hestia/core";
import { probeProcessIdentity } from "../proc/pidfile.ts";
import { inspectPort } from "../proc/ports.ts";

const pexec = promisify(execFile);

/** Three-state origin health; unknown infrastructure failures must never release ownership. */
export type OriginLiveness = "live" | "dead" | "unknown";

/** Persisted identity needed to verify one local route origin. */
export interface LocalOriginTarget {
  project: string;
  service?: ServiceRecord;
}

/** Probe a Docker route origin without treating Docker daemon failures as a dead workload. */
export async function probeDockerOrigin(
  target: LocalOriginTarget,
  port: number,
): Promise<OriginLiveness> {
  try {
    const service = target.service!;
    const args = [
      "ps", "--no-trunc", "--format", "{{.ID}}\t{{.Ports}}",
      "--filter", `label=dev.hestia.stack=${target.project}`,
      "--filter", `label=com.docker.compose.service=${service.name}`,
    ];
    const { stdout } = await pexec("docker", args, { timeout: 2_000 });
    const matches = stdout.split("\n").some((line) => {
      const [id, ports = ""] = line.split("\t");
      const identityMatches = service.containerId === undefined || id?.startsWith(service.containerId);
      return identityMatches && new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}->`).test(ports);
    });
    return matches ? "live" : "dead";
  } catch {
    return "unknown";
  }
}

/** Probe a supervised process route origin with PID identity and port ownership checks. */
export async function probeProcOrigin(
  service: ServiceRecord,
  port: number,
): Promise<OriginLiveness> {
  if (service.pid === undefined || service.startTime === undefined) return "dead";
  if (!Number.isSafeInteger(service.pid) || service.pid <= 0 || typeof service.startTime !== "string") {
    throw new Error("Route origin has an invalid process identity");
  }
  const identity = probeProcessIdentity({ pid: service.pid, startTime: service.startTime });
  if (identity !== "live") return identity;
  try {
    return (await inspectPort(service.pid, port)).ownerIsMember ? "live" : "dead";
  } catch {
    return "unknown";
  }
}

/** Probe a local router target while preserving unknown infrastructure failures. */
export async function probeLocalRouterTarget(target: LocalOriginTarget): Promise<OriginLiveness> {
  const service = target.service;
  const port = service?.publishedPort;
  if (service === undefined || port === undefined || service.backend === "tunnel") return "dead";
  return service.backend === "docker"
    ? await probeDockerOrigin(target, port)
    : await probeProcOrigin(service, port);
}

/** Verify a request-path target; unknown and dead both remain unavailable to the router. */
export async function verifyLocalRouterTarget(target: LocalOriginTarget): Promise<number | null> {
  const port = target.service?.publishedPort;
  try {
    return port !== undefined && await probeLocalRouterTarget(target) === "live" ? port : null;
  } catch {
    return null;
  }
}

/** Verify one persisted service still owns its direct loopback origin. */
export async function verifyStackServiceOrigin(
  record: StackRecord,
  service: ServiceRecord,
  publishedPort = service.publishedPort,
): Promise<boolean> {
  return await verifyLocalRouterTarget({
    project: record.project,
    service: { ...service, publishedPort },
  }) !== null;
}

/** Resolve a shared-hostname endpoint alias to the concrete bound workload origin. */
export function resolveSharedContractOrigin(
  mirror: StackRecord,
  contractService: string,
): ServiceRecord | undefined {
  const endpoint = mirror.endpoints.find(
    (candidate) => (candidate.alias ?? candidate.name) === contractService,
  );
  const service = mirror.services.find(
    (candidate) => candidate.name === (endpoint?.workload ?? endpoint?.name),
  );
  const binding = service?.bindings?.find(
    (candidate) => `${candidate.target}/${candidate.protocol}` === endpoint?.binding,
  );
  const publishedPort = binding?.publishedPort ?? service?.publishedPort;
  return service === undefined || service.backend === "tunnel" || publishedPort === undefined
    ? undefined
    : { ...service, publishedPort };
}

/** Probe an exposed shared-hostname origin; missing contract projection stays unknown. */
export async function probeSharedHolderOrigin(
  mirror: StackRecord,
  contractService: string,
): Promise<OriginLiveness> {
  const service = resolveSharedContractOrigin(mirror, contractService);
  if (service === undefined) return "unknown";
  return await probeLocalRouterTarget({ project: mirror.project, service });
}
