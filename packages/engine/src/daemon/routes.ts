import {
  type DaemonHealth,
  type DaemonStateView,
  type FleetEnvelope,
  type LogLine,
  type LogsOptions,
  type RepoId,
  type StackIdentity,
} from "@hestia/core";
import { readRequestTextWithLimit } from "@hunk/session-broker-core";
import { readMirrorState } from "../state.ts";
import { FleetMonitor } from "./fleet-monitor.ts";
import { SlotLedger, resolveMaxStacks } from "./slots.ts";

export const HESTIAD_PROTOCOL_VERSION = 4;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_LOG_STREAMS = 16;
const MAX_LOG_TAIL = 200;

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
  identity: StackIdentity;
  holder: Holder;
  resolve(result: AcquireResult): void;
  timer: ReturnType<typeof setTimeout>;
}

function admissionIdentity(identity: StackIdentity | string): StackIdentity {
  if (typeof identity !== "string") return identity;
  return {
    project: identity,
    repoId: "repo-0000000000000000" as RepoId,
    repo: "legacy",
    branch: identity,
    worktree: `/legacy/${identity}`,
  };
}

/** Machine-wide FIFO admission whose expensive occupancy probes never serve Fleet readers. */
export class Admission {
  #queue: Waiter[] = [];
  #cachedState: DaemonStateView = {
    maxStacks: resolveMaxStacks().maxStacks,
    live: [],
    reserved: [],
    queued: [],
    warnings: resolveMaxStacks().warnings,
  };
  #mutex: Promise<unknown> = Promise.resolve();

  constructor(readonly ledger: SlotLedger) {}

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    this.#mutex = next.catch(() => {});
    return next;
  }

  async acquire(
    input: StackIdentity | string,
    holder: Holder,
    waitMs: number,
  ): Promise<AcquireResult> {
    const identity = admissionIdentity(input);
    const first = await this.#locked(() => this.#try(identity, holder));
    if (first.granted || waitMs <= 0) return first;
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = {
        identity,
        holder,
        resolve,
        timer: setTimeout(() => {
          this.#queue = this.#queue.filter((candidate) => candidate !== waiter);
          resolve({ granted: false, live: first.live });
        }, waitMs),
      };
      this.#queue.push(waiter);
    });
  }

  /** Remove a waiter whose long-polling CLI disconnected. */
  forget(identity: StackIdentity, holder: Holder): void {
    this.#queue = this.#queue.filter((waiter) => {
      const match =
        waiter.identity.project === identity.project &&
        waiter.identity.repoId === identity.repoId &&
        waiter.holder.pid === holder.pid &&
        waiter.holder.startTime === holder.startTime;
      if (match) clearTimeout(waiter.timer);
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

  /** Copy queue identities synchronously without entering the occupancy mutex. */
  queuedIdentitySnapshot(): StackIdentity[] {
    return this.#queue.map((waiter) => ({ ...waiter.identity }));
  }

  /** Project-only queue view retained for daemon status and compatibility. */
  queuedProjects(): string[] {
    return this.queuedIdentitySnapshot().map((identity) => identity.project);
  }

  /** Constant-time cached view for liveness checks; never probes Docker or mutates reservations. */
  healthSnapshot(): DaemonStateView {
    return {
      ...this.#cachedState,
      live: [...this.#cachedState.live],
      reserved: [...this.#cachedState.reserved],
      queued: this.queuedProjects(),
      warnings: [...this.#cachedState.warnings],
    };
  }

  #cache(occupancy: Awaited<ReturnType<SlotLedger["occupancy"]>>): void {
    const { maxStacks, warnings } = resolveMaxStacks();
    this.#cachedState = {
      maxStacks,
      live: [...occupancy.live],
      reserved: [...occupancy.reserved],
      queued: this.queuedProjects(),
      warnings: [...warnings, ...occupancy.warnings],
    };
  }

  async #try(identity: StackIdentity, holder: Holder): Promise<AcquireResult> {
    const { maxStacks } = resolveMaxStacks();
    const occupancy = await this.ledger.occupancy();
    this.#cache(occupancy);
    if (
      occupancy.live.includes(identity.project) ||
      occupancy.reserved.includes(identity.project)
    ) {
      return { granted: true, live: occupancy.live };
    }
    if (occupancy.live.length + occupancy.reserved.length < maxStacks) {
      this.ledger.reserveFor(identity, holder);
      return { granted: true, live: occupancy.live };
    }
    return { granted: false, live: occupancy.live };
  }

  async #pump(): Promise<void> {
    if (this.#queue.length === 0) return;
    const { maxStacks } = resolveMaxStacks();
    const occupancy = await this.ledger.occupancy();
    this.#cache(occupancy);
    let used = occupancy.live.length + occupancy.reserved.length;
    const granted: Waiter[] = [];
    for (const waiter of this.#queue) {
      if (
        occupancy.live.includes(waiter.identity.project) ||
        occupancy.reserved.includes(waiter.identity.project)
      ) {
        granted.push(waiter);
      }
    }
    for (const waiter of this.#queue) {
      if (granted.includes(waiter)) continue;
      if (used >= maxStacks) break;
      this.ledger.reserveFor(waiter.identity, waiter.holder);
      used += 1;
      granted.push(waiter);
    }
    if (granted.length === 0) return;
    this.#queue = this.#queue.filter((waiter) => !granted.includes(waiter));
    for (const waiter of granted) {
      clearTimeout(waiter.timer);
      waiter.resolve({ granted: true, live: occupancy.live });
    }
  }

  /** Legacy daemon status view; probes run outside the admission mutex. */
  async stateView(): Promise<DaemonStateView> {
    const { maxStacks, warnings } = resolveMaxStacks();
    const occupancy = await this.ledger.occupancy();
    this.#cache(occupancy);
    return {
      maxStacks,
      live: occupancy.live,
      reserved: occupancy.reserved,
      queued: this.queuedProjects(),
      warnings: [...warnings, ...occupancy.warnings],
    };
  }
}

