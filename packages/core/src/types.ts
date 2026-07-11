// Shared types + the engine seam. Fixed once here so the MVP CLI (now) and a
// future daemon (later) both drive the same IsolationEngine without a rewrite.

export type ServiceBackend = "docker" | "proc" | "wrangler" | "tunnel";
export type ServiceState =
  | "pending"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "exited";
export type StackState =
  | "queued"
  | "starting"
  | "up"
  | "degraded"
  | "stopping"
  | "stopped";

/** Stable identity for one physical git repository, shared by all its worktrees. */
export type RepoId = string & { readonly __repoId: unique symbol };

/** Current on-disk state schema. Bump only with an explicit compatibility policy. */
export const STATE_SCHEMA_VERSION = 1 as const;

/** Complete repository-scoped stack identity carried through daemon admission. */
export interface StackIdentity {
  project: string;
  repoId: RepoId;
  repo: string;
  branch: string;
  worktree: string;
}

export interface Endpoint {
  /** Logical name, e.g. the service name. */
  name: string;
  host: string;
  port: number;
  url?: string;
  /** Stable Hestia-managed HTTPS URL for a selected HTTP service. */
  localUrl?: string;
  /** Deterministic local hostname reserved before its optional route activates. */
  reservedName?: string;
  /**
   * Public URL once the service is exposed through a cloudflare tunnel
   * (named: https://<hostname>; quick: the *.trycloudflare.com URL).
   * Enriches the existing endpoint entry — never a second same-name entry.
   */
  publicUrl?: string;
  /** User-facing endpoint alias; defaults to name on legacy records. */
  alias?: string;
  /** Owning workload name. */
  workload?: string;
  /** Canonical target/protocol selector, e.g. 3000/tcp or main/tcp. */
  binding?: string;
  kind?: "http" | "tcp" | "udp";
  /** Portable or machine-local default route intent from configuration. */
  local?: boolean;
}

/** One concrete published socket owned by a workload. */
export interface PortBinding {
  id: string;
  target: string;
  protocol: "tcp" | "udp";
  publishedPort: number;
}

/** Sticky per-worktree request to publish one service through the local HTTPS router. */
export interface LocalRouteIntent {
  service: string;
  selector?: string;
  alias?: string;
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
  /** tunnel backend (quick mode): the stack service this tunnel fronts. */
  originService?: string;
  /** tunnel backend: endpoint alias independently selected from the workload. */
  originEndpoint?: string;
  /** Every published socket; legacy scalar port fields mirror a unique binding. */
  bindings?: PortBinding[];
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
  backend?: "proc" | "wrangler" | "tunnel";
  /** wrangler backend metadata carried into the ServiceRecord. */
  inspectorPort?: number;
  configPath?: string;
  /** tunnel backend (quick mode): the stack service this tunnel fronts. */
  originService?: string;
  originEndpoint?: string;
}

/** One public hostname → local origin rule owned by a stack (named mode). */
export interface TunnelExposure {
  /** Stack service this rule fronts. */
  service: string;
  /** User-facing endpoint name used for URL/env projection and gateway authority. */
  alias?: string;
  /** Exact target/protocol binding; absent only on legacy single-port records. */
  binding?: string;
  /** Single-label public hostname under the zone, e.g. tri-salem-slack.modem.codes. */
  hostname: string;
  /** Origin port the rule pointed at when last generated — rotation detector. */
  originPort: number;
  /** Forward the public hostname as Host instead of rewriting to the origin. */
  keepHostHeader?: boolean;
}

/**
 * A stack's adoption of the (machine-global) named tunnel. The tunnel itself
 * is never created or deleted by hestia — it adopts an existing one by name,
 * and every mutating cloudflared call targets `uuid`, never the name.
 */
export interface TunnelRef {
  name: string;
  uuid: string;
  zone: string;
  credFile: string;
  exposures: TunnelExposure[];
}

/**
 * Identity of the CLI process holding a stack's admission slot while its
 * first services start (provisional `state: "starting"` records). A dead
 * holder (pid+lstart mismatch) is how the daemon sweep frees slots leaked by
 * a CLI crash mid-`up` — the same identity scheme as pidfiles.
 */
export interface StackStarter {
  pid: number;
  startTime: string;
}

