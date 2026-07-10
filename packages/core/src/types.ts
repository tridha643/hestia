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
  /** Docker-assigned ephemeral host port. */
  publishedPort?: number;
  containerId?: string;
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
  /** Paths hestia wrote, so `down` works even if the worktree is deleted. */
  composeFile: string;
  overrideFile: string;
}

export interface UpOptions {
  /** Restrict to a subset of the configured services. */
  services?: string[];
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

export class HestiaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HestiaError";
    this.code = code;
  }
}
