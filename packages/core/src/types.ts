// Shared types + the engine seam. Fixed once here so the MVP CLI (now) and a
// future daemon (later) both drive the same IsolationEngine without a rewrite.

export type ServiceBackend = "docker" | "proc" | "wrangler" | "tunnel";
export type ServiceState =
  | "pending"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "exited";
export type StackState =
  | "queued"
  | "starting"
  | "up"
  | "degraded"
  | "stopping"
  | "stopped";

export interface Endpoint {
  /** Logical name, e.g. the service name. */
  name: string;
  host: string;
  port: number;
  url?: string;
  /**
   * Dormant in the MVP: the phase-3 named URL (svc.branch.repo.localhost).
   * Present from day one so consumers can key on it before the proxy exists.
   */
  reservedName?: string;
}

export interface ServiceRecord {
  name: string;
  backend: ServiceBackend;
  state: ServiceState;
  /** Container-side port that was published (docker backend). */
  containerPort?: number;
  /** Host port where the service is reachable (docker-assigned or proc bind-probed). */
  publishedPort?: number;
  containerId?: string;
  /** proc/wrangler backends: supervised process identity. */
  pid?: number;
  /** Process group id (== pid: detached spawn makes the child its own group leader). */
  pgid?: number;
  /** Verbatim `ps -o lstart=` output captured post-spawn — the PID-reuse guard. */
  startTime?: string;
  /** wrangler backend: probed inspector port injected via --inspector-port. */
  inspectorPort?: number;
  /** proc/wrangler backends: stdout+stderr log file. */
  logPath?: string;
  /** wrangler backend: the wrangler config this worker was started from. */
  configPath?: string;
}

/** Spec for a supervised host process (`hestia run` / the wrangler adapter). */
export interface ProcSpec {
  /** Required, deterministic identity within the stack. */
  name: string;
  /** Command argv. `{port}` tokens are substituted; `{{port}}` escapes a literal. */
  argv: string[];
  /** Working directory relative to the worktree root (default: the root). */
  cwd?: string;
  /** Extra env — highest precedence, agent intent always wins. */
  env?: Record<string, string>;
  /** "auto" (default): bind-probe a port, inject PORT + tokens. "none": skip. */
  port?: "auto" | "none";
  /** Shutdown signal for the process group. Default "term"; wrangler uses "int". */
  signal?: "term" | "int";
  readyTimeoutMs?: number;
  /** Prefix the spawn with the repo's varlock resolver (composition, not integration). */
  varlock?: boolean;
  backend?: "proc" | "wrangler";
  /** wrangler backend metadata carried into the ServiceRecord. */
  inspectorPort?: number;
  configPath?: string;
}

export interface StackRecord {
  /** Deterministic compose project name, e.g. "modem-salem". */
  project: string;
  repo: string;
  branch: string;
  worktree: string;
  state: StackState;
  services: ServiceRecord[];
  /** Resolved env block agents consume (DATABASE_URL, etc.). */
  env: Record<string, string>;
  endpoints: Endpoint[];
  createdAt: string;
  /**
   * Absent on procs-only stacks (a compose file is not required to `run`).
   * When present, `down` uses them; the ~/.hestia mirror keeps copies so
   * teardown works even if the worktree is deleted.
   */
  composeFile?: string;
  overrideFile?: string;
}

export interface UpOptions {
  /** Restrict to a subset of the configured services. */
  services?: string[];
  /** Auto-discover wrangler configs and supervise `wrangler dev` per config.
   * `true` = all discovered; string[] filters by path substring or worker name. */
  workers?: boolean | string[];
  /** Allow workers whose config declares `remote: true` bindings. */
  allowRemote?: boolean;
  /** Skip the foreign-process (global dev registry) preflight. */
  force?: boolean;
  /** Disable the automatic varlock env-resolution wrapper for workers. */
  noVarlock?: boolean;
}

export interface DownOptions {
  /** Also remove named volumes (data loss). Default keeps them. */
  destroy?: boolean;
}

export interface EngineHooks {
  onServiceState?(project: string, service: string, state: ServiceState): void;
  onEndpoint?(project: string, endpoint: Endpoint): void;
  onLog?(line: {
    project: string;
    service: string;
    stream: "stdout" | "stderr";
    text: string;
  }): void;
}

/**
 * The stable contract. The MVP implements up/down/status for the docker
 * compose backend; the rest are reserved for later efforts (proc/wrangler
 * backends, the daemon, the TUI) and throw NotImplemented until then.
 */
export interface IsolationEngine {
  up(worktree: string, opts?: UpOptions): Promise<StackRecord>;
  down(worktree: string, opts?: DownOptions): Promise<void>;
  status(worktree: string): Promise<StackRecord | null>;
  /** Supervise a host process as part of this worktree's stack. */
  run(worktree: string, spec: ProcSpec): Promise<StackRecord>;
  /** Stop one supervised proc. Idempotent: unknown/dead names succeed. */
  stopService(worktree: string, name: string): Promise<void>;
  /** Tear down by project name from the ~/.hestia mirror — works with the worktree gone. */
  downProject?(project: string, opts?: DownOptions): Promise<void>;

  // Reserved — declared so later work slots in without changing callers.
  restartService?(worktree: string, service: string): Promise<void>;
  adopt?(record: StackRecord): Promise<void>;
  probe?(worktree: string): Promise<ServiceRecord[]>;
  discoverOrphans?(): Promise<StackRecord[]>;
}

export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented in the MVP`);
    this.name = "NotImplemented";
  }
}

/**
 * Codes are the stable CLI contract (`--json` emits `{error: {code, message}}`).
 * Compose: config-missing · compose-failed · service-exited · ready-timeout.
 * Proc: lock-timeout · port-allocation-failed · proc-spawn-failed ·
 * proc-ready-timeout · proc-exited · name-conflict · ownership-tool-missing ·
 * varlock-missing. Wrangler: no-workers-found · wrangler-missing ·
 * worktree-busy · remote-binding-blocked · registry-leak.
 */
export class HestiaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HestiaError";
    this.code = code;
  }
}