export interface StackRecord {
  /** Missing only on legacy records, which are inspection/down-only. */
  schemaVersion?: typeof STATE_SCHEMA_VERSION;
  /** Deterministic compose project name, e.g. "modem-salem". */
  project: string;
  /** Added in daemon protocol v2; absent only on legacy mirrors. */
  repoId?: RepoId;
  repo: string;
  branch: string;
  worktree: string;
  state: StackState;
  /** Present only on provisional (state: "starting") records. */
  starter?: StackStarter;
  services: ServiceRecord[];
  /** Hestia helpers never occupy the user workload namespace. */
  auxiliary?: ServiceRecord[];
  /** Resolved env block agents consume (DATABASE_URL, etc.). */
  env: Record<string, string>;
  endpoints: Endpoint[];
  /** Explicit CLI route selections; repository defaults remain in machine config. */
  localRoutes?: LocalRouteIntent[];
  disabledLocalRoutes?: LocalRouteIntent[];
  createdAt: string;
  /**
   * Absent on procs-only stacks (a compose file is not required to `run`).
   * When present, `down` uses them; the ~/.hestia mirror keeps copies so
   * teardown works even if the worktree is deleted.
   */
  composeFile?: string;
  overrideFile?: string;
  /** Sticky named-tunnel adoption + this stack's public ingress rules. */
  tunnel?: TunnelRef;
}

export interface ExposeOptions {
  /** Named tunnel to adopt. Sticky: persisted, later calls may omit it. */
  tunnel?: string;
  /** Zone for public hostnames (default: inferred from the base rules). */
  zone?: string;
  /** Keep the public hostname as Host (default rewrites to 127.0.0.1:<port>). */
  keepHostHeader?: boolean;
  /** Proceed despite foreign connectors on the tunnel (replica risk). */
  force?: boolean;
  /** Re-point an existing DNS record hestia has no ledger memory of. */
  overwriteDns?: boolean;
  readyTimeoutMs?: number;
}

/** Daemon admission knobs shared by `up` and `run`. */
export interface AdmitOptions {
  /** ms to wait in the daemon's FIFO queue at the cap. Default 0 = fail fast. */
  wait?: number;
  /** Skip daemon ensure + admission entirely — capless escape hatch. */
  noDaemon?: boolean;
}

export interface UpOptions extends AdmitOptions {
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
  /** Refuse teardown if this named project has since been recreated. */
  expectedStack?: Pick<StackRecord, "repoId" | "worktree" | "createdAt">;
}

/** hestiad `/health` view (broker health merged with hestia's capabilities). */
export interface DaemonHealth {
  ok: boolean;
  pid: number;
  protocolVersion: number;
  maxStacks: number;
  live: number;
  queued: number;
  startedAt: string;
  /** Unprivileged loopback port receiving traffic from the Portless TLS proxy. */
  routerPort: number;
  /** Stable ownership-verifying public ingress socket. */
  gatewaySocket: string;
  /** e.g. an invalid HESTIA_MAX_STACKS that fell back to the default. */
  warnings: string[];
}

/** hestiad `/hestia/state` view — feeds `daemon status`, doctor, the future TUI. */
export interface DaemonStateView {
  maxStacks: number;
  /** Projects with ≥1 live non-tunnel service (derived from mirrors). */
  live: string[];
  /** Granted-but-not-yet-live projects (persisted reservations). */
  reserved: string[];
  /** FIFO of projects waiting for a slot. */
  queued: string[];
  warnings: string[];
}

/** Fleet-observed lifecycle, including daemon-only reservation and unknown states. */
export type FleetStackPhase =
  | "queued"
  | "reserved"
  | "starting"
  | "up"
  | "degraded"
  | "stopped"
  | "unknown";

/** Sanitized endpoint data safe to expose to an authenticated local TUI. */
export interface FleetEndpointView {
  name: string;
  workload?: string;
  binding?: string;
  kind?: "http" | "tcp" | "udp";
  host: string;
  port: number;
  url?: string;
  localUrl?: string;
  publicUrl?: string;
}

/** Sanitized service observation; process identities and filesystem paths are omitted. */
export interface FleetServiceView {
  name: string;
  backend: ServiceBackend;
  state: ServiceState | "unknown";
  publishedPort?: number;
  endpoint?: FleetEndpointView;
  endpoints?: FleetEndpointView[];
}

/** One Hestia-managed stack in a repository-scoped Fleet snapshot. */
export interface FleetStackView extends StackIdentity {
  phase: FleetStackPhase;
  services: FleetServiceView[];
  createdAt?: string;
  warning?: string;
}

