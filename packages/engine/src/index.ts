import { existsSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { resolveCname } from "node:dns/promises";
import { stringify as stringifyYaml } from "yaml";
import {
  STATE_SCHEMA_VERSION,
  type AdmitOptions,
  type DownOptions,
  type Endpoint,
  type ExposeOptions,
  type IsolationEngine,
  type LogLine,
  type LogsOptions,
  type ProcSpec,
  type RepoId,
  type ServiceRecord,
  type StackIdentity,
  type StackRecord,
  type TunnelRef,
  type UpOptions,
  HestiaError,
  NotImplemented,
  projectName,
} from "@hestia/core";
import { loadConfig, tryLoadConfig } from "./config.ts";
import { getRepoInfo, type RepoInfo } from "./git.ts";
import {
  assertDiscoveryRunnable,
  discoverRepository,
  resolveConfiguredWorkloads,
} from "./discovery.ts";
import type { ConfiguredWorkload } from "./repository-config.ts";
import { resolveEndpointSelection } from "./endpoint-resolution.ts";
import { generateOverride } from "./compose/override.ts";
import {
  type ComposeCtx,
  composeConfig,
  composeDown,
  composePs,
  composeUp,
  publishedPortFor,
  resolveComposeModel,
  type ResolvedComposeModel,
  waitReady,
} from "./compose/cli.ts";
import { writeAtomicTextFile } from "./atomic-json-file.ts";
import {
  clearState,
  ensureDir,
  hestiaDir,
  hestiaHome,
  mirrorDir,
  mirrorPidfile,
  mirrorProcsDir,
  readMirrorState,
  readState,
  assertMutableStackRecord,
  writeState,
} from "./state.ts";
import { withLock } from "./proc/lock.ts";
import { envKey, startProc } from "./proc/supervisor.ts";
import {
  type Pidfile,
  isLive,
  listPidfiles,
  procsDir,
  procSpecFingerprint,
  readPidfile,
  removePidfile,
  startTimeOf,
} from "./proc/pidfile.ts";
import { stopProcTree } from "./proc/shutdown.ts";
import { inspectPort } from "./proc/ports.ts";
import {
  internalEndpointAuthority,
  publicGatewaySocketPath,
  resolvedLocalRouteHostname,
  verifyStackServiceOrigin,
} from "./router/local-http-router.ts";
import { detectVarlock } from "./proc/resolver.ts";
import { planWorkers, privateRegistryDir } from "./wrangler/adapter.ts";
import {
  globalGainWarnings,
  snapshotGlobalRegistry,
  verifyPrivateRegistry,
} from "./wrangler/verify.ts";
import { adoptTunnel } from "./tunnel/cloudflared.ts";
import { hostnameFor, importBaseRules, inferZone } from "./tunnel/ingress.ts";
import {
  connectorPidfile,
  isAdopted,
  reconcileTunnel,
} from "./tunnel/registry.ts";
import { isReady, quickTunnelUrl } from "./tunnel/verify.ts";
import { ensureDaemon } from "./daemon/ensure.ts";
import {
  acquireSlot,
  readDaemonJson,
  reconcileDaemonLocalRoutes,
  releaseSlot,
} from "./daemon/client.ts";
import { streamStackLogs } from "./logs/stream.ts";
import {
  effectiveLocalRouteServices,
  readHestiaMachineConfig,
} from "./router/router-config.ts";
import { readHestiaRouterStatus } from "./router/portless-adapter.ts";

export { dockerAvailable } from "./compose/cli.ts";
export * from "./compose/override.ts";
export { withLock } from "./proc/lock.ts";
export { substitutePort, envKey, openProcAttemptLog } from "./proc/supervisor.ts";
export { readLastLines, tailFile } from "./logs/tail.ts";
export { BoundedLogMergeQueue, streamStackLogs } from "./logs/stream.ts";
export { BoundedLogLineAccumulator, boundLogLine, MAX_LOG_LINE_BYTES } from "./logs/log-line-bounds.ts";
export * from "./proc/ports.ts";
export * from "./proc/pidfile.ts";
export * from "./proc/resolver.ts";
export * from "./wrangler/discover.ts";
export {
  privateRegistryDir,
  globalRegistryDir,
  planWorkers,
  wranglerResourceModeArgs,
} from "./wrangler/adapter.ts";
export * from "./tunnel/ingress.ts";
export * from "./tunnel/verify.ts";
export {
  collectDynamicRules,
  connectorPidfile,
  ledgerAdd,
  ledgerHas,
  reconcileTunnel,
  tunnelDir,
} from "./tunnel/registry.ts";
export { adoptTunnel, listTunnels, routeDns } from "./tunnel/cloudflared.ts";
export { hestiaHome } from "./state.ts";
export { type DoctorRow, doctor } from "./doctor.ts";
export {
  configuredLocalRouteServices,
  effectiveLocalRouteServices,
  hestiaConfigTomlPath,
  localRouteHostname,
  migrateHestiaMachineConfig,
  readHestiaMachineConfig,
} from "./router/router-config.ts";
export {
  installHestiaRouter,
  readHestiaRouterStatus,
  uninstallHestiaRouter,
} from "./router/portless-adapter.ts";
export { resolvedLocalRouteHostname } from "./router/local-http-router.ts";
export { daemonDir, resolveMaxStacks } from "./daemon/slots.ts";
export { HESTIAD_PROTOCOL_VERSION } from "./daemon/routes.ts";
export { FleetMonitor, collectFleetSnapshot } from "./daemon/fleet-monitor.ts";
export { ensureDaemon, stopDaemonProcess } from "./daemon/ensure.ts";
export {
  daemonAuthHeaders,
  fetchHealth,
  fetchState,
  reconcileDaemonLocalRoutes,
  readDaemonJson,
  streamDaemonFleet,
  streamDaemonServiceLogs,
} from "./daemon/client.ts";
export { createRepoId, getRepoInfo } from "./git.ts";
export { writeAtomicJsonFile } from "./atomic-json-file.ts";
export * from "./repository-config.ts";
export * from "./discovery.ts";
export * from "./init-config.ts";
export * from "./endpoint-resolution.ts";
export {
  LAUNCHD_LABEL,
  installLaunchd,
  isBootstrapped,
  launchdManagesThisHome,
  plistPath,
  uninstallLaunchd,
} from "./daemon/launchd.ts";

const OVERRIDE_FILE = "compose.override.yml";
const DOCKERFILE_COMPOSE_FILE = "dockerfile.compose.yml";

interface Prepared {
  ctx: ComposeCtx;
  services: string[];
  serviceBindings: Record<string, Array<{ target: number; protocol: "tcp" | "udp" }>>;
  composeFile: string;
  overridePath: string;
}

function composeUnsupported(message: string): never {
  throw new HestiaError("compose-unsupported", message);
}

export function validateResolvedComposeModel(model: ResolvedComposeModel, project: string): void {
  for (const [name, service] of Object.entries(model.services)) {
    if (service.network_mode === "host") composeUnsupported(`service ${name} uses host network mode`);
    if (service.pid === "host") composeUnsupported(`service ${name} uses host PID mode`);
    if (service.ipc === "host") composeUnsupported(`service ${name} uses host IPC mode`);
    for (const port of service.ports ?? []) {
      const target = typeof port.target === "number" ? port.target : Number(port.target);
      if (!Number.isInteger(target) || target < 1 || target > 65_535 || String(port.target).includes("-")) {
        composeUnsupported(`service ${name} has unsupported port target ${String(port.target)} (ranges are not supported)`);
      }
      if (port.published?.includes("-")) {
        composeUnsupported(`service ${name} has unsupported published port range ${port.published}`);
      }
      if (port.protocol !== undefined && port.protocol !== "tcp" && port.protocol !== "udp") {
        composeUnsupported(`service ${name} uses unsupported port protocol ${port.protocol}`);
      }
    }
  }
  for (const [kind, resources] of [
    ["network", model.networks],
    ["volume", model.volumes],
  ] as const) {
    for (const [key, resource] of Object.entries(resources ?? {})) {
      if (resource.external) composeUnsupported(`${kind} ${key} is external`);
      if (resource.name !== undefined && !resource.name.startsWith(`${project}_`)) {
        composeUnsupported(`${kind} ${key} has explicit machine-global name ${resource.name}`);
      }
    }
  }
}

export function expandComposeDependencies(model: ResolvedComposeModel, requested?: string[]): string[] {
  const roots = requested ?? Object.keys(model.services);
  const expanded = new Set<string>();
  const visit = (name: string): void => {
    const service = model.services[name];
    if (service === undefined) {
      throw new HestiaError(
        "service-not-found",
        `compose service ${JSON.stringify(name)} is not defined (have: ${Object.keys(model.services).join(", ")})`,
      );
    }
    if (expanded.has(name)) return;
    expanded.add(name);
    for (const dependency of Object.keys(service.depends_on ?? {})) visit(dependency);
  };
  for (const root of roots) visit(root);
  return [...expanded];
}

function assertNoEnvironmentKeyConflicts(
  workloads: Array<{ name: string; endpoints: Array<{ alias: string }> }>,
): void {
  const owners = new Map<string, string>();
  for (const workload of workloads) {
    for (const owner of [workload.name, ...workload.endpoints.map((endpoint) => endpoint.alias)]) {
      const key = envKey(owner);
      const previous = owners.get(key);
      if (previous !== undefined && previous !== owner) {
        throw new HestiaError(
          "env-key-conflict",
          `${JSON.stringify(previous)} and ${JSON.stringify(owner)} both normalize to HESTIA_${key}`,
          { key: `HESTIA_${key}`, owners: [previous, owner] },
        );
      }
      owners.set(key, owner);
    }
  }
}

export function applyConfiguredEndpoints(
  record: StackRecord,
  configuredWorkloads: Record<string, ConfiguredWorkload>,
): void {
  for (const [workloadName, configured] of Object.entries(configuredWorkloads)) {
    const serviceName = configured.composeService ?? workloadName;
    const service = record.services.find((candidate) => candidate.name === serviceName);
    if (service === undefined) continue;
    for (const [alias, endpointConfig] of Object.entries(configured.endpoints)) {
      const [target, protocol] = endpointConfig.binding.split("/") as [string, "tcp" | "udp"];
      const binding = service.bindings?.find((candidate) =>
        candidate.target === target && candidate.protocol === protocol
      );
      if (binding === undefined) {
        throw new HestiaError(
          "endpoint-binding-not-found",
          `endpoint ${alias} selects ${serviceName}:${endpointConfig.binding}, which is not published`,
        );
      }
      const directUrl = endpointConfig.kind === "http"
        ? `http://127.0.0.1:${binding.publishedPort}`
        : undefined;
      setEndpoint(record, {
        name: alias,
        alias,
        workload: serviceName,
        binding: endpointConfig.binding,
        kind: endpointConfig.kind,
        local: endpointConfig.local,
        host: "127.0.0.1",
        port: binding.publishedPort,
        url: directUrl,
      });
      record.env[`HESTIA_${envKey(alias)}_PORT`] = String(binding.publishedPort);
      if (directUrl !== undefined) record.env[`HESTIA_${envKey(alias)}_DIRECT_URL`] = directUrl;
    }
  }
}

/** Refuse to persist runtime state where Git could accidentally track it. */
async function assertHestiaStateIgnored(worktreeRoot: string): Promise<void> {
  try {
    await pexec("git", ["-C", worktreeRoot, "rev-parse", "--is-inside-work-tree"], { timeout: 5_000 });
  } catch {
    return; // non-Git fallback mode has no index to protect
  }
  try {
    await pexec("git", ["-C", worktreeRoot, "check-ignore", "-q", ".hestia/"], { timeout: 5_000 });
  } catch {
    throw new HestiaError(
      "state-not-ignored",
      `.hestia is not ignored in ${worktreeRoot}; add the line ".hestia/" to ${join(worktreeRoot, ".gitignore")}`,
      { remedy: `.hestia/`, path: join(worktreeRoot, ".gitignore") },
    );
  }
}

/** Resolve and validate Compose before atomically publishing its isolation override. */
async function prepareCompose(
  worktreeRoot: string,
  project: string,
  repo: string,
  branch: string,
  opts?: UpOptions,
  configuredBaseFile?: string,
): Promise<Prepared> {
  const cfg = configuredBaseFile === undefined
    ? loadConfig(worktreeRoot)
    : { composeFile: configuredBaseFile, services: [] };
  const resolvedModel = await resolveComposeModel(project, cfg.composeFile, worktreeRoot);
  validateResolvedComposeModel(resolvedModel, project);
  const services = expandComposeDependencies(resolvedModel, opts?.services);
  const { yaml, serviceBindings } = generateOverride({
    userCompose: resolvedModel,
    project,
    repo,
    branch,
    worktree: worktreeRoot,
    services,
  });

  ensureDir(hestiaDir(worktreeRoot));
  const overridePath = join(hestiaDir(worktreeRoot), OVERRIDE_FILE);
  writeAtomicTextFile(overridePath, yaml);

  return {
    ctx: {
      project,
      baseFile: cfg.composeFile,
      overrideFile: overridePath,
      cwd: worktreeRoot,
    },
    services,
    serviceBindings,
    composeFile: cfg.composeFile,
    overridePath,
  };
}

function writeDockerfileComposeModel(
  worktreeRoot: string,
  workloads: Record<string, ConfiguredWorkload>,
  conventionalComposeFile?: string,
): string | undefined {
  const dockerfiles = Object.entries(workloads).filter(([, workload]) => workload.source === "dockerfile");
  if (dockerfiles.length === 0) return conventionalComposeFile;
  const services = Object.fromEntries(dockerfiles.map(([name, workload]) => {
    const ports = [...new Set(Object.values(workload.endpoints).map((endpoint) => endpoint.binding))]
      .filter((binding) => !binding.startsWith("main/"));
    return [name, {
      build: {
        context: worktreeRoot,
        dockerfile: workload.dockerfile ?? "Dockerfile",
      },
      ...(ports.length > 0 ? { ports } : {}),
    }];
  }));
  const model = {
    ...(conventionalComposeFile === undefined
      ? {}
      : { include: [{ path: conventionalComposeFile }] }),
    services,
  };
  const path = join(hestiaDir(worktreeRoot), DOCKERFILE_COMPOSE_FILE);
  writeAtomicTextFile(path, stringifyYaml(model));
  return path;
}

function freshRecord(
  project: string,
  repoId: RepoId,
  repo: string,
  branch: string,
  worktree: string,
): StackRecord {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    project,
    repoId,
    repo,
    branch,
    worktree,
    state: "up",
    services: [],
    env: {},
    endpoints: [],
    createdAt: new Date().toISOString(),
  };
}

