import type {
  FleetEnvelope,
  FleetSnapshotEnvelope,
  FleetStackView,
  LogLine,
  RepoId,
} from "@hestia/core";
import {
  doctor,
  engine,
  ensureDaemon,
  streamDaemonFleet,
  streamDaemonServiceLogs,
  type DoctorRow,
} from "@hestia/engine";
import { ReconnectLogDeduper } from "./log-reconnect-deduper.ts";

function isFleetEnvelope(value: unknown): value is FleetEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<FleetEnvelope>;
  if (!Number.isInteger(frame.sequence)) return false;
  if (frame.type === "heartbeat") return typeof frame.at === "string";
  if (frame.type !== "snapshot") return false;
  const snapshot = (frame as Partial<FleetSnapshotEnvelope>).snapshot;
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    Array.isArray(snapshot.stacks) &&
    Array.isArray(snapshot.warnings)
  );
}

function isLogLine(value: unknown): value is LogLine {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Partial<LogLine>;
  return (
    typeof line.project === "string" &&
    typeof line.service === "string" &&
    typeof line.source === "string" &&
    typeof line.text === "string"
  );
}

async function reconnectDelay(attempt: number, signal: AbortSignal): Promise<void> {
  const delay = Math.min(4_000, 250 * 2 ** Math.min(attempt, 4));
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** TUI data source owning daemon discovery, reconnects, logs, doctor, and safe down. */
export class DaemonFleetSource {
  readonly #lifetime = new AbortController();

  constructor(readonly repoId: RepoId) {}

  /** Follow full Fleet snapshots, rediscovering a restarted daemon and its new token/port. */
  async *fleet(signal: AbortSignal): AsyncGenerator<FleetEnvelope> {
    let attempt = 0;
    while (!signal.aborted && !this.#lifetime.signal.aborted) {
      try {
        const daemon = await ensureDaemon();
        for await (const frame of streamDaemonFleet(daemon.port, this.repoId, signal)) {
          if (!isFleetEnvelope(frame)) throw new Error("Fleet protocol frame is invalid");
          attempt = 0;
          yield frame;
        }
        if (!signal.aborted) throw new Error("Fleet stream ended");
      } catch (error) {
        if (signal.aborted || this.#lifetime.signal.aborted) return;
        yield {
          type: "heartbeat",
          sequence: -1,
          at: `disconnected: ${(error as Error).message}`,
        };
        await reconnectDelay(attempt++, signal);
      }
    }
  }

  /** Follow one service, retaining the UI ring while reconnecting with a small backfill. */
  async *logs(
    project: string,
    service: string,
    signal: AbortSignal,
  ): AsyncGenerator<LogLine> {
    let attempt = 0;
    let connectedBefore = false;
    const deduper = new ReconnectLogDeduper(50);
    while (!signal.aborted && !this.#lifetime.signal.aborted) {
      const connectedAt = Date.now();
      try {
        const daemon = await ensureDaemon();
        if (connectedBefore) {
          deduper.beginReconnect();
        }
        connectedBefore = true;
        for await (const line of streamDaemonServiceLogs(daemon.port, project, service, 50, signal)) {
          if (!isLogLine(line)) throw new Error("log protocol frame is invalid");
          for (const freshLine of deduper.push(line)) yield freshLine;
        }
        if (!signal.aborted) throw new Error("log stream ended");
      } catch {
        if (signal.aborted || this.#lifetime.signal.aborted) return;
        if (Date.now() - connectedAt >= 10_000) attempt = 0;
        await reconnectDelay(attempt++, signal);
      }
    }
  }

  /** Run report-only diagnostics for one extant managed worktree. */
  diagnose(worktree: string): Promise<DoctorRow[]> {
    return doctor(worktree);
  }

  /** Tear down one managed project while always retaining named volumes. */
  down(stack: FleetStackView): Promise<void> {
    if (stack.createdAt === undefined) {
      return Promise.reject(new Error(`stack ${stack.project} has no stable incarnation timestamp`));
    }
    return engine.downProject(stack.project, {
      destroy: false,
      expectedStack: {
        repoId: stack.repoId,
        worktree: stack.worktree,
        createdAt: stack.createdAt,
      },
    });
  }

  /** Stop every reconnect loop owned by this TUI process. */
  stop(): void {
    this.#lifetime.abort();
  }
}
