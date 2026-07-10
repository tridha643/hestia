import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HestiaError, type DaemonHealth, type DaemonStateView } from "@hestia/core";
import { startTimeOf } from "../proc/pidfile.ts";
import type { AcquireResult } from "./routes.ts";
import { daemonDir } from "./slots.ts";

/** Discovery metadata the daemon writes next to its pidfile. */
export interface DaemonJson {
  pid: number;
  port: number;
  protocolVersion: number;
  startedAt: string;
}

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

async function get<T>(port: number, path: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchHealth(port: number, timeoutMs = 1_000): Promise<DaemonHealth | null> {
  return get<DaemonHealth>(port, "/hestia/health", timeoutMs);
}

export function fetchState(port: number, timeoutMs = 2_000): Promise<DaemonStateView | null> {
  return get<DaemonStateView>(port, "/hestia/state", timeoutMs);
}

/**
 * Request a slot. `waitMs > 0` long-polls the daemon-side FIFO queue; the
 * fetch timeout is padded so the daemon's own waiter timeout answers first.
 */
export async function acquireSlot(
  port: number,
  project: string,
  waitMs: number,
): Promise<AcquireResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hestia/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project,
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // sweep reconciles
  }
}