/** Guard every stack mutation against legacy state and changed Git identity. */
function assertCurrentStackIdentity(
  record: StackRecord,
  current: RepoInfo,
): void {
  const path = join(hestiaDir(current.worktreeRoot), "stack.json");
  assertMutableStackRecord(record, path);
  const matches =
    record.repoId === current.repoId &&
    record.repo === current.repo &&
    record.branch === current.branch &&
    resolve(record.worktree) === resolve(current.worktreeRoot) &&
    record.project === projectName(
      current.repoId,
      current.repo,
      current.branch,
      current.worktreeRoot,
    );
  if (!matches) {
    throw new HestiaError(
      "stack-identity-changed",
      `this checkout no longer matches stack ${record.project}; run hestia down before starting or changing it`,
      {
        recorded: {
          repoId: record.repoId,
          repo: record.repo,
          branch: record.branch,
          worktree: record.worktree,
        },
        current,
        recovery: `hestia down --project ${record.project}`,
      },
    );
  }
}

function upsertService(record: StackRecord, svc: ServiceRecord): void {
  const i = record.services.findIndex((s) => s.name === svc.name);
  if (i >= 0) record.services[i] = svc;
  else record.services.push(svc);
}

function upsertAuxiliary(record: StackRecord, auxiliary: ServiceRecord): void {
  record.auxiliary ??= [];
  const index = record.auxiliary.findIndex((candidate) => candidate.name === auxiliary.name);
  if (index >= 0) record.auxiliary[index] = auxiliary;
  else record.auxiliary.push(auxiliary);
}

function setEndpoint(record: StackRecord, ep: Endpoint): void {
  const i = record.endpoints.findIndex((e) => e.name === ep.name);
  if (i >= 0) {
    const previous = record.endpoints[i]!;
    const portRotated = previous.port !== ep.port;
    const namedExposure = record.tunnel?.exposures.some((exposure) =>
      (exposure.alias ?? exposure.service) === ep.name) ?? false;
    if (portRotated && previous.publicUrl !== undefined && !namedExposure) {
      delete previous.publicUrl;
      delete record.env[urlKey(ep.name)];
    }
    record.endpoints[i] = { ...previous, ...ep };
  }
  else record.endpoints.push(ep);
  applyLocalRouteProjection(record);
}

function dropService(record: StackRecord, name: string): void {
  record.services = record.services.filter((s) => s.name !== name);
  record.endpoints = record.endpoints.filter((e) => e.name !== name);
  delete record.env[`HESTIA_${envKey(name)}_PORT`];
  delete record.env[directUrlKey(name)];
  delete record.env[localUrlKey(name)];
}

