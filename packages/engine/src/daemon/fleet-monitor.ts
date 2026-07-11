import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LABELS,
  projectName,
  type FleetEnvelope,
  type FleetServiceView,
  type FleetSnapshot,
  type FleetStackPhase,
  type FleetStackView,
  type RepoId,
  type ServiceRecord,
  type StackIdentity,
  type StackRecord,
} from "@hestia/core";
import { getRepoInfo } from "../git.ts";
import { allListeners, processTree, type Listener } from "../proc/ports.ts";
import { isLive, listPidfiles } from "../proc/pidfile.ts";
import { hestiaHome, mirrorProcsDir, parseStackRecord } from "../state.ts";
import {
  effectiveLocalRouteServices,
  readHestiaMachineConfig,
  type HestiaMachineConfig,
} from "../router/router-config.ts";
import { resolvedLocalRouteHostname } from "../router/local-http-router.ts";
import { readHestiaRouterStatus } from "../router/portless-adapter.ts";
import { resolveMaxStacks, type SlotLedger, type StackReservation } from "./slots.ts";

const pexec = promisify(execFile);
const DEFAULT_REFRESH_MS = 1_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_MIRROR_BYTES = 2 * 1024 * 1024;

/** Minimal admission view used by Fleet without entering the admission mutex. */
export interface FleetAdmissionSource {
  ledger: SlotLedger;
  queuedIdentitySnapshot(): StackIdentity[];
}

interface ManagedMirrorResult {
  records: StackRecord[];
  warnings: string[];
}

interface DockerServiceSnapshot {
  services: Map<string, Map<string, FleetServiceView["state"]>> | null;
  warning?: string;
}

class LatestFleetChannel {
  #pending: FleetEnvelope | undefined;
  #waiter: ((result: IteratorResult<FleetEnvelope>) => void) | undefined;
  #closed = false;