export interface DaemonRouteDependencies {
  token: string;
  fleet: FleetMonitor;
  routerPort: number;
  gatewaySocket: string;
  refreshLocalRoutes(): Promise<void>;
  logsProject(project: string, options: LogsOptions): AsyncIterable<LogLine>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function authorized(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function isProject(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
}

function isRepoId(value: unknown): value is RepoId {
  return typeof value === "string" && /^repo-[a-f0-9]{16}$/.test(value);
}

function isService(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isStackIdentity(value: unknown): value is StackIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<StackIdentity>;
  return (
    isProject(identity.project) &&
    isRepoId(identity.repoId) &&
    typeof identity.repo === "string" && identity.repo.length > 0 && identity.repo.length <= 256 &&
    typeof identity.branch === "string" && identity.branch.length > 0 && identity.branch.length <= 512 &&
    typeof identity.worktree === "string" && identity.worktree.startsWith("/") && identity.worktree.length <= 4096
  );
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("content-type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new Error("request body exceeds 16 KiB");
  }
  const source = await readRequestTextWithLimit(request, MAX_JSON_BODY_BYTES);
  return JSON.parse(source) as T;
}

function ndjsonResponse<T>(
  request: Request,
  createSource: (signal: AbortSignal) => AsyncIterable<T>,
  finished?: () => void,
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let iterator: AsyncIterator<T> | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    controller.abort();
    request.signal.removeEventListener("abort", abort);
    await iterator?.return?.();
    finished?.();
  };
  const abort = () => void cleanup();
  request.signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        iterator ??= createSource(controller.signal)[Symbol.asyncIterator]();
        const result = await iterator.next();
        if (result.done) {
          await cleanup();
          streamController.close();
          return;
        }
        streamController.enqueue(encoder.encode(`${JSON.stringify(result.value)}\n`));
      } catch (error) {
        await cleanup();
        streamController.error(error);
      }
    },
    async cancel() {
      await cleanup();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

/** Authenticated hestiad HTTP routes layered before the vendored broker router. */
export function createRoutes(
  admission: Admission,
  startedAt: string,
  dependencies: DaemonRouteDependencies,
): (request: Request) => Promise<Response | undefined> | Response | undefined {
  let activeLogStreams = 0;
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/hestia/")) return undefined;
    if (!authorized(request, dependencies.token)) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/hestia/health" && request.method === "GET") {
      const state = admission.healthSnapshot();
      const health: DaemonHealth = {
        ok: true,
        pid: process.pid,
        protocolVersion: HESTIAD_PROTOCOL_VERSION,
        maxStacks: state.maxStacks,
        live: state.live.length,
        queued: state.queued.length,
        startedAt,
        routerPort: dependencies.routerPort,
        gatewaySocket: dependencies.gatewaySocket,
        warnings: state.warnings,
      };
      return json(health);
    }

    if (url.pathname === "/hestia/state" && request.method === "GET") {
      return json(await admission.stateView());
    }

    if (url.pathname === "/hestia/router/reconcile" && request.method === "POST") {
      await dependencies.refreshLocalRoutes();
      return json({ ok: true, routerPort: dependencies.routerPort });
    }

    if (url.pathname === "/hestia/fleet" && request.method === "GET") {
      const repoId = url.searchParams.get("repoId");
      if (!isRepoId(repoId)) return json({ error: "repoId is invalid" }, 400);
      return ndjsonResponse<FleetEnvelope>(request, (signal) =>
        dependencies.fleet.subscribe(repoId, signal),
      );
    }

    if (url.pathname === "/hestia/logs" && request.method === "GET") {
      const project = url.searchParams.get("project");
      const service = url.searchParams.get("service");
      const tailSource = url.searchParams.get("tail") ?? "50";
      const tail = Number(tailSource);
      if (!isProject(project)) return json({ error: "project is invalid" }, 400);
      if (!isService(service)) return json({ error: "service is invalid" }, 400);
      if (!Number.isInteger(tail) || tail < 0 || tail > MAX_LOG_TAIL) {
        return json({ error: `tail must be an integer from 0 to ${MAX_LOG_TAIL}` }, 400);
      }
      const record = readMirrorState(project);
      if (record === null) return json({ error: `no mirror for project ${project}` }, 404);
      if (!record.services.some((candidate) => candidate.name === service)) {
        return json({ error: `service ${service} is not in project ${project}` }, 404);
      }
      if (activeLogStreams >= MAX_LOG_STREAMS) {
        return json({ error: "too many active log streams" }, 429);
      }
      activeLogStreams += 1;
      return ndjsonResponse<LogLine>(
        request,
        (signal) => dependencies.logsProject(project, {
          services: [service],
          follow: true,
          tail,
          signal,
        }),
        () => { activeLogStreams -= 1; },
      );
    }

    if (url.pathname === "/hestia/acquire" && request.method === "POST") {
      let body: { identity?: unknown; pid?: unknown; startTime?: unknown; waitMs?: unknown };
      try {
        body = await parseJsonBody(request);
      } catch (error) {
        return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
      }
      if (!isStackIdentity(body.identity)) return json({ error: "identity is invalid" }, 400);
      const holder = {
        pid: typeof body.pid === "number" && Number.isInteger(body.pid) ? body.pid : 0,
        startTime: typeof body.startTime === "string" && body.startTime.length <= 128
          ? body.startTime
          : "",
      };
      const waitMs = typeof body.waitMs === "number" && Number.isFinite(body.waitMs) && body.waitMs > 0
        ? Math.min(body.waitMs, 24 * 60 * 60 * 1_000)
        : 0;
      const onAbort = () => admission.forget(body.identity as StackIdentity, holder);
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return json(await admission.acquire(body.identity, holder, waitMs));
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    }

    if (url.pathname === "/hestia/release" && request.method === "POST") {
      let body: { project?: unknown };
      try {
        body = await parseJsonBody(request);
      } catch (error) {
        return json({ error: `invalid JSON body: ${(error as Error).message}` }, 400);
      }
      if (!isProject(body.project)) return json({ error: "project is invalid" }, 400);
      await admission.release(body.project);
      return json({ ok: true });
    }

    return json({ error: `unknown route ${url.pathname}` }, 404);
  };
}