function persistStoppedService(record: StackRecord, name: string): void {
  const service = record.services.find((candidate) => candidate.name === name);
  if (service === undefined) return;
  service.state = "stopped";
  delete service.publishedPort;
  service.bindings = [];
  record.endpoints = record.endpoints.filter((endpoint) =>
    endpoint.name !== name && endpoint.workload !== name
  );
  for (const key of Object.keys(record.env)) {
    if (key.startsWith(`HESTIA_${envKey(name)}_`)) delete record.env[key];
  }
}

function recordProc(
  record: StackRecord,
  svc: ServiceRecord,
): void {
  const recorded = svc.publishedPort === undefined ? svc : {
    ...svc,
    bindings: [{
      id: `${svc.name}:main/tcp`,
      target: "main",
      protocol: "tcp" as const,
      publishedPort: svc.publishedPort,
    }],
  };
  upsertService(record, recorded);
  if (svc.publishedPort !== undefined) {
    record.env[`HESTIA_${envKey(svc.name)}_MAIN_TCP_PORT`] = String(svc.publishedPort);
    record.env[`HESTIA_${envKey(svc.name)}_PORT`] = String(svc.publishedPort);
    setEndpoint(record, {
      name: svc.name,
      workload: svc.name,
      binding: "main/tcp",
      host: "127.0.0.1",
      port: svc.publishedPort,
      reservedName: `${svc.name}.${record.branch}.${record.repo}.localhost`,
    });
  }
}

function urlKey(name: string): string {
  return `HESTIA_${envKey(name)}_URL`;
}

function directUrlKey(name: string): string {
  return `HESTIA_${envKey(name)}_DIRECT_URL`;
}

function localUrlKey(name: string): string {
  return `HESTIA_${envKey(name)}_LOCAL_URL`;
}

/** Project direct and stable URL fields from explicit plus configured route intent. */
function applyLocalRouteProjection(record: StackRecord): void {
  const config = readHestiaMachineConfig().config;
  const selected = new Set(effectiveLocalRouteServices(record, config));
  for (const endpoint of record.endpoints) {
    endpoint.reservedName = resolvedLocalRouteHostname(record, endpoint.name, config);
    const service = record.services.find(
      (candidate) => candidate.name === (endpoint.workload ?? endpoint.name),
    );
    const selectedBinding = endpoint.binding === undefined
      ? undefined
      : service?.bindings?.find(
          (binding) => `${binding.target}/${binding.protocol}` === endpoint.binding,
        );
    const publishedPort = selectedBinding?.publishedPort ?? service?.publishedPort;
    if (!selected.has(endpoint.name)) {
      // Explicit endpoint kind is a protocol declaration. Legacy untyped ports
      // remain raw until route intent declares HTTP.
      if (endpoint.kind === "http" && publishedPort !== undefined) {
        endpoint.url = `http://127.0.0.1:${publishedPort}`;
        record.env[directUrlKey(endpoint.name)] = endpoint.url;
      } else {
        delete endpoint.url;
        delete record.env[directUrlKey(endpoint.name)];
      }
      delete endpoint.localUrl;
      delete record.env[localUrlKey(endpoint.name)];
      continue;
    }
    if (service === undefined || publishedPort === undefined || service.backend === "tunnel") continue;
    endpoint.host = "127.0.0.1";
    endpoint.port = publishedPort;
    if (endpoint.kind !== undefined && endpoint.kind !== "http") {
      delete endpoint.url;
      delete endpoint.localUrl;
      delete record.env[directUrlKey(endpoint.name)];
      delete record.env[localUrlKey(endpoint.name)];
      continue;
    }
    endpoint.url = `http://127.0.0.1:${publishedPort}`;
    endpoint.localUrl = `https://${endpoint.reservedName}`;
    record.env[directUrlKey(endpoint.name)] = endpoint.url;
    record.env[localUrlKey(endpoint.name)] = endpoint.localUrl;
  }
}

/**
 * Re-point named-mode exposures at the services' CURRENT ports. Returns true
 * when the merged ingress derived from this record changed (a port rotated or
 * an origin stopped) — the caller must reconcile the global connector after
 * releasing the worktree lock, because an ingress rule aimed at a port this
 * stack no longer owns is a live cross-worktree misdelivery once the OS
 * recycles the port.
 */
function syncExposures(record: StackRecord): boolean {
  const t = record.tunnel;
  if (t === undefined) return false;
  let changed = false;
  for (const exp of t.exposures) {
    const svc = record.services.find((s) => s.name === exp.service);
    const binding = svc?.bindings?.find((candidate) =>
      `${candidate.target}/${candidate.protocol}` === exp.binding);
    const publishedPort = binding?.publishedPort ?? svc?.publishedPort;
    if (publishedPort === undefined) {
      changed = true; // origin gone — regen drops the rule (404, never a stale port)
    } else if (publishedPort !== exp.originPort) {
      exp.originPort = publishedPort;
      changed = true;
    }
  }
  return changed;
}

const pexec = promisify(execFile);

function matchesExpectedStack(
  record: StackRecord | null,
  expected: NonNullable<DownOptions["expectedStack"]>,
): boolean {
  return record !== null &&
    (record.repoId === undefined || record.repoId === expected.repoId) &&
    record.worktree === expected.worktree &&
    record.createdAt === expected.createdAt;
}

function projectMutationRoot(project: string): string {
  return join(hestiaHome(), "project-locks", project);
}

async function assertNamedTunnelDns(hostname: string, tunnelUuid: string): Promise<void> {
  const expected = `${tunnelUuid}.cfargotunnel.com`;
  if (process.env.HESTIA_E2E_DNS_RESOLVED === "1") return;
  try {
    const records = (await resolveCname(hostname)).map((record) => record.replace(/\.$/, "").toLowerCase());
    if (records.includes(expected.toLowerCase())) return;
  } catch {}
  throw new HestiaError(
    "dns-route-required",
    `${hostname} does not resolve through Hestia's adopted tunnel; configure wildcard CNAME *.${hostname.split(".").slice(1).join(".")} -> ${expected}`,
    { hostname, wildcardTarget: expected },
  );
}

interface StartAdmissionGuard {
  createdAt: string;
  rollback(): Promise<void>;
}