  push(frame: FleetEnvelope): void {
    if (this.#closed) return;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ value: frame, done: false });
    } else {
      if (this.#pending?.type === "snapshot" && frame.type === "heartbeat") return;
      this.#pending = frame;
    }
  }

  next(): Promise<IteratorResult<FleetEnvelope>> {
    if (this.#pending !== undefined) {
      const value = this.#pending;
      this.#pending = undefined;
      return Promise.resolve({ value, done: false });
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = undefined;
    this.#waiter?.({ value: undefined, done: true });
    this.#waiter = undefined;
  }
}

function readManagedMirrors(): ManagedMirrorResult {
  const records: StackRecord[] = [];
  const warnings: string[] = [];
  const stacksDirectory = join(hestiaHome(), "stacks");
  if (!existsSync(stacksDirectory)) return { records, warnings };
  for (const project of readdirSync(stacksDirectory).sort()) {
    const path = join(stacksDirectory, project, "stack.json");
    try {
      const source = readFileSync(path);
      if (source.byteLength > MAX_MIRROR_BYTES) {
        warnings.push(`Fleet mirror too large for ${project}`);
        continue;
      }
      const record = parseStackRecord(source.toString("utf8"), path);
      if (record.project !== project) {
        warnings.push(`Fleet mirror project mismatch for ${project}`);
        continue;
      }
      records.push(record);
    } catch {
      warnings.push(`Fleet mirror unreadable for ${project}`);
    }
  }
  return { records, warnings };
}

async function attributeLegacyRepoId(record: StackRecord): Promise<RepoId | null> {
  if (record.repoId !== undefined) return record.repoId;
  if (!existsSync(record.worktree)) return null;
  const info = await getRepoInfo(record.worktree);
  if (projectName(info.repoId, info.repo, info.branch, info.worktreeRoot) !== record.project) return null;
  return info.repoId;
}

/** Convert one bounded `docker ps` result into project/service health states. */
export function parseDockerFleetServices(
  stdout: string,
): Map<string, Map<string, FleetServiceView["state"]>> {
  const services = new Map<string, Map<string, FleetServiceView["state"]>>();
  for (const line of stdout.split("\n")) {
    const [project, service, containerState, status] = line.trim().split("\t");
    if (!project || !service) continue;
    const projectServices = services.get(project) ??
      new Map<string, FleetServiceView["state"]>();
    const healthy = containerState === "running" &&
      !/\((?:unhealthy|health: starting)\)/i.test(status ?? "");
    projectServices.set(service, healthy ? "healthy" : "unhealthy");
    services.set(project, projectServices);
  }
  return services;
}

async function collectDockerServiceSnapshot(): Promise<DockerServiceSnapshot> {
  try {
    const { stdout } = await pexec(
      "docker",
      [
        "ps",
        "--format",
        `{{.Label \"${LABELS.stack}\"}}\t{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.Status}}`,
        "--filter",
        `label=${LABELS.stack}`,
      ],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return { services: parseDockerFleetServices(stdout) };
  } catch (error) {
    return {
      services: null,
      warning: `Fleet Docker probe unavailable: ${(error as Error).message}`,
    };
  }
}

async function observeFleetService(
  record: StackRecord,
  service: ServiceRecord,
  docker: DockerServiceSnapshot,
  listeners: Listener[] | null,
  config: HestiaMachineConfig,
  localRouterUsable: boolean,
): Promise<FleetServiceView> {
  let state: FleetServiceView["state"];
  if (service.backend === "docker") {
    state = docker.services === null
      ? "unknown"
      : docker.services.get(record.project)?.get(service.name) ?? "exited";
  } else if (
    service.pid === undefined ||
    service.startTime === undefined ||
    !isLive({ pid: service.pid, startTime: service.startTime })
  ) {
    state = "exited";
  } else if (service.publishedPort === undefined) {
    state = "healthy";
  } else if (listeners === null) {
    state = "unknown";
  } else {
    const members = new Set(processTree(service.pid).map((member) => member.pid));
    const owner = listeners.find((listener) => listener.port === service.publishedPort);
    state = owner !== undefined && members.has(owner.pid) ? "healthy" : "unhealthy";
  }
  const endpointRecords = record.endpoints.filter(
    (candidate) => (candidate.workload ?? candidate.name) === service.name,
  );
  const locallyRouted = new Set(effectiveLocalRouteServices(record, config));
  const endpoints = endpointRecords.map((endpoint) => ({
    name: endpoint.name,
    workload: endpoint.workload,
    binding: endpoint.binding,
    kind: endpoint.kind,
    host: endpoint.host,
    port: endpoint.port,
    url: endpoint.url,
    localUrl: locallyRouted.has(endpoint.name) && localRouterUsable
      ? `https://${resolvedLocalRouteHostname(record, endpoint.name, config)}`
      : undefined,
    publicUrl: endpoint.publicUrl,
  }));
  return {
    name: service.name,
    backend: service.backend,
    state,
    publishedPort: service.publishedPort,
    endpoint: endpoints[0],
    endpoints,
  };
}

function deriveFleetPhase(record: StackRecord, services: FleetServiceView[]): FleetStackPhase {
  if (record.state === "starting" && record.starter !== undefined && isLive(record.starter)) {
    return "starting";
  }
  if (services.length === 0) return "stopped";
  if (services.every((service) => service.state === "healthy")) return "up";
  if (services.every((service) => service.state === "exited")) return "stopped";
  if (services.some((service) => service.state === "unknown")) return "unknown";
  return "degraded";
}

function syntheticFleetStack(identity: StackIdentity, phase: "queued" | "reserved"): FleetStackView {
  return { ...identity, phase, services: [] };
}

function reservationIdentity(
  reservation: StackReservation,
  records: StackRecord[],
): StackIdentity | null {
  if (reservation.identity !== undefined) return reservation.identity;
  const record = records.find((candidate) => candidate.project === reservation.project);
  if (record?.repoId === undefined) return null;
  return {
    project: record.project,
    repoId: record.repoId,
    repo: record.repo,
    branch: record.branch,
    worktree: record.worktree,
  };
}

/** Collect one sanitized repository Fleet snapshot with a single machine-wide Docker query. */
export async function collectFleetSnapshot(
  repoId: RepoId,
  admission: FleetAdmissionSource,
): Promise<FleetSnapshot> {
  const mirrorResult = readManagedMirrors();
  const machineConfig = readHestiaMachineConfig();
  const routerStatus = await readHestiaRouterStatus();
  const localRouterUsable = routerStatus.installed && routerStatus.running && routerStatus.trusted;
  const docker = await collectDockerServiceSnapshot();
  const warnings = [...mirrorResult.warnings, ...machineConfig.warnings];
  if (docker.warning !== undefined) warnings.push(docker.warning);
  const attributed: StackRecord[] = [];
  for (const record of mirrorResult.records) {
    const attributedRepoId = await attributeLegacyRepoId(record);
    if (attributedRepoId === null) {
      if (record.repoId === undefined) warnings.push(`Fleet excluded unattributed legacy mirror ${record.project}`);
      continue;
    }
    record.repoId = attributedRepoId;
    attributed.push(record);
  }

  let listeners: Listener[] | null = [];
  if (attributed.some((record) => record.services.some((service) =>
    service.backend !== "docker" && service.publishedPort !== undefined,
  ))) {
    try {
      listeners = await allListeners();
    } catch (error) {
      listeners = null;
      warnings.push(`Fleet port ownership probe unavailable: ${(error as Error).message}`);
    }
  }

  const liveMirroredProjects = new Set<string>();
  for (const record of attributed) {
    try {
      if (listPidfiles(mirrorProcsDir(record.project)).some(
        (pidfile) => pidfile.backend !== "tunnel" && isLive(pidfile),
      )) {
        liveMirroredProjects.add(record.project);
      }
    } catch {
      warnings.push(`Fleet pidfile mirror unreadable for ${record.project}`);
    }
  }

  const allStackViews: FleetStackView[] = [];
  for (const record of attributed) {
    const services = await Promise.all(
      record.services.map((service) => observeFleetService(
        record,
        service,
        docker,
        listeners,
        machineConfig.config,
        localRouterUsable,
      )),
    );
    const derivedPhase = deriveFleetPhase(record, services);
    allStackViews.push({
      project: record.project,
      repoId: record.repoId!,
      repo: record.repo,
      branch: record.branch,
      worktree: record.worktree,
      phase: derivedPhase === "stopped" && liveMirroredProjects.has(record.project)
        ? "degraded"
        : derivedPhase,
      services,
      createdAt: record.createdAt,
    });
  }
  const stackViews = allStackViews.filter((stack) => stack.repoId === repoId);

  const recordedProjects = new Set(stackViews.map((stack) => stack.project));
  const reservations = admission.ledger.reservationSnapshot();
  for (const reservation of reservations) {
    const identity = reservationIdentity(reservation, attributed);
    if (identity?.repoId === repoId) {
      const existing = stackViews.find((stack) => stack.project === identity.project);
      if (existing?.phase === "stopped") existing.phase = "reserved";
      else if (existing === undefined) {
        stackViews.push(syntheticFleetStack(identity, "reserved"));
        recordedProjects.add(identity.project);
      }
    }
  }
  const queued = admission.queuedIdentitySnapshot();
  for (const identity of queued) {
    if (identity.repoId === repoId) {
      const existing = stackViews.find((stack) => stack.project === identity.project);
      if (existing !== undefined && ["stopped", "reserved"].includes(existing.phase)) {
        existing.phase = "queued";
      } else if (existing === undefined) {
        stackViews.push(syntheticFleetStack(identity, "queued"));
        recordedProjects.add(identity.project);
      }
    }
  }

  stackViews.sort((left, right) => left.project.localeCompare(right.project));
  const slotBearingProjects = new Set<string>();
  for (const [index, record] of attributed.entries()) {
    const view = allStackViews[index];
    const observedNonTunnel = view?.services.some(
      (service) => service.backend !== "tunnel" && service.state !== "exited",
    ) ?? false;
    const liveStarter = record.state === "starting" &&
      record.starter !== undefined && isLive(record.starter);
    if (observedNonTunnel || liveStarter || liveMirroredProjects.has(record.project)) {
      slotBearingProjects.add(record.project);
    }
  }
  const live = allStackViews.filter((stack) =>
    slotBearingProjects.has(stack.project) &&
    !["queued", "reserved", "stopped"].includes(stack.phase),
  ).length;
  const allRecordedProjects = new Set(attributed.map((record) => record.project));
  const unbackedReservations = reservations.filter(
    (reservation) => !allRecordedProjects.has(reservation.project),
  );
  const { maxStacks, warnings: capWarnings } = resolveMaxStacks();
  return {
    repoId,
    observedAt: new Date().toISOString(),
    capacity: {
      maxStacks,
      live,
      reserved: unbackedReservations.length,
      queued: queued.length,
    },
    stacks: stackViews,
    warnings: [...capWarnings, ...warnings].sort(),
  };
}

function semanticFleetSnapshot(snapshot: FleetSnapshot): string {
  return JSON.stringify({
    repoId: snapshot.repoId,
    capacity: snapshot.capacity,
    stacks: snapshot.stacks,
    warnings: snapshot.warnings,
  });
}

/** One overlap-guarded Fleet monitor shared by every daemon subscriber. */
export class FleetMonitor {
  readonly #subscribers = new Map<RepoId, Set<LatestFleetChannel>>();
  readonly #semantic = new Map<RepoId, string>();
  readonly #latest = new Map<RepoId, FleetSnapshot>();
  readonly #refreshTimer: ReturnType<typeof setInterval>;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #refreshing = false;
  #dirty = false;
  #sequence = 0;

  constructor(
    readonly admission: FleetAdmissionSource,
    options: { refreshMs?: number; heartbeatMs?: number } = {},
  ) {
    this.#refreshTimer = setInterval(
      () => void this.refreshFleet(),
      options.refreshMs ?? DEFAULT_REFRESH_MS,
    );
    this.#heartbeatTimer = setInterval(
      () => this.#broadcastHeartbeat(),
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
  }

  /** Subscribe to full Fleet snapshots with latest-only backpressure. */
  subscribe(repoId: RepoId, signal?: AbortSignal): AsyncIterable<FleetEnvelope> {
    const channel = new LatestFleetChannel();
    const channels = this.#subscribers.get(repoId) ?? new Set<LatestFleetChannel>();
    channels.add(channel);
    this.#subscribers.set(repoId, channels);
    const latest = this.#latest.get(repoId);
    if (latest !== undefined) {
      channel.push({ type: "snapshot", sequence: ++this.#sequence, snapshot: latest });
    }
    void this.refreshFleet();
    const close = () => channel.close();
    signal?.addEventListener("abort", close, { once: true });
    const monitor = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const result = await channel.next();
            if (result.done) return;
            yield result.value;
          }
        } finally {
          signal?.removeEventListener("abort", close);
          channel.close();
          const active = monitor.#subscribers.get(repoId);
          active?.delete(channel);
          if (active?.size === 0) monitor.#subscribers.delete(repoId);
        }
      },
    };
  }

