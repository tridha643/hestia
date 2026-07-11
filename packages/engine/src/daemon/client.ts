import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HestiaError,
  type DaemonHealth,
  type DaemonStateView,
  type FleetEnvelope,
  type LogLine,
  type RepoId,
  type StackIdentity,
} from "@hestia/core";
import { isLive, readPidfile, startTimeOf } from "../proc/pidfile.ts";
import type { AcquireResult } from "./routes.ts";
import { daemonDir } from "./slots.ts";

/** Discovery metadata the daemon writes next to its pidfile. */
export interface DaemonJson {
  pid: number;
  port: number;
  protocolVersion: number;
  startedAt: string;
  /** Per-daemon bearer token; absent only on legacy protocol-v1 discovery files. */
  token?: string;
}

const DAEMON_PIDFILE_NAME = "hestiad";

export function daemonJsonPath(): string {
  return join(daemonDir(), "daemon.json");
}

export function readDaemonJson(): DaemonJson | null {
  const p = daemonJsonPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonJson;
  } catch {
    return null;
  }
}

/** Authorization headers for the daemon currently published on this port. */
export function daemonAuthHeaders(port: number): Record<string, string> {
  const discovery = readDaemonJson();
  const pidfile = readPidfile(daemonDir(), DAEMON_PIDFILE_NAME);
  return discovery?.port === port &&
      discovery.token !== undefined &&
      pidfile?.pid === discovery.pid &&
      isLive(pidfile)
    ? { authorization: `Bearer ${discovery.token}` }
    : {};
}

async function get<T>(port: number, path: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: daemonAuthHeaders(port),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchHealth(port: number, timeoutMs = 1_000): Promise<DaemonHealth | null> {
  const discovery = readDaemonJson();
  if (discovery?.port !== port) return null;
  const health = await get<DaemonHealth>(port, "/hestia/health", timeoutMs);
  return health?.pid === discovery.pid ? health : null;
}

export function fetchState(port: number, timeoutMs = 2_000): Promise<DaemonStateView | null> {
  return get<DaemonStateView>(port, "/hestia/state", timeoutMs);
}

const MAX_NDJSON_FRAME_BYTES = 1024 * 1024;

async function* streamDaemonNdjson<T>(
  port: number,
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: daemonAuthHeaders(port),
    signal,
  });
  if (!response.ok || response.body === null) {
    throw new HestiaError(
      "daemon-unreachable",
      `hestiad stream ${path} failed with HTTP ${response.status}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      if (Buffer.byteLength(pending) > MAX_NDJSON_FRAME_BYTES && !pending.includes("\n")) {
        throw new HestiaError("daemon-unreachable", "hestiad NDJSON frame exceeds 1 MiB");
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        if (Buffer.byteLength(line) > MAX_NDJSON_FRAME_BYTES) {
          throw new HestiaError("daemon-unreachable", "hestiad NDJSON frame exceeds 1 MiB");
        }
        yield JSON.parse(line) as T;
      }
    }
    pending += decoder.decode();
    if (pending.trim() !== "") {
      if (Buffer.byteLength(pending) > MAX_NDJSON_FRAME_BYTES) {
        throw new HestiaError("daemon-unreachable", "hestiad NDJSON frame exceeds 1 MiB");
      }
      yield JSON.parse(pending) as T;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Subscribe to authenticated full-state Fleet snapshots and daemon heartbeats. */
export function streamDaemonFleet(
  port: number,
  repoId: RepoId,
  signal?: AbortSignal,
): AsyncIterable<FleetEnvelope> {
  return streamDaemonNdjson<FleetEnvelope>(
    port,
    `/hestia/fleet?repoId=${encodeURIComponent(repoId)}`,
    signal,
  );
}

/** Follow one selected service through the daemon's bounded Phase 5 log adapter. */
export function streamDaemonServiceLogs(
  port: number,
  project: string,
  service: string,
  tail = 50,
  signal?: AbortSignal,
): AsyncIterable<LogLine> {
  const query = new URLSearchParams({ project, service, tail: String(tail) });
  return streamDaemonNdjson<LogLine>(port, `/hestia/logs?${query}`, signal);
}

/**
 * Request a slot. `waitMs > 0` long-polls the daemon-side FIFO queue; the
 * fetch timeout is padded so the daemon's own waiter timeout answers first.
 */
export async function acquireSlot(
  port: number,
  identity: StackIdentity,
  waitMs: number,
): Promise<AcquireResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hestia/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", ...daemonAuthHeaders(port) },
      body: JSON.stringify({
        identity,
        pid: process.pid,
        startTime: startTimeOf(process.pid) ?? "",
        waitMs,
      }),
      signal: AbortSignal.timeout(waitMs + 5_000),
    });
    if (!res.ok) {
      throw new HestiaError("daemon-unreachable", `daemon rejected acquire: HTTP ${res.status}`);
    }
    return (await res.json()) as AcquireResult;
  } catch (err) {
    if (err instanceof HestiaError) throw err;
    throw new HestiaError(
      "daemon-unreachable",
      `could not reach hestiad on 127.0.0.1:${port}: ${(err as Error).message}`,
    );
  }
}

/** Best-effort: a gone daemon self-heals on its next sweep — never fail a down. */
export async function releaseSlot(port: number, project: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/hestia/release`, {
      method: "POST",
      headers: { "content-type": "application/json", ...daemonAuthHeaders(port) },
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // sweep reconciles
  }
}