export class ComposeEngine implements IsolationEngine {
  /** Refresh daemon route state after a stack mutation; strict mode surfaces failures. */
  async #refreshLocalRoutes(strict = false): Promise<void> {
    try {
      const daemon = readDaemonJson();
      if (daemon !== null) await reconcileDaemonLocalRoutes(daemon.port);
    } catch (error) {
      if (strict) throw error;
      process.stderr.write(`warning: local router reconcile failed: ${(error as Error).message}\n`);
    }
  }

  /** Stream this worktree's recorded services without taking its mutation lock. */
  async *logs(cwd: string, opts?: LogsOptions): AsyncGenerator<LogLine> {
    const { worktreeRoot } = await getRepoInfo(cwd);
    const record = readState(worktreeRoot);
    if (record === null) {
      throw new HestiaError("no-stack", "no stack for this worktree");
    }
    yield* streamStackLogs(record, opts);
  }

  /** Stream a mirrored project without requiring its original worktree. */
  async *logsProject(project: string, opts?: LogsOptions): AsyncGenerator<LogLine> {
    const record = readMirrorState(project);
    if (record === null) {
      throw new HestiaError("no-stack", `no mirror for project "${project}"`);
    }
    yield* streamStackLogs(record, opts);
  }

  /**
   * Best-effort convergence of the global connector after a stack mutation.
   * Failures degrade to warnings — `run`/`down` must not fail because the
   * tunnel blipped; `status` will show it unhealthy.
   */
  async #reconcileAdopted(t: TunnelRef | undefined): Promise<void> {
    if (t === undefined) return;
    try {
      const outcome = await reconcileTunnel(t);
      for (const w of outcome.warnings) process.stderr.write(`warning: ${w}\n`);
      if (outcome.error !== undefined) {
        process.stderr.write(`warning: ${outcome.error.message}\n`);
      }
    } catch (err) {
      process.stderr.write(
        `warning: tunnel reconcile failed: ${(err as Error).message}\n`,
      );
    }
  }

  /**
   * Machine-wide admission before any start: ensure hestiad, request a slot
   * (idempotent for already-live projects), and bridge the grant with a
   * provisional `starting` record so the slot survives a multi-minute cold
   * `compose up` and a CLI crash frees it (dead starter → sweep). Runs BEFORE
   * the worktree lock — never long-poll while holding it.
   * Returns a cleanup that rolls the provisional record back on failure.
   */
  async #admit(
    project: string,
    repoId: RepoId,
    repo: string,
    branch: string,
    worktreeRoot: string,
    opts?: AdmitOptions,
  ): Promise<StartAdmissionGuard> {
    const currentIdentity = { repo, repoId, branch, worktreeRoot };
    const existingRecord = readState(worktreeRoot);
    if (existingRecord !== null) assertCurrentStackIdentity(existingRecord, currentIdentity);
    let handle: Awaited<ReturnType<typeof ensureDaemon>> | null = null;
    if (opts?.noDaemon) {
      process.stderr.write(
        "warning: --no-daemon skips the stack cap and daemon supervision\n",
      );
    } else {
      handle = await ensureDaemon();
      const identity: StackIdentity = {
        project,
        repoId,
        repo,
        branch,
        worktree: worktreeRoot,
      };
      const result = await acquireSlot(handle.port, identity, opts?.wait ?? 0);
      if (!result.granted) {
        const live = result.live.join(", ");
        throw new HestiaError(
          "stack-limit",
          `stack cap reached (live: ${live}) — \`hestia down\` one, or retry with --wait`,
        );
      }
    }
    // Provisional record only when the project has no record at all — an
    // existing record already carries occupancy through its services.
    let provisional = false;
    let retainedEmpty = false;
    let previousState: StackRecord["state"] | undefined;
    let previousStarter: StackRecord["starter"];
    let createdAt = "";
    await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      let rec = readState(worktreeRoot);
      if (rec === null) {
        const rec = freshRecord(project, repoId, repo, branch, worktreeRoot);
        rec.state = "starting";
        rec.starter = {
          pid: process.pid,
          startTime: startTimeOf(process.pid) ?? "",
        };
        writeState(worktreeRoot, rec);
        provisional = true;
        createdAt = rec.createdAt;
      } else {
        assertCurrentStackIdentity(rec, currentIdentity);
        if (rec.services.length === 0) {
          retainedEmpty = true;
          provisional = true;
          previousState = rec.state;
          previousStarter = rec.starter;
          rec.state = "starting";
          rec.starter = {
            pid: process.pid,
            startTime: startTimeOf(process.pid) ?? "",
          };
          writeState(worktreeRoot, rec);
        }
        createdAt = rec.createdAt;
      }
    }));
    return { createdAt, rollback: async () => {
      // Failure rollback: drop the record only if it is still our untouched
      // provisional (a partially-started stack must stay visible for `down`).
      if (!provisional) return;
      await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
        const rec = readState(worktreeRoot);
        if (rec !== null && rec.state === "starting" && rec.services.length === 0 && rec.composeFile === undefined) {
          if (retainedEmpty) {
            rec.state = previousState ?? "stopped";
            rec.starter = previousStarter;
            writeState(worktreeRoot, rec);
          } else {
            clearState(worktreeRoot, project);
          }
        }
      }));
      if (handle !== null) await releaseSlot(handle.port, project);
    } };
  }

  async up(cwd: string, opts?: UpOptions): Promise<StackRecord> {
    const discovery = await discoverRepository(cwd);
    assertDiscoveryRunnable(discovery);
    assertNoEnvironmentKeyConflicts(
      [...discovery.runnableWorkloads, ...discovery.candidateWorkloads]
        .map((workload) => ({ name: workload.name, endpoints: workload.endpoints })),
    );
    const configured = await resolveConfiguredWorkloads(cwd);
    if (configured.conflicts.length > 0) {
      throw new HestiaError("config-conflict", configured.conflicts.join("; "));
    }
    const { repo, repoId, branch, worktreeRoot } = await getRepoInfo(cwd);
    await assertHestiaStateIgnored(worktreeRoot);
    const project = projectName(repoId, repo, branch, worktreeRoot);
    let tunnelDirty = false;

    const admission = await this.#admit(project, repoId, repo, branch, worktreeRoot, opts);
    let done: StackRecord;
    try {
      done = await this.#upLocked(
        worktreeRoot,
        project,
        repoId,
        repo,
        branch,
        admission.createdAt,
        opts,
        configured.workloads,
        (d) => {
        tunnelDirty = d;
        },
      );
    } catch (err) {
      await admission.rollback();
      throw err;
    }
    if (tunnelDirty) await this.#reconcileAdopted(done.tunnel);
    await this.#refreshLocalRoutes();
    return done;
  }

  async #upLocked(
    worktreeRoot: string,
    project: string,
    repoId: RepoId,
    repo: string,
    branch: string,
    admittedCreatedAt: string,
    opts: UpOptions | undefined,
    configuredWorkloads: Record<string, ConfiguredWorkload>,
    setTunnelDirty: (d: boolean) => void,
  ): Promise<StackRecord> {
    return withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record?.createdAt !== admittedCreatedAt) {
        throw new HestiaError("worktree-busy", "stack was removed after admission; start cancelled");
      }
      record.repoId ??= repoId;
      const conventionalCompose = tryLoadConfig(worktreeRoot);
      const composeBaseFile = writeDockerfileComposeModel(
        worktreeRoot,
        configuredWorkloads,
        conventionalCompose?.composeFile,
      );
      const hasCompose = composeBaseFile !== undefined;
      const configuredProcs = Object.entries(configuredWorkloads)
        .filter(([, workload]) => workload.source === "proc");
      const configuredWorkers = Object.entries(configuredWorkloads)
        .filter(([, workload]) => workload.source === "wrangler");
      if (!hasCompose && !opts?.workers && configuredProcs.length === 0 && configuredWorkers.length === 0) {
        // plain `up` still means "compose up" — procs arrive via `run`
        loadConfig(worktreeRoot); // throws config-missing
      }

      if (hasCompose) {
        const p = await prepareCompose(worktreeRoot, project, repo, branch, opts, composeBaseFile);
        await composeConfig(p.ctx);
        for (const serviceName of p.services) {
          const proc = record.services.find(
            (service) => service.name === serviceName && service.backend !== "docker",
          );
          if (proc !== undefined) {
            throw new HestiaError(
              "name-conflict",
              `compose service "${serviceName}" collides with a running proc of the same name`,
            );
          }
        }
        // Publish teardown intent before Compose may create anything. A later
        // failure remains visible and `down` can always remove partial resources.
        record.composeFile = p.composeFile;
        record.overrideFile = p.overridePath;
        writeState(worktreeRoot, record);
        // The explicit list prevents unrelated profile services from starting;
        // transitive dependencies were expanded before override generation.
        let rows;
        try {
          await composeUp(p.ctx, p.services);
          rows = await waitReady(p.ctx, p.services);
        } catch (error) {
          record.state = "degraded";
          for (const serviceName of p.services) {
            upsertService(record, {
              name: serviceName,
              backend: "docker",
              state: "unhealthy",
              containerPort: p.serviceBindings[serviceName]?.[0]?.target,
              bindings: [],
            });
          }
          delete record.starter;
          writeState(worktreeRoot, record);
          throw error;
        }
        const byName = new Map(rows.map((r) => [r.Service, r]));

        for (const svc of p.services) {
          const row = byName.get(svc);
          const targetBindings = p.serviceBindings[svc] ?? [];
          const bindings = targetBindings.flatMap((binding) => {
            const publishedPort = publishedPortFor(row, binding.target, binding.protocol);
            return publishedPort === undefined ? [] : [{
              id: `${svc}:${binding.target}/${binding.protocol}`,
              target: String(binding.target),
              protocol: binding.protocol,
              publishedPort,
            }];
          });
          const canonical = bindings.length === 1 ? bindings[0]!.publishedPort : undefined;
          upsertService(record, {
            name: svc,
            backend: "docker",
            state: "healthy",
            containerPort: targetBindings[0]?.target,
            publishedPort: canonical,
            containerId: row?.ID,
            bindings,
          });
          for (const binding of bindings) {
            record.env[
              `HESTIA_${envKey(svc)}_${binding.target}_${binding.protocol.toUpperCase()}_PORT`
            ] = String(binding.publishedPort);
          }
          if (bindings.length === 1 && canonical !== undefined) {
            record.env[`HESTIA_${envKey(svc)}_PORT`] = String(canonical);
            setEndpoint(record, {
              name: svc,
              host: "127.0.0.1",
              port: canonical,
              workload: svc,
              binding: `${bindings[0]!.target}/${bindings[0]!.protocol}`,
              kind: bindings[0]!.protocol,
              reservedName: `${svc}.${branch}.${repo}.localhost`,
            });
          }
        }
      }

      for (const [name, workload] of configuredProcs) {
        const command = workload.command!;
        const configuredSpec: ProcSpec = {
          name,
          argv: command,
          port: workload.port ?? "auto",
          backend: "proc",
        };
        const clash = record.services.find((service) => service.name === name && service.backend === "docker");
        if (clash !== undefined) {
          throw new HestiaError("name-conflict", `configured proc ${name} collides with a compose workload`);
        }
        const existing = readPidfile(worktreeRoot, name);
        if (existing !== null && isLive(existing)) {
          if (existing.specFingerprint === procSpecFingerprint(configuredSpec)) continue;
          persistStoppedService(record, name);
          setTunnelDirty(syncExposures(record));
          writeState(worktreeRoot, record);
          await stopProcTree(existing);
          removePidfile(worktreeRoot, name);
        } else if (existing !== null) {
          removePidfile(worktreeRoot, name);
        }
        const result = await startProc(
          worktreeRoot,
          configuredSpec,
          record.env,
          (pidfile) => mirrorPidfile(record.project, pidfile),
        );
        recordProc(record, result.record);
        writeState(worktreeRoot, record);
        if (result.error !== undefined) throw result.error;
      }

      if (opts?.workers || configuredWorkers.length > 0) {
        const configuredFilters = configuredWorkers.map(([name, workload]) => workload.wranglerConfig ?? name);
        const explicitFilters = Array.isArray(opts?.workers) ? opts.workers : [];
        await this.#upWorkers(worktreeRoot, record, {
          ...opts,
          workers: opts?.workers === true ? true : [...new Set([...explicitFilters, ...configuredFilters])],
        });
      }

      applyConfiguredEndpoints(record, configuredWorkloads);

      record.state = "up";
      delete record.starter; // no longer provisional — services carry the slot
      setTunnelDirty(syncExposures(record));
      writeState(worktreeRoot, record);
      return record;
    }));
  }

  /** Spawn one supervised `wrangler dev` per discovered config, in parallel. */
  async #upWorkers(
    worktreeRoot: string,
    record: StackRecord,
    opts: UpOptions,
  ): Promise<void> {
    const plan = await planWorkers(worktreeRoot, {
      filter: Array.isArray(opts.workers) ? opts.workers : [],
      allowRemote: opts.allowRemote ?? false,
      force: opts.force ?? false,
      varlock: !opts.noVarlock && detectVarlock(worktreeRoot) !== null,
    });
    for (const w of plan.warnings) process.stderr.write(`warning: ${w}\n`);

    for (const spec of plan.specs) {
      const clash = record.services.find(
        (s) => s.name === spec.name && s.backend === "docker",
      );
      if (clash !== undefined) {
        throw new HestiaError(
          "name-conflict",
          `worker "${spec.name}" collides with a compose service name`,
        );
      }
    }

    const globalBefore = snapshotGlobalRegistry();
    const results = await Promise.allSettled(
      plan.specs.map((spec) =>
        startProc(worktreeRoot, spec, record.env, (pf) =>
          mirrorPidfile(record.project, pf),
        ),
      ),
    );

    let firstError: unknown;
    const started: string[] = [];
    for (const [i, res] of results.entries()) {
      if (res.status === "fulfilled") {
        recordProc(record, res.value.record);
        if (res.value.error !== undefined) firstError ??= res.value.error;
        else started.push(plan.specs[i]!.name);
      } else {
        firstError ??= res.reason;
      }
    }
    // Persist what did start before surfacing any failure, so `down` cleans it.
    writeState(worktreeRoot, record);
    if (started.length > 0) {
      await verifyPrivateRegistry(privateRegistryDir(worktreeRoot), started);
      for (const w of globalGainWarnings(globalBefore, started)) {
        process.stderr.write(`warning: ${w}\n`);
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  async run(cwd: string, spec: ProcSpec, admit?: AdmitOptions): Promise<StackRecord> {
    const { repo, repoId, branch, worktreeRoot } = await getRepoInfo(cwd);
    await assertHestiaStateIgnored(worktreeRoot);
    const project = projectName(repoId, repo, branch, worktreeRoot);
    let tunnelDirty = false;

    const admission = await this.#admit(project, repoId, repo, branch, worktreeRoot, admit);
    let done: StackRecord;
    try {
      done = await this.#runLocked(worktreeRoot, project, repoId, repo, branch, admission.createdAt, spec, (d) => {
        tunnelDirty = d;
      });
    } catch (err) {
      await admission.rollback();
      throw err;
    }
    if (tunnelDirty) await this.#reconcileAdopted(done.tunnel);
    await this.#refreshLocalRoutes();
    return done;
  }

  async #runLocked(
    worktreeRoot: string,
    project: string,
    repoId: RepoId,
    repo: string,
    branch: string,
    admittedCreatedAt: string,
    spec: ProcSpec,
    setTunnelDirty: (d: boolean) => void,
  ): Promise<StackRecord> {
    return withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record?.createdAt !== admittedCreatedAt) {
        throw new HestiaError("worktree-busy", "stack was removed after admission; start cancelled");
      }
      record.repoId ??= repoId;

      const docker = record.services.find(
        (s) => s.name === spec.name && s.backend === "docker",
      );
      if (docker !== undefined) {
        throw new HestiaError(
          "name-conflict",
          `"${spec.name}" is a compose service in this stack — pick another --name`,
        );
      }

      const existing = readPidfile(worktreeRoot, spec.name);
      if (existing !== null && isLive(existing)) {
        const sameCmd = existing.specFingerprint === procSpecFingerprint(spec);
        if (sameCmd) return record; // idempotent no-op: already running this
        persistStoppedService(record, spec.name);
        setTunnelDirty(syncExposures(record));
        writeState(worktreeRoot, record);
        await stopProcTree(existing); // replace: same name, different command
        removePidfile(worktreeRoot, spec.name);
      } else if (existing !== null) {
        removePidfile(worktreeRoot, spec.name); // stale (crashed/reused pid)
      }

      delete record.env[directUrlKey(spec.name)];
      const result = await startProc(worktreeRoot, spec, record.env, (pf) =>
        mirrorPidfile(record.project, pf),
      );
      recordProc(record, result.record);
      record.state = "up";
      delete record.starter; // no longer provisional — services carry the slot
      setTunnelDirty(syncExposures(record));
      writeState(worktreeRoot, record);
      if (result.error !== undefined) throw result.error;
      return record;
    }));
  }

  async stopService(cwd: string, name: string): Promise<void> {
    const currentIdentity = await getRepoInfo(cwd);
    const { repo, repoId, branch, worktreeRoot } = currentIdentity;
    let tunnel: TunnelRef | undefined;
    let tunnelDirty = false;
    const project = readState(worktreeRoot)?.project ?? projectName(repoId, repo, branch, worktreeRoot);
    await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record !== null) {
        assertCurrentStackIdentity(record, currentIdentity);
        if (record.services.some((service) => service.name === name && service.backend === "docker")) {
          throw new HestiaError(
            "backend-not-stoppable",
            `Docker workload ${name} cannot be stopped individually; use hestia down`,
          );
        }
      }
      const pf = readPidfile(worktreeRoot, name);
      if (pf !== null) {
        await stopProcTree(pf);
        removePidfile(worktreeRoot, name);
      }
      if (record !== null) {
        const originAuxiliaries = (record.auxiliary ?? []).filter(
          (auxiliary) => auxiliary.originService === name,
        );
        for (const auxiliary of originAuxiliaries) {
          const auxiliaryPidfile = readPidfile(worktreeRoot, auxiliary.name);
          if (auxiliaryPidfile !== null && isLive(auxiliaryPidfile)) {
            await stopProcTree(auxiliaryPidfile);
          }
          removePidfile(worktreeRoot, auxiliary.name);
        }
        if (originAuxiliaries.length > 0) {
          const auxiliaryNames = new Set(originAuxiliaries.map((auxiliary) => auxiliary.name));
          record.auxiliary = (record.auxiliary ?? []).filter(
            (auxiliary) => !auxiliaryNames.has(auxiliary.name),
          );
          for (const auxiliary of originAuxiliaries) {
            const endpointName = auxiliary.originEndpoint ?? name;
            const endpoint = record.endpoints.find((candidate) => candidate.name === endpointName);
            if (endpoint !== undefined) delete endpoint.publicUrl;
            delete record.env[urlKey(endpointName)];
          }
        }
        // a quick tunnel going down takes its origin's public URL with it
        const stopped = record.services.find((s) => s.name === name);
        if (stopped?.originService !== undefined) {
          const endpointName = stopped.originEndpoint ?? stopped.originService;
          const ep = record.endpoints.find((e) => e.name === endpointName);
          if (ep !== undefined) delete ep.publicUrl;
          delete record.env[urlKey(endpointName)];
        }
        dropService(record, name);
        tunnel = record.tunnel;
        tunnelDirty = syncExposures(record);
        const hasStickyLocalRoutes = effectiveLocalRouteServices(record).length > 0;
        if (record.services.length === 0 && record.composeFile === undefined && !hasStickyLocalRoutes) {
          clearState(worktreeRoot, record.project);
        } else {
          writeState(worktreeRoot, record);
        }
      }
    }));
    if (tunnelDirty) await this.#reconcileAdopted(tunnel);
    await this.#refreshLocalRoutes();
  }

  async addLocalRoutes(cwd: string, services: string[]): Promise<StackRecord> {
    if (services.length === 0) throw new HestiaError("usage", "Route add: at least one service is required");
    const daemon = await ensureDaemon();
    const currentIdentity = await getRepoInfo(cwd);
    const { worktreeRoot } = currentIdentity;
    const project = readState(worktreeRoot)?.project;
    if (project === undefined) throw new HestiaError("no-stack", "Route add: no stack for this worktree");
    const record = await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const current = readState(worktreeRoot);
      if (current === null) throw new HestiaError("no-stack", "Route add: no stack for this worktree");
      assertCurrentStackIdentity(current, currentIdentity);
      const resolvedRoutes = services.map((input) => ({
        input,
        selection: resolveEndpointSelection(current, input),
      }));
      for (const { input, selection } of resolvedRoutes) {
        if (selection.endpoint.kind !== undefined && selection.endpoint.kind !== "http") {
          throw new HestiaError(
            "usage",
            `Route add requires an HTTP endpoint; ${input} is ${selection.endpoint.kind}`,
          );
        }
        const service = current.services.find((candidate) => candidate.name === selection.workload);
        const binding = service?.bindings?.find(
          (candidate) => `${candidate.target}/${candidate.protocol}` === selection.binding,
        );
        const publishedPort = binding?.publishedPort ?? service?.publishedPort;
        if (service === undefined || publishedPort === undefined || service.backend === "tunnel") {
          throw new HestiaError(
            "route-origin-unavailable",
            `Route add: endpoint "${input}" is not running with a direct port`,
          );
        }
        if (!await verifyStackServiceOrigin(current, service, publishedPort)) {
          throw new HestiaError(
            "route-origin-unavailable",
            `Route add: endpoint "${input}" no longer owns its recorded direct port`,
          );
        }
      }
      current.localRoutes ??= [];
      for (const { selection } of resolvedRoutes) {
        const alias = selection.endpoint.name;
        current.disabledLocalRoutes = (current.disabledLocalRoutes ?? []).filter(
          (route) => (route.alias ?? route.service) !== alias,
        );
        const intent = { service: selection.workload, selector: selection.binding, alias };
        const existing = current.localRoutes.findIndex((route) => (route.alias ?? route.service) === alias);
        if (existing >= 0) current.localRoutes[existing] = intent;
        else current.localRoutes.push(intent);
      }
      current.localRoutes.sort((left, right) => (left.alias ?? left.service).localeCompare(right.alias ?? right.service));
      applyLocalRouteProjection(current);
      writeState(worktreeRoot, current);
      return current;
    }));
    await reconcileDaemonLocalRoutes(daemon.port);
    return record;
  }

  async removeLocalRoutes(cwd: string, services: string[]): Promise<StackRecord> {
    return this.resetLocalRoutes(cwd, services);
  }

  async disableLocalRoutes(cwd: string, services: string[]): Promise<StackRecord> {
    return this.#setLocalRouteOverride(cwd, services, "disable");
  }

  async resetLocalRoutes(cwd: string, services: string[]): Promise<StackRecord> {
    return this.#setLocalRouteOverride(cwd, services, "reset");
  }

  async #setLocalRouteOverride(
    cwd: string,
    services: string[],
    mode: "disable" | "reset",
  ): Promise<StackRecord> {
    if (services.length === 0) throw new HestiaError("usage", `Route ${mode}: at least one endpoint is required`);
    const currentIdentity = await getRepoInfo(cwd);
    const { worktreeRoot } = currentIdentity;
    const project = readState(worktreeRoot)?.project;
    if (project === undefined) throw new HestiaError("no-stack", `Route ${mode}: no stack for this worktree`);
    const record = await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const current = readState(worktreeRoot);
      if (current === null) throw new HestiaError("no-stack", `Route ${mode}: no stack for this worktree`);
      assertCurrentStackIdentity(current, currentIdentity);
      const selections = services.map((input) => resolveEndpointSelection(current, input));
      const names = new Set(selections.map((selection) => selection.endpoint.name));
      current.localRoutes = (current.localRoutes ?? []).filter(
        (route) => !names.has(route.alias ?? route.service),
      );
      if (current.localRoutes.length === 0) delete current.localRoutes;
      current.disabledLocalRoutes = (current.disabledLocalRoutes ?? []).filter(
        (route) => !names.has(route.alias ?? route.service),
      );
      if (mode === "disable") {
        for (const selection of selections) {
          current.disabledLocalRoutes.push({
            service: selection.workload,
            selector: selection.binding,
            alias: selection.endpoint.name,
          });
        }
      }
      if (current.disabledLocalRoutes.length === 0) delete current.disabledLocalRoutes;
      applyLocalRouteProjection(current);
      if (
        current.services.length === 0 &&
        current.composeFile === undefined &&
        effectiveLocalRouteServices(current).length === 0
      ) {
        clearState(worktreeRoot, current.project);
      } else {
        writeState(worktreeRoot, current);
      }
      return current;
    }));
    await this.#refreshLocalRoutes();
    return record;
  }

  async down(cwd: string, opts?: DownOptions): Promise<void> {
    const { repo, repoId, branch, worktreeRoot } = await getRepoInfo(cwd);
    let tunnel: TunnelRef | undefined;
    let initialRecord: StackRecord | null = null;
    try {
      initialRecord = readState(worktreeRoot);
    } catch (error) {
      if ((error as { code?: string }).code !== "state-corrupt") throw error;
    }
    const mutationProject = initialRecord?.project ?? projectName(repoId, repo, branch, worktreeRoot);
    await withLock(worktreeRoot, () => withLock(projectMutationRoot(mutationProject), async () => {
      let record: StackRecord | null = null;
      try {
        record = readState(worktreeRoot);
      } catch (error) {
        if ((error as { code?: string }).code !== "state-corrupt") throw error;
        if (opts?.expectedStack !== undefined) {
          throw new HestiaError("worktree-busy", "cannot verify confirmed stack identity against corrupt state");
        }
      }
      if (opts?.expectedStack !== undefined && !matchesExpectedStack(record, opts.expectedStack)) {
        throw new HestiaError("worktree-busy", "stack changed after down confirmation; retry");
      }
      tunnel = record?.tunnel;

      // procs first — they depend on the containers, not vice-versa
      for (const pf of listPidfiles(procsDir(worktreeRoot))) {
        await stopProcTree(pf);
        removePidfile(worktreeRoot, pf.name);
      }
      rmSync(privateRegistryDir(worktreeRoot), { recursive: true, force: true });

      const composeFile = record?.composeFile ?? tryLoadConfig(worktreeRoot)?.composeFile;
      if (composeFile !== undefined) {
        const project =
          record?.project ?? projectName(repoId, repo, branch, worktreeRoot);
        const overrideFile =
          record?.overrideFile ?? join(hestiaDir(worktreeRoot), OVERRIDE_FILE);
        if (existsSync(overrideFile)) {
          await composeDown(
            { project, baseFile: composeFile, overrideFile, cwd: worktreeRoot },
            opts?.destroy ?? false,
          );
        } else if (record?.composeFile !== undefined) {
          // Recorded compose services but the override is gone — tear down by
          // project label alone, same as the mirror path (needs no files).
          const rest = ["compose", "-p", project, "down", "--remove-orphans"];
          if (opts?.destroy) rest.push("-v");
          await pexec("docker", rest, { timeout: 180_000 });
        }
        // else: the repo has a compose file but this stack never composed
        // (procs-only `run` in a compose repo) — nothing docker-side to do.
      }

      const project = record?.project ?? projectName(repoId, repo, branch, worktreeRoot);
      clearState(worktreeRoot, project);
      await this.#releaseAdmission(project);
    }));
    // mirror is gone → regen drops this stack's ingress rules; the connector
    // keeps serving the base rules and other worktrees
    await this.#reconcileAdopted(tunnel);
    await this.#refreshLocalRoutes();
  }

  /** Best-effort slot release — waiters get their grant now instead of at the next sweep. */
  async #releaseAdmission(project: string): Promise<void> {
    const j = readDaemonJson();
    if (j !== null) await releaseSlot(j.port, project);
  }

  /**
   * Teardown by project name from the ~/.hestia mirror — the worktree (and its
   * lock) may no longer exist. Containers go down by label via `compose -p`,
   * which needs no compose files.
   */
  async downProject(project: string, opts?: DownOptions): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(project)) {
      throw new HestiaError("usage", `invalid project name ${JSON.stringify(project)}`);
    }
    let record: StackRecord | null = null;
    let mirrorCorrupt = false;
    try {
      record = readMirrorState(project);
    } catch (error) {
      if ((error as { code?: string }).code !== "state-corrupt") throw error;
      mirrorCorrupt = true;
    }
    const teardownFromMirror = async (): Promise<void> => {
      let fresh: StackRecord | null = null;
      try {
        fresh = readMirrorState(project);
      } catch (error) {
        if ((error as { code?: string }).code !== "state-corrupt") throw error;
        mirrorCorrupt = true;
      }
      if (mirrorCorrupt && opts?.expectedStack !== undefined) {
        throw new HestiaError("worktree-busy", "cannot verify confirmed stack identity against corrupt state");
      }
      if (opts?.expectedStack !== undefined && !matchesExpectedStack(fresh, opts.expectedStack)) {
        throw new HestiaError("worktree-busy", "stack changed after down confirmation; retry");
      }
      try {
        for (const pf of listPidfiles(mirrorProcsDir(project))) await stopProcTree(pf);
      } catch {
        // A corrupt pidfile is unsafe to signal. Continue with label-only
        // Docker cleanup and remove the corrupt mirror for manual proc audit.
      }
      try {
        const rest = ["compose", "-p", project, "down", "--remove-orphans"];
        if (opts?.destroy) rest.push("-v");
        await pexec("docker", rest, { timeout: 180_000 });
      } catch (err) {
        if (fresh?.composeFile !== undefined) {
          throw new HestiaError(
            "compose-failed",
            `docker compose -p ${project} down failed: ${(err as Error).message}`,
          );
        }
      }
      rmSync(mirrorDir(project), { recursive: true, force: true });
    };
    if (record !== null && existsSync(record.worktree)) {
      const info = await getRepoInfo(record.worktree);
      const identityMatches =
        resolve(info.worktreeRoot) === resolve(record.worktree) &&
        (record.repoId === undefined ? record.repo === info.repo : record.repoId === info.repoId);
      const localRecord = readState(record.worktree);
      if (identityMatches && localRecord?.project === record.project) {
        await this.down(record.worktree, opts);
        return;
      }
      if (identityMatches) {
        // A cleaned local .hestia directory still shares the worktree's
        // mutation lock with up/run, while teardown reads the surviving mirror.
        const usedMirror = await withLock(record.worktree, () =>
          withLock(projectMutationRoot(project), async () => {
            const current = readState(record.worktree);
            if (current?.project === project) return false;
            await teardownFromMirror();
            return true;
          })
        );
        if (!usedMirror) {
          await this.down(record.worktree, opts);
          return;
        }
        await this.#releaseAdmission(project);
        await this.#reconcileAdopted(record.tunnel);
        await this.#refreshLocalRoutes();
        return;
      }
    }

    // The mirror directory cannot host its own lock because successful
    // teardown removes it. Keep deleted-worktree serialization in a stable
    // project-lock directory outside the mirror being destroyed.
    const projectLockRoot = projectMutationRoot(project);
    await withLock(projectLockRoot, teardownFromMirror);
    await this.#releaseAdmission(project);
    await this.#reconcileAdopted(record?.tunnel);
    await this.#refreshLocalRoutes();
  }

  async expose(
    cwd: string,
    services: string[],
    opts?: ExposeOptions,
  ): Promise<StackRecord> {
    const currentIdentity = await getRepoInfo(cwd);
    const { worktreeRoot } = currentIdentity;
    if (services.length === 0) {
      throw new HestiaError("usage", "expose requires at least one service name");
    }
    // Mode pick: --tunnel wins, else the sticky adoption, else quick tunnels.
    const existingRecord = readState(worktreeRoot);
    if (existingRecord !== null) assertCurrentStackIdentity(existingRecord, currentIdentity);
    const tunnelName = opts?.tunnel ?? existingRecord?.tunnel?.name;
    if (tunnelName === undefined && opts?.keepHostHeader) {
      throw new HestiaError(
        "usage",
        "--keep-host-header is not supported for quick tunnels because guarded routing requires Hestia's internal authority",
      );
    }
    await ensureDaemon();
    await this.#refreshLocalRoutes(true);
    if (tunnelName === undefined) {
      return this.#exposeQuick(worktreeRoot, services, opts);
    }
    return this.#exposeNamed(worktreeRoot, services, tunnelName, opts);
  }

  /** One quick tunnel per service — zero-account, URL rotates per run. */
  async #exposeQuick(
    worktreeRoot: string,
    services: string[],
    opts?: ExposeOptions,
  ): Promise<StackRecord> {
    const project = readState(worktreeRoot)?.project;
    if (project === undefined) {
      throw new HestiaError("service-not-found", "no stack in this worktree — `hestia up`/`run` something first");
    }
    const exposed = await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record === null) {
        throw new HestiaError(
          "service-not-found",
          "no stack in this worktree — `hestia up`/`run` something first",
        );
      }
      for (const input of services) {
        const selection = resolveEndpointSelection(record, input);
        if (selection.endpoint.kind !== undefined && selection.endpoint.kind !== "http") {
          throw new HestiaError("usage", `public tunnels require an HTTP endpoint; ${input} is ${selection.endpoint.kind}`);
        }
        const alias = selection.endpoint.alias ?? selection.endpoint.name;
        const authority = internalEndpointAuthority(record.project, alias);
        const name = `aux-quick-${createHash("sha256").update(alias).digest("hex").slice(0, 10)}`;
        const quickCfg = join(hestiaDir(worktreeRoot), `quick-${name}.yml`);
        // A hostname-less ingress entry matches every request and is therefore
        // cloudflared's required terminal catch-all. It must remain the only
        // rule; appending `http_status:404` would make this catch-all non-final.
        writeAtomicTextFile(
          quickCfg,
          `ingress:\n  - service: ${JSON.stringify(`unix:${publicGatewaySocketPath()}`)}\n` +
            `    originRequest:\n      httpHostHeader: ${JSON.stringify(authority)}\n`,
        );
        const argv = [
          "cloudflared",
          "tunnel",
          "--config",
          quickCfg,
          "--metrics",
          "127.0.0.1:{port}",
          "--grace-period",
          "5s",
          "--no-autoupdate",
          "--url",
          "http://127.0.0.1:1",
        ];
        const existing = readPidfile(worktreeRoot, name);
        let metricsPort: number | undefined;
        if (
          existing !== null &&
          isLive(existing) &&
          existing.specFingerprint === procSpecFingerprint({
            name,
            argv,
            port: "auto",
            backend: "tunnel",
            originService: selection.workload,
            originEndpoint: alias,
            readyTimeoutMs: opts?.readyTimeoutMs,
          })
        ) {
          metricsPort = existing.port; // idempotent: same origin, still live
        } else {
          if (existing !== null) {
            if (isLive(existing)) await stopProcTree(existing);
            removePidfile(worktreeRoot, name);
          }
          const result = await startProc(
            worktreeRoot,
            {
              name,
              argv,
              port: "auto",
              backend: "tunnel",
              originService: selection.workload,
              originEndpoint: alias,
              readyTimeoutMs: opts?.readyTimeoutMs,
            },
            record.env,
            (pf) => mirrorPidfile(record.project, pf),
          );
          // metrics port only — never a public surface, so no recordProc
          upsertAuxiliary(record, result.record);
          metricsPort = result.record.publishedPort;
          if (result.error !== undefined) {
            writeState(worktreeRoot, record);
            throw result.error;
          }
        }
        const url =
          metricsPort !== undefined
            ? await quickTunnelUrl(metricsPort, opts?.readyTimeoutMs ?? 30_000)
            : null;
        if (url === null) {
          writeState(worktreeRoot, record);
          throw new HestiaError(
            "tunnel-ready-timeout",
            `quick tunnel for "${alias}" reported no URL in time (offline?) — ` +
              `left running, logs: .hestia/logs/${name}.log`,
          );
        }
        const ep = record.endpoints.find((endpoint) => endpoint.name === selection.endpoint.name);
        if (ep !== undefined) ep.publicUrl = url;
        else {
          setEndpoint(record, {
            name: alias,
            alias,
            workload: selection.workload,
            binding: selection.binding,
            kind: "http",
            host: "127.0.0.1",
            port: selection.endpoint.port,
            publicUrl: url,
          });
        }
        record.env[urlKey(alias)] = url;
      }
      writeState(worktreeRoot, record);
      return record;
    }));
    await this.#refreshLocalRoutes(true);
    return exposed;
  }

  /**
   * Unified named mode: adopt the existing tunnel, record this stack's
   * exposures (intent first — crash-safe), route DNS outside any lock, then
   * converge the machine-global connector. Lock order: worktree → global.
   */
  async #exposeNamed(
    worktreeRoot: string,
    services: string[],
    tunnelName: string,
    opts?: ExposeOptions,
  ): Promise<StackRecord> {
    const project = readState(worktreeRoot)?.project;
    if (project === undefined) {
      throw new HestiaError("service-not-found", "no stack in this worktree — `hestia up`/`run` something first");
    }
    // network preflight — no locks held. Foreign connectors (the user's
    // manual `tunnel run`, a teammate's replica) make the edge load-balance
    // hostnames across worktrees; hestia never kills processes it didn't
    // spawn, so it refuses to become connector #2.
    const adopted = await adoptTunnel(tunnelName);
    if (adopted.connections > 0 && !isAdopted(adopted.uuid) && !opts?.force) {
      throw new HestiaError(
        "tunnel-busy",
        `tunnel "${tunnelName}" already has ${adopted.connections} live ` +
          `connector(s) — stop the other cloudflared first (hestia's ` +
          `connector serves your static hostnames too), or pass --force to ` +
          `accept nondeterministic routing`,
      );
    }

    const preflightRecord = readState(worktreeRoot);
    if (preflightRecord === null) {
      throw new HestiaError("service-not-found", "stack disappeared while preparing exposure");
    }
    const baseRules = importBaseRules(adopted.uuid, tunnelName);
    const zone = opts?.zone ?? preflightRecord.tunnel?.zone ?? inferZone(baseRules);
    if (zone === undefined) {
      throw new HestiaError("usage", "cannot infer a zone from the tunnel's existing rules — pass --zone");
    }
    const preparedHostnames = new Map<string, { hostname: string; alias: string; workload: string; binding: string }>();
    for (const input of services) {
      const selection = resolveEndpointSelection(preflightRecord, input);
      if (selection.endpoint.kind !== undefined && selection.endpoint.kind !== "http") {
        throw new HestiaError("usage", `public tunnels require an HTTP endpoint; ${input} is ${selection.endpoint.kind}`);
      }
      const alias = selection.endpoint.alias ?? selection.endpoint.name;
      const hostname = hostnameFor(tunnelName, preflightRecord.branch, alias, zone);
      await assertNamedTunnelDns(hostname, adopted.uuid);
      preparedHostnames.set(input, {
        hostname,
        alias,
        workload: selection.workload,
        binding: selection.binding,
      });
    }

    await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record === null) {
        throw new HestiaError(
          "service-not-found",
          "no stack in this worktree — `hestia up`/`run` something first",
        );
      }
      const t: TunnelRef =
        record.tunnel !== undefined && record.tunnel.uuid === adopted.uuid
          ? record.tunnel
          : {
              name: tunnelName,
              uuid: adopted.uuid,
              zone,
              credFile: adopted.credFile,
              exposures: [],
            };
      t.name = tunnelName;
      t.zone = zone;
      t.credFile = adopted.credFile;
      record.tunnel = t;

      for (const input of services) {
        const prepared = preparedHostnames.get(input)!;
        const selection = resolveEndpointSelection(record, input);
        const exp = t.exposures.find((candidate) =>
          (candidate.alias ?? candidate.service) === prepared.alias);
        if (exp !== undefined) {
          exp.service = prepared.workload;
          exp.alias = prepared.alias;
          exp.binding = prepared.binding;
          exp.hostname = prepared.hostname;
          exp.originPort = selection.endpoint.port;
          exp.keepHostHeader = opts?.keepHostHeader;
        } else {
          t.exposures.push({
            service: prepared.workload,
            alias: prepared.alias,
            binding: prepared.binding,
            hostname: prepared.hostname,
            originPort: selection.endpoint.port,
            keepHostHeader: opts?.keepHostHeader,
          });
        }
      }
      // DNS was verified before intent publication; Hestia never mutates DNS.
      writeState(worktreeRoot, record);
    }));

    const outcome = await reconcileTunnel(
      { name: tunnelName, uuid: adopted.uuid, credFile: adopted.credFile },
      { force: opts?.force, readyTimeoutMs: opts?.readyTimeoutMs },
    );
    for (const w of outcome.warnings) process.stderr.write(`warning: ${w}\n`);

    const final = await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record === null) {
        throw new HestiaError(
          "service-not-found",
          "stack disappeared while exposing (concurrent down?)",
        );
      }
      for (const exp of record.tunnel?.exposures ?? []) {
        const url = `https://${exp.hostname}`;
        const alias = exp.alias ?? exp.service;
        const ep = record.endpoints.find((endpoint) => endpoint.name === alias);
        if (ep !== undefined) ep.publicUrl = url;
        else {
          setEndpoint(record, {
            name: alias,
            alias,
            workload: exp.service,
            binding: exp.binding,
            kind: "http",
            host: "127.0.0.1",
            port: exp.originPort,
            publicUrl: url,
          });
        }
        record.env[urlKey(alias)] = url;
      }
      writeState(worktreeRoot, record);
      return record;
    }));
    if (outcome.error !== undefined) throw outcome.error;
    await this.#refreshLocalRoutes(true);
    return final;
  }

  async status(cwd: string): Promise<StackRecord | null> {
    const { worktreeRoot } = await getRepoInfo(cwd);
    const record = readState(worktreeRoot);
    if (record === null) return null;

    let anyUp = false;

    // docker services: best-effort refresh of live health/ports
    if (record.composeFile !== undefined && record.overrideFile !== undefined) {
      try {
        const rows = await composePs({
          project: record.project,
          baseFile: record.composeFile,
          overrideFile: record.overrideFile,
          cwd: worktreeRoot,
        });
        const byName = new Map(rows.map((r) => [r.Service, r]));
        for (const svc of record.services) {
          if (svc.backend !== "docker") continue;
          const row = byName.get(svc.name);
          if (row === undefined) {
            svc.state = "exited";
            continue;
          }
          anyUp = true;
          svc.state =
            row.Health === "healthy" || row.State === "running"
              ? "healthy"
              : "unhealthy";
          const pub = publishedPortFor(row, svc.containerPort);
          if (pub !== undefined) {
            svc.publishedPort = pub;
            svc.containerId = row.ID ?? svc.containerId;
            const endpoint = record.endpoints.find((candidate) => candidate.name === svc.name);
            if (endpoint !== undefined) endpoint.port = pub;
          }
        }
      } catch {
        // docker unreachable — report last known state for docker services
        anyUp = record.services.some(
          (s) => s.backend === "docker" && s.state === "healthy",
        );
      }
    }

    // procs: live (pid + verbatim start-time) and still owning their port
    for (const svc of [...record.services, ...(record.auxiliary ?? [])]) {
      if (svc.backend === "docker") continue;
      const auxiliary = record.auxiliary?.includes(svc) ?? false;
      if (
        svc.pid === undefined ||
        !isLive({ pid: svc.pid, startTime: svc.startTime ?? "" })
      ) {
        svc.state = "exited";
        continue;
      }
      if (!auxiliary) anyUp = true;
      if (svc.publishedPort !== undefined) {
        try {
          const view = await inspectPort(svc.pid, svc.publishedPort);
          svc.state = view.ownerIsMember ? "healthy" : "unhealthy";
        } catch {
          svc.state = "healthy"; // ownership tool missing — alive is the best we know
        }
      } else {
        svc.state = "healthy";
      }
      const endpoint = record.endpoints.find((candidate) => candidate.name === svc.name);
      if (endpoint !== undefined && svc.publishedPort !== undefined) endpoint.port = svc.publishedPort;
      // quick tunnel that connected after its expose timed out: surface the URL
      if (
        svc.backend === "tunnel" &&
        svc.originService !== undefined &&
        svc.state === "healthy" &&
        svc.publishedPort !== undefined &&
        record.env[urlKey(svc.originEndpoint ?? svc.originService)] === undefined
      ) {
        const url = await quickTunnelUrl(svc.publishedPort, 1_000);
        if (url !== null) {
          const endpointName = svc.originEndpoint ?? svc.originService;
          record.env[urlKey(endpointName)] = url;
          const ep = record.endpoints.find((e) => e.name === endpointName);
          if (ep !== undefined) ep.publicUrl = url;
        }
      }
    }

    // named mode: the global connector, viewed from this stack
    if (record.tunnel !== undefined) {
      const pf = connectorPidfile(record.tunnel.uuid);
      let state: ServiceRecord["state"] = "exited";
      if (pf !== null && isLive(pf)) {
        // an exposure aimed at a port this stack no longer holds is the
        // misdelivery hazard — report it, don't hide it behind /ready
        const portsCurrent = record.tunnel.exposures.every((exp) => {
          const svc = record.services.find((s) => s.name === exp.service);
          const binding = svc?.bindings?.find((candidate) =>
            `${candidate.target}/${candidate.protocol}` === exp.binding);
          return (binding?.publishedPort ?? svc?.publishedPort) === exp.originPort;
        });
        const ready =
          pf.port !== undefined ? await isReady(pf.port) : false;
        state = portsCurrent && ready ? "healthy" : "unhealthy";
      }
      upsertService(record, {
        name: "tunnel",
        backend: "tunnel",
        state,
        pid: pf?.pid,
        pgid: pf?.pgid,
        startTime: pf?.startTime,
        logPath: pf?.logPath,
      });
    }

    record.state = anyUp ? "up" : "stopped";
    applyLocalRouteProjection(record);
    return record;
  }

  restartService(): Promise<void> {
    throw new NotImplemented("restartService");
  }
}

export const engine = new ComposeEngine();
