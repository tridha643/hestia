import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type DownOptions,
  type Endpoint,
  type IsolationEngine,
  type ProcSpec,
  type ServiceRecord,
  type StackRecord,
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
} from "./proc/pidfile.ts";
import { stopProcTree } from "./proc/shutdown.ts";
import { inspectPort } from "./proc/ports.ts";
import { detectVarlock } from "./proc/resolver.ts";
import { planWorkers, privateRegistryDir } from "./wrangler/adapter.ts";
import {
  globalGainWarnings,
  snapshotGlobalRegistry,
  verifyPrivateRegistry,
} from "./wrangler/verify.ts";

export { dockerAvailable } from "./compose/cli.ts";
export * from "./compose/override.ts";
export { withLock } from "./proc/lock.ts";
export { substitutePort, envKey } from "./proc/supervisor.ts";
export * from "./proc/ports.ts";
export * from "./proc/pidfile.ts";
export * from "./proc/resolver.ts";
export * from "./wrangler/discover.ts";
export { privateRegistryDir, globalRegistryDir } from "./wrangler/adapter.ts";

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
  repo: string,
  branch: string,
  worktree: string,
): StackRecord {
  return {
    project,
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
  if (i >= 0) record.endpoints[i] = ep;
  else record.endpoints.push(ep);
}

function dropService(record: StackRecord, name: string): void {
  record.services = record.services.filter((s) => s.name !== name);
  record.endpoints = record.endpoints.filter((e) => e.name !== name);
  delete record.env[`HESTIA_${envKey(name)}_PORT`];
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

const pexec = promisify(execFile);

export class ComposeEngine implements IsolationEngine {
  async up(cwd: string, opts?: UpOptions): Promise<StackRecord> {
    const { repo, branch, worktreeRoot } = await getRepoInfo(cwd);
    const project = projectName(repo, branch, worktreeRoot);

    return withLock(worktreeRoot, async () => {
      const record =
        readState(worktreeRoot) ??
        freshRecord(project, repo, branch, worktreeRoot);
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
      writeState(worktreeRoot, record);
      return record;
    });
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

  async run(cwd: string, spec: ProcSpec): Promise<StackRecord> {
    const { repo, branch, worktreeRoot } = await getRepoInfo(cwd);
    const project = projectName(repo, branch, worktreeRoot);

    return withLock(worktreeRoot, async () => {
      const record =
        readState(worktreeRoot) ??
        freshRecord(project, repo, branch, worktreeRoot);

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

      const result = await startProc(worktreeRoot, spec, record.env, (pf) =>
        mirrorPidfile(record.project, pf),
      );
      recordProc(record, result.record);
      record.state = "up";
      writeState(worktreeRoot, record);
      if (result.error !== undefined) throw result.error;
      return record;
    });
  }

  async stopService(cwd: string, name: string): Promise<void> {
    const { worktreeRoot } = await getRepoInfo(cwd);
    await withLock(worktreeRoot, async () => {
      const pf = readPidfile(worktreeRoot, name);
      if (pf !== null) {
        await stopProcTree(pf);
        removePidfile(worktreeRoot, name);
      }
      const record = readState(worktreeRoot);
      if (record !== null) {
        dropService(record, name);
        if (record.services.length === 0 && record.composeFile === undefined) {
          clearState(worktreeRoot, record.project);
        } else {
          writeState(worktreeRoot, record);
        }
      }
    });
  }

  async down(cwd: string, opts?: DownOptions): Promise<void> {
    const { repo, branch, worktreeRoot } = await getRepoInfo(cwd);
    await withLock(worktreeRoot, async () => {
      const record = readState(worktreeRoot);

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
        await composeDown(
          { project, baseFile: composeFile, overrideFile, cwd: worktreeRoot },
          opts?.destroy ?? false,
        );
      }

      const project = record?.project ?? projectName(repo, branch, worktreeRoot);
      clearState(worktreeRoot, project);
    });
  }

  /**
   * Teardown by project name from the ~/.hestia mirror — the worktree (and its
   * lock) may no longer exist. Containers go down by label via `compose -p`,
   * which needs no compose files.
   */
  async downProject(project: string, opts?: DownOptions): Promise<void> {
    const record = readMirrorState(project);
    for (const pf of listPidfiles(mirrorProcsDir(project))) {
      await stopProcTree(pf);
    }
    try {
      const rest = ["compose", "-p", project, "down", "--remove-orphans"];
      if (opts?.destroy) rest.push("-v");
      await pexec("docker", rest, { timeout: 180_000 });
    } catch (err) {
      // procs-only stacks tolerate docker being absent; compose stacks don't
      if (record?.composeFile !== undefined) {
        throw new HestiaError(
          "compose-failed",
          `docker compose -p ${project} down failed: ${(err as Error).message}`,
        );
      }
    }
    rmSync(mirrorDir(project), { recursive: true, force: true });
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
          if (pub !== undefined) svc.publishedPort = pub;
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
    }

    record.state = anyUp ? "up" : "stopped";
    return record;
  }

  restartService(): Promise<void> {
    throw new NotImplemented("restartService");
  }
}

export const engine = new ComposeEngine();