/** Machine-wide cap counts shown alongside one repository's managed stacks. */
export interface FleetCapacityView {
  maxStacks: number;
  live: number;
  reserved: number;
  queued: number;
}

/** Full-state Fleet projection; clients replace prior state rather than applying patches. */
export interface FleetSnapshot {
  repoId: RepoId;
  observedAt: string;
  capacity: FleetCapacityView;
  stacks: FleetStackView[];
  warnings: string[];
}

/** NDJSON full-state frame emitted when the semantic Fleet snapshot changes. */
export interface FleetSnapshotEnvelope {
  type: "snapshot";
  sequence: number;
  snapshot: FleetSnapshot;
}

/** NDJSON liveness frame emitted while a Fleet subscription is otherwise idle. */
export interface FleetHeartbeatEnvelope {
  type: "heartbeat";
  sequence: number;
  at: string;
}

/** Every frame accepted by the daemon Fleet stream. */
export type FleetEnvelope = FleetSnapshotEnvelope | FleetHeartbeatEnvelope;

/** One arrival-ordered log line; application ANSI bytes are preserved verbatim. */
export interface LogLine {
  project: string;
  service: string;
  source: ServiceBackend;
  /** One line without its trailing newline; application ANSI is not sanitized. */
  text: string;
  /** True when Hestia synthesized this notice instead of reading application output. */
  meta?: boolean;
  /** True when Hestia bounded an oversized source line before delivery. */
  truncated?: boolean;
  /** Reserved for a future source timestamp; unset while ordering is arrival-only. */
  at?: string;
}

/** Selection and cancellation controls for the pull-based stack log stream. */
export interface LogsOptions {
  /** Service names to stream; defaults to every service in the stack record. */
  services?: string[];
  /** Keep streaming new output after the initial backfill. Default false. */
  follow?: boolean;
  /** Initial lines per source. Default 50; zero disables backfill. */
  tail?: number;
  /** Cooperative cancellation in addition to AsyncIterator.return(). */
  signal?: AbortSignal;
}

export interface EngineHooks {
  onServiceState?(project: string, service: string, state: ServiceState): void;
  onEndpoint?(project: string, endpoint: Endpoint): void;
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
  run(worktree: string, spec: ProcSpec, admit?: AdmitOptions): Promise<StackRecord>;
  /** Stop one supervised proc. Idempotent: unknown/dead names succeed. */
  stopService(worktree: string, name: string): Promise<void>;
  /** Add sticky local HTTPS route intent for services in this worktree. */
  addLocalRoutes(worktree: string, services: string[]): Promise<StackRecord>;
  /** Remove sticky local HTTPS route intent for services in this worktree. */
  removeLocalRoutes(worktree: string, services: string[]): Promise<StackRecord>;
  /** Mask repository or machine route defaults for this worktree. */
  disableLocalRoutes?(worktree: string, services: string[]): Promise<StackRecord>;
  /** Remove the per-worktree override and reveal configured defaults. */
  resetLocalRoutes?(worktree: string, services: string[]): Promise<StackRecord>;
  /** Publish running stack services through a cloudflare tunnel. */
  expose(
    worktree: string,
    services: string[],
    opts?: ExposeOptions,
  ): Promise<StackRecord>;
  /** Tear down by project name from the ~/.hestia mirror — works with the worktree gone. */
  downProject?(project: string, opts?: DownOptions): Promise<void>;
  /** Pull an arrival-ordered stream of docker and supervised-process log lines. */
  logs?(worktree: string, opts?: LogsOptions): AsyncIterable<LogLine>;
  /** Pull logs by mirrored project name after its worktree has been deleted. */
  logsProject?(project: string, opts?: LogsOptions): AsyncIterable<LogLine>;

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
 * Tunnel: cloudflared-missing · tunnel-not-found · tunnel-auth-missing ·
 * tunnel-busy · tunnel-ready-timeout · dns-route-failed · dns-record-conflict ·
 * hostname-conflict · service-not-found.
 * Logs: no-stack · service-not-found.
 * Daemon: stack-limit · daemon-start-failed · daemon-unreachable.
 * Router: router-setup-required · router-privilege-required ·
 * router-port-busy · router-version-unsupported · router-unreachable ·
 * route-origin-unavailable.
 */
export class HestiaError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HestiaError";
    this.code = code;
    this.details = details;
  }
}
