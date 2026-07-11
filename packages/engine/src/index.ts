import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
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
import { getRepoInfo } from "./git.ts";
import { generateOverride } from "./compose/override.ts";
import {
  type ComposeCtx,
  composeConfig,
  composeDown,
  composePs,
  composeUp,
  publishedPortFor,
  waitReady,
} from "./compose/cli.ts";
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
  writeState,
} from "./state.ts";
import { withLock } from "./proc/lock.ts";
import { envKey, startProc } from "./proc/supervisor.ts";
import {
  type Pidfile,
  isLive,
  listPidfiles,
  procsDir,
  readPidfile,
  removePidfile,
  startTimeOf,
} from "./proc/pidfile.ts";
import { stopProcTree } from "./proc/shutdown.ts";
import { inspectPort } from "./proc/ports.ts";
import { resolvedLocalRouteHostname, verifyStackServiceOrigin } from "./router/local-http-router.ts";
import { detectVarlock } from "./proc/resolver.ts";
import { planWorkers, privateRegistryDir } from "./wrangler/adapter.ts";
import {
  globalGainWarnings,
  snapshotGlobalRegistry,
  verifyPrivateRegistry,
} from "./wrangler/verify.ts";
import { adoptTunnel, routeDns } from "./tunnel/cloudflared.ts";
import { hostnameFor, importBaseRules, inferZone } from "./tunnel/ingress.ts";
import {
  connectorPidfile,
  isAdopted,
  ledgerAdd,
  ledgerHas,
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
export {
  LAUNCHD_LABEL,
  installLaunchd,
  isBootstrapped,
  launchdManagesThisHome,
  plistPath,
  uninstallLaunchd,
} from "./daemon/launchd.ts";

const OVERRIDE_FILE = "compose.override.yml";

interface Prepared {
  ctx: ComposeCtx;
  services: string[];
  servicePorts: Record<string, number[]>;
  composeFile: string;
  overridePath: string;
}

/** Compose-side preparation: parse the user file, write the override. */
function prepareCompose(
  worktreeRoot: string,
  project: string,
  repo: string,
  branch: string,
  opts?: UpOptions,
): Prepared {
  const cfg = loadConfig(worktreeRoot);
  const services = opts?.services ?? cfg.services;

  const userCompose = parseYaml(readFileSync(cfg.composeFile, "utf8"));
  const { yaml, servicePorts } = generateOverride({
    userCompose,
    project,
    repo,
    branch,
    worktree: worktreeRoot,
    services,
  });

  ensureDir(hestiaDir(worktreeRoot));
  const overridePath = join(hestiaDir(worktreeRoot), OVERRIDE_FILE);
  writeFileSync(overridePath, yaml);

  return {
    ctx: {
      project,
      baseFile: cfg.composeFile,
      overrideFile: overridePath,
      cwd: worktreeRoot,
    },
    services,
    servicePorts,
    composeFile: cfg.composeFile,
    overridePath,
  };
}

function freshRecord(
  project: string,
  repoId: RepoId,
  repo: string,
  branch: string,
  worktree: string,
): StackRecord {
  return {
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

function upsertService(record: StackRecord, svc: ServiceRecord): void {
  const i = record.services.findIndex((s) => s.name === svc.name);
  if (i >= 0) record.services[i] = svc;
  else record.services.push(svc);
}

function setEndpoint(record: StackRecord, ep: Endpoint): void {
  const i = record.endpoints.findIndex((e) => e.name === ep.name);
  if (i >= 0) {
    const previous = record.endpoints[i]!;
    const portRotated = previous.port !== ep.port;
    const namedExposure = record.tunnel?.exposures.some((exposure) => exposure.service === ep.name) ?? false;
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

function recordProc(
  record: StackRecord,
  svc: ServiceRecord,
): void {
  upsertService(record, svc);
  if (svc.publishedPort !== undefined) {
    record.env[`HESTIA_${envKey(svc.name)}_PORT`] = String(svc.publishedPort);
    setEndpoint(record, {
      name: svc.name,
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
    if (!selected.has(endpoint.name)) {
      // A port is not automatically HTTP: route intent is the protocol declaration.
      // Unselected TCP services retain the baseline host/port without invented URLs.
      delete endpoint.url;
      delete endpoint.localUrl;
      delete record.env[directUrlKey(endpoint.name)];
      delete record.env[localUrlKey(endpoint.name)];
      continue;
    }
    const service = record.services.find((candidate) => candidate.name === endpoint.name);
    if (service?.publishedPort === undefined || service.backend === "tunnel") continue;
    endpoint.host = "127.0.0.1";
    endpoint.port = service.publishedPort;
    endpoint.url = `http://127.0.0.1:${service.publishedPort}`;
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
    if (svc?.publishedPort === undefined) {
      changed = true; // origin gone — regen drops the rule (404, never a stale port)
    } else if (svc.publishedPort !== exp.originPort) {
      exp.originPort = svc.publishedPort;
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
        if (rec !== null && rec.state === "starting" && rec.services.length === 0) {
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
    const { repo, repoId, branch, worktreeRoot } = await getRepoInfo(cwd);
    const project = projectName(repo, branch, worktreeRoot);
    let tunnelDirty = false;

    const admission = await this.#admit(project, repoId, repo, branch, worktreeRoot, opts);
    let done: StackRecord;
    try {
      done = await this.#upLocked(worktreeRoot, project, repoId, repo, branch, admission.createdAt, opts, (d) => {
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

  async #upLocked(
    worktreeRoot: string,
    project: string,
    repoId: RepoId,
    repo: string,
    branch: string,
    admittedCreatedAt: string,
    opts: UpOptions | undefined,
    setTunnelDirty: (d: boolean) => void,
  ): Promise<StackRecord> {
    return withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record?.createdAt !== admittedCreatedAt) {
        throw new HestiaError("worktree-busy", "stack was removed after admission; start cancelled");
      }
      record.repoId ??= repoId;
      const hasCompose = tryLoadConfig(worktreeRoot) !== null;
      if (!hasCompose && !opts?.workers) {
        // plain `up` still means "compose up" — procs arrive via `run`
        loadConfig(worktreeRoot); // throws config-missing
      }

      if (hasCompose) {
        const p = prepareCompose(worktreeRoot, project, repo, branch, opts);
        await composeConfig(p.ctx);
        await composeUp(p.ctx);
        const rows = await waitReady(p.ctx, p.services);
        const byName = new Map(rows.map((r) => [r.Service, r]));

        for (const svc of p.services) {
          const proc = record.services.find(
            (s) => s.name === svc && s.backend !== "docker",
          );
          if (proc !== undefined) {
            throw new HestiaError(
              "name-conflict",
              `compose service "${svc}" collides with a running proc of the same name`,
            );
          }
          const row = byName.get(svc);
          const cports = p.servicePorts[svc] ?? [];
          let canonical: number | undefined;
          for (const cp of cports) {
            const pub = publishedPortFor(row, cp);
            if (pub !== undefined && canonical === undefined) canonical = pub;
          }
          upsertService(record, {
            name: svc,
            backend: "docker",
            state: "healthy",
            containerPort: cports[0],
            publishedPort: canonical,
            containerId: row?.ID,
          });
          if (canonical !== undefined) {
            record.env[`HESTIA_${envKey(svc)}_PORT`] = String(canonical);
            setEndpoint(record, {
              name: svc,
              host: "127.0.0.1",
              port: canonical,
              reservedName: `${svc}.${branch}.${repo}.localhost`,
            });
          }
        }
        record.composeFile = p.composeFile;
        record.overrideFile = p.overridePath;
      }

      if (opts?.workers) {
        await this.#upWorkers(worktreeRoot, record, opts);
      }

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
    const project = projectName(repo, branch, worktreeRoot);
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
        const sameCmd =
          JSON.stringify(existing.argv) === JSON.stringify(spec.argv) &&
          JSON.stringify(existing.env ?? {}) === JSON.stringify(spec.env ?? {});
        if (sameCmd) return record; // idempotent no-op: already running this
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
    const { repo, branch, worktreeRoot } = await getRepoInfo(cwd);
    let tunnel: TunnelRef | undefined;
    let tunnelDirty = false;
    const project = readState(worktreeRoot)?.project ?? projectName(repo, branch, worktreeRoot);
    await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const pf = readPidfile(worktreeRoot, name);
      if (pf !== null) {
        await stopProcTree(pf);
        removePidfile(worktreeRoot, name);
      }
      const record = readState(worktreeRoot);
      if (record !== null) {
        // a quick tunnel going down takes its origin's public URL with it
        const stopped = record.services.find((s) => s.name === name);
        if (stopped?.originService !== undefined) {
          const ep = record.endpoints.find(
            (e) => e.name === stopped.originService,
          );
          if (ep !== undefined) delete ep.publicUrl;
          delete record.env[urlKey(stopped.originService)];
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
    const { worktreeRoot } = await getRepoInfo(cwd);
    const project = readState(worktreeRoot)?.project;
    if (project === undefined) throw new HestiaError("no-stack", "Route add: no stack for this worktree");
    const record = await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const current = readState(worktreeRoot);
      if (current === null) throw new HestiaError("no-stack", "Route add: no stack for this worktree");
      for (const serviceName of services) {
        const service = current.services.find((candidate) => candidate.name === serviceName);
        if (service?.publishedPort === undefined || service.backend === "tunnel") {
          throw new HestiaError(
            "route-origin-unavailable",
            `Route add: service "${serviceName}" is not running with a direct port`,
          );
        }
        if (!await verifyStackServiceOrigin(current, service)) {
          throw new HestiaError(
            "route-origin-unavailable",
            `Route add: service "${serviceName}" no longer owns its recorded direct port`,
          );
        }
      }
      current.localRoutes ??= [];
      for (const service of services) {
        if (!current.localRoutes.some((route) => route.service === service)) {
          current.localRoutes.push({ service });
        }
      }
      current.localRoutes.sort((left, right) => left.service.localeCompare(right.service));
      applyLocalRouteProjection(current);
      writeState(worktreeRoot, current);
      return current;
    }));
    await reconcileDaemonLocalRoutes(daemon.port);
    return record;
  }

  async removeLocalRoutes(cwd: string, services: string[]): Promise<StackRecord> {
    if (services.length === 0) throw new HestiaError("usage", "Route remove: at least one service is required");
    const { worktreeRoot } = await getRepoInfo(cwd);
    const project = readState(worktreeRoot)?.project;
    if (project === undefined) throw new HestiaError("no-stack", "Route remove: no stack for this worktree");
    const record = await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const current = readState(worktreeRoot);
      if (current === null) throw new HestiaError("no-stack", "Route remove: no stack for this worktree");
      const removing = new Set(services);
      current.localRoutes = (current.localRoutes ?? []).filter((route) => !removing.has(route.service));
      if (current.localRoutes.length === 0) delete current.localRoutes;
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
    const { repo, branch, worktreeRoot } = await getRepoInfo(cwd);
    let tunnel: TunnelRef | undefined;
    const mutationProject = readState(worktreeRoot)?.project ??
      projectName(repo, branch, worktreeRoot);
    await withLock(worktreeRoot, () => withLock(projectMutationRoot(mutationProject), async () => {
      const record = readState(worktreeRoot);
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
          record?.project ?? projectName(repo, branch, worktreeRoot);
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

      const project = record?.project ?? projectName(repo, branch, worktreeRoot);
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
    const record = readMirrorState(project);
    const teardownFromMirror = async (): Promise<void> => {
      const fresh = readMirrorState(project);
      if (opts?.expectedStack !== undefined && !matchesExpectedStack(fresh, opts.expectedStack)) {
        throw new HestiaError("worktree-busy", "stack changed after down confirmation; retry");
      }
      for (const pf of listPidfiles(mirrorProcsDir(project))) {
        await stopProcTree(pf);
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
    const { worktreeRoot } = await getRepoInfo(cwd);
    if (services.length === 0) {
      throw new HestiaError("usage", "expose requires at least one service name");
    }
    // Mode pick: --tunnel wins, else the sticky adoption, else quick tunnels.
    const tunnelName = opts?.tunnel ?? readState(worktreeRoot)?.tunnel?.name;
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
    return withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record === null) {
        throw new HestiaError(
          "service-not-found",
          "no stack in this worktree — `hestia up`/`run` something first",
        );
      }
      // An explicit empty config blocks cloudflared's implicit load of
      // ~/.cloudflared/config.yml — its ingress rules would silently override
      // --url and 404 every request (verified against 2026.3.0).
      const quickCfg = join(hestiaDir(worktreeRoot), "quick-tunnel.yml");
      ensureDir(hestiaDir(worktreeRoot));
      writeFileSync(quickCfg, "# empty on purpose: keeps --url in effect\n");

      for (const svc of services) {
        const target = record.services.find((s) => s.name === svc);
        if (target?.publishedPort === undefined || target.backend === "tunnel") {
          throw new HestiaError(
            "service-not-found",
            `service "${svc}" is not running with a port in this stack`,
          );
        }
        const name = `tunnel-${svc}`;
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
          `http://127.0.0.1:${target.publishedPort}`,
        ];
        const existing = readPidfile(worktreeRoot, name);
        let metricsPort: number | undefined;
        if (
          existing !== null &&
          isLive(existing) &&
          JSON.stringify(existing.argv) === JSON.stringify(argv)
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
              originService: svc,
              readyTimeoutMs: opts?.readyTimeoutMs,
            },
            record.env,
            (pf) => mirrorPidfile(record.project, pf),
          );
          // metrics port only — never a public surface, so no recordProc
          upsertService(record, result.record);
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
            `quick tunnel for "${svc}" reported no URL in time (offline?) — ` +
              `left running, logs: .hestia/logs/${name}.log`,
          );
        }
        const ep = record.endpoints.find((e) => e.name === svc);
        if (ep !== undefined) ep.publicUrl = url;
        else {
          setEndpoint(record, {
            name: svc,
            host: "127.0.0.1",
            port: target.publishedPort,
            publicUrl: url,
          });
        }
        record.env[urlKey(svc)] = url;
      }
      writeState(worktreeRoot, record);
      return record;
    }));
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

    const newHostnames: string[] = [];
    await withLock(worktreeRoot, () => withLock(projectMutationRoot(project), async () => {
      const record = readState(worktreeRoot);
      if (record === null) {
        throw new HestiaError(
          "service-not-found",
          "no stack in this worktree — `hestia up`/`run` something first",
        );
      }
      const base = importBaseRules(adopted.uuid, tunnelName);
      const zone = opts?.zone ?? record.tunnel?.zone ?? inferZone(base);
      if (zone === undefined) {
        throw new HestiaError(
          "usage",
          "cannot infer a zone from the tunnel's existing rules — pass --zone",
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

      for (const svc of services) {
        const target = record.services.find((s) => s.name === svc);
        if (target?.publishedPort === undefined || target.backend === "tunnel") {
          throw new HestiaError(
            "service-not-found",
            `service "${svc}" is not running with a port in this stack`,
          );
        }
        const hostname = hostnameFor(tunnelName, record.branch, svc, zone);
        const exp = t.exposures.find((e) => e.service === svc);
        if (exp !== undefined) {
          exp.hostname = hostname;
          exp.originPort = target.publishedPort;
          exp.keepHostHeader = opts?.keepHostHeader;
        } else {
          t.exposures.push({
            service: svc,
            hostname,
            originPort: target.publishedPort,
            keepHostHeader: opts?.keepHostHeader,
          });
        }
        if (!ledgerHas(adopted.uuid, hostname)) newHostnames.push(hostname);
      }
      // exposure intent is on disk (and mirrored) before any account mutation
      writeState(worktreeRoot, record);
    }));

    // DNS — network, no locks; ledger makes re-runs no-ops
    for (const hostname of newHostnames) {
      await routeDns(adopted.uuid, hostname, opts?.overwriteDns ?? false);
      ledgerAdd(adopted.uuid, hostname);
    }

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
        const ep = record.endpoints.find((e) => e.name === exp.service);
        if (ep !== undefined) ep.publicUrl = url;
        else {
          setEndpoint(record, {
            name: exp.service,
            host: "127.0.0.1",
            port: exp.originPort,
            publicUrl: url,
          });
        }
        record.env[urlKey(exp.service)] = url;
      }
      writeState(worktreeRoot, record);
      return record;
    }));
    if (outcome.error !== undefined) throw outcome.error;
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
    for (const svc of record.services) {
      if (svc.backend === "docker") continue;
      if (
        svc.pid === undefined ||
        !isLive({ pid: svc.pid, startTime: svc.startTime ?? "" })
      ) {
        svc.state = "exited";
        continue;
      }
      anyUp = true;
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
        record.env[urlKey(svc.originService)] === undefined
      ) {
        const url = await quickTunnelUrl(svc.publishedPort, 1_000);
        if (url !== null) {
          record.env[urlKey(svc.originService)] = url;
          const ep = record.endpoints.find((e) => e.name === svc.originService);
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
          return svc?.publishedPort === exp.originPort;
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