  /** Refresh every subscribed repository once; overlapping requests coalesce. */
  async refreshFleet(): Promise<void> {
    if (this.#subscribers.size === 0) return;
    if (this.#refreshing) {
      this.#dirty = true;
      return;
    }
    this.#refreshing = true;
    try {
      do {
        this.#dirty = false;
        for (const repoId of this.#subscribers.keys()) {
          const snapshot = await collectFleetSnapshot(repoId, this.admission);
          const semantic = semanticFleetSnapshot(snapshot);
          if (this.#semantic.get(repoId) === semantic) continue;
          this.#semantic.set(repoId, semantic);
          this.#latest.set(repoId, snapshot);
          const frame: FleetEnvelope = {
            type: "snapshot",
            sequence: ++this.#sequence,
            snapshot,
          };
          for (const channel of this.#subscribers.get(repoId) ?? []) channel.push(frame);
        }
      } while (this.#dirty);
    } finally {
      this.#refreshing = false;
    }
  }

  /** Stop Fleet polling and close every active subscription. */
  stop(): void {
    clearInterval(this.#refreshTimer);
    clearInterval(this.#heartbeatTimer);
    for (const channels of this.#subscribers.values()) {
      for (const channel of channels) channel.close();
    }
    this.#subscribers.clear();
  }

  #broadcastHeartbeat(): void {
    const frame: FleetEnvelope = {
      type: "heartbeat",
      sequence: ++this.#sequence,
      at: new Date().toISOString(),
    };
    for (const channels of this.#subscribers.values()) {
      for (const channel of channels) channel.push(frame);
    }
  }
}
