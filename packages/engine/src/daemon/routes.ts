import type { DaemonHealth, DaemonStateView } from "@hestia/core";
import { SlotLedger, resolveMaxStacks } from "./slots.ts";

export const HESTIAD_PROTOCOL_VERSION = 1;

export interface AcquireResult {
  granted: boolean;
  /** Projects currently holding slots — the stack-limit error payload. */
  live: string[];
}

interface Holder {
  pid: number;
  startTime: string;
}

interface Waiter {
  project: string;
  holder: Holder;
  resolve(r: AcquireResult): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Machine-wide admission. All occupancy math runs under a single in-process
 * mutex — two concurrent acquires must not both see "4 of 5" and both
 * reserve the fifth slot. Waiters are FIFO for FRESH slots; a waiter whose
 * project became live by another path is granted as a no-op out of order
 * (it needs no capacity, blocking it would head-of-line for nothing).
 */
export class Admission {
  #queue: Waiter[] = [];
  #mutex: Promise<unknown> = Promise.resolve();

  constructor(readonly ledger: SlotLedger) {}

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    this.#mutex = next.catch(() => {});
    return next;
  }

  async acquire(project: string, holder: Holder, waitMs: number): Promise<AcquireResult> {
    const first = await this.#locked(() => this.#try(project, holder));
    if (first.granted || waitMs <= 0) return first;
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = {
        project,
        holder,
        resolve,
        timer: setTimeout(() => {
          this.#queue = this.#queue.filter((w) => w !== waiter);
          resolve({ granted: false, live: first.live });
        }, waitMs),
      };
      this.#queue.push(waiter);
    });
  }

  /** Remove a waiter whose HTTP request went away (client abort/crash). */
  forget(project: string, holder: Holder): void {
    this.#queue = this.#queue.filter((w) => {
      const match =
        w.project === project &&
        w.holder.pid === holder.pid &&
        w.holder.startTime === holder.startTime;
      if (match) clearTimeout(w.timer);
      return !match;
    });
  }

  release(project: string): Promise<void> {
    return this.#locked(async () => {
      this.ledger.release(project);
      await this.#pump();
    });
  }

  /** Re-derive occupancy and grant whatever now fits. Called by the sweep. */
  pump(): Promise<void> {
    return this.#locked(() => this.#pump());
  }

  queuedProjects(): string[] {
    return this.#queue.map((w) => w.project);
  }

  async #try(project: string, holder: Holder): Promise<AcquireResult> {
    const { maxStacks } = resolveMaxStacks();
    const occ = await this.ledger.occupancy();
    if (occ.live.includes(project) || occ.reserved.includes(project)) {
      return { granted: true, live: occ.live };
    }
    if (occ.live.length + occ.reserved.length < maxStacks) {
      this.ledger.reserveFor(project, holder);
      return { granted: true, live: occ.live };
    }
    return { granted: false, live: occ.live };
  }

  async #pump(): Promise<void> {
    if (this.#queue.length === 0) return;
    const { maxStacks } = resolveMaxStacks();
    const occ = await this.ledger.occupancy();
    let used = occ.live.length + occ.reserved.length;
    const granted: Waiter[] = [];
    // Pass 1: no-op grants for projects that hold capacity already.
    // Pass 2: FIFO fresh grants while slots remain.
    for (const w of this.#queue) {
      if (occ.live.includes(w.project) || occ.reserved.includes(w.project)) {
        granted.push(w);
      }
    }
    for (const w of this.#queue) {
      if (granted.includes(w)) continue;
      if (used < maxStacks) {
        this.ledger.reserveFor(w.project, w.holder);
        used += 1;
        granted.push(w);
      } else break;
    }
    if (granted.length === 0) return;
    this.#queue = this.#queue.filter((w) => !granted.includes(w));
    for (const w of granted) {
      clearTimeout(w.timer);
      w.resolve({ granted: true, live: occ.live });
    }
  }

  async stateView(): Promise<DaemonStateView> {
    return this.#locked(async () => {
      const { maxStacks, warnings } = resolveMaxStacks();
      const occ = await this.ledger.occupancy();
      return {
        maxStacks,
        live: occ.live,
        reserved: occ.reserved,
        queued: this.queuedProjects(),
        warnings: [...warnings, ...occ.warnings],
      };
    });
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * hestia's routes on the broker's bun server. Runs BEFORE the broker's own
 * router (pinned in daemon-vendor.test.ts): return a Response for /hestia/*,
 * undefined for everything else so /health and the websocket path fall
 * through to the broker.
 */
export function createRoutes(
  admission: Admission,
  startedAt: string,
): (request: Request) => Promise<Response | undefined> | Response | undefined {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/hestia/")) return undefined;

    if (url.pathname === "/hestia/health" && request.method === "GET") {
      const state = await admission.stateView();
      const health: DaemonHealth = {
        ok: true,
        pid: process.pid,
        protocolVersion: HESTIAD_PROTOCOL_VERSION,
        maxStacks: state.maxStacks,
        live: state.live.length,
        queued: state.queued.length,
        startedAt,
        warnings: state.warnings,
      };
      return json(health);
    }

    if (url.pathname === "/hestia/state" && request.method === "GET") {
      return json(await admission.stateView());
    }

    if (url.pathname === "/hestia/acquire" && request.method === "POST") {
      let body: { project?: string; pid?: number; startTime?: string; waitMs?: number };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "expected a JSON body" }, 400);
      }
      if (typeof body.project !== "string" || body.project === "") {
        return json({ error: "project is required" }, 400);
      }
      const holder = {
        pid: typeof body.pid === "number" ? body.pid : 0,
        startTime: typeof body.startTime === "string" ? body.startTime : "",
      };
      const waitMs = typeof body.waitMs === "number" && body.waitMs > 0 ? body.waitMs : 0;
      // Drop the queue entry if the long-polling client goes away.
      const onAbort = () => admission.forget(body.project!, holder);
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return json(await admission.acquire(body.project, holder, waitMs));
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    }

    if (url.pathname === "/hestia/release" && request.method === "POST") {
      let body: { project?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: "expected a JSON body" }, 400);
      }
      if (typeof body.project !== "string" || body.project === "") {
        return json({ error: "project is required" }, 400);
      }
      await admission.release(body.project);
      return json({ ok: true });
    }

    return json({ error: `unknown route ${url.pathname}` }, 404);
  };
}
