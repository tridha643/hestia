import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type DownOptions,
  type Endpoint,
  type IsolationEngine,
  type ServiceRecord,
  type StackRecord,
  type UpOptions,
  NotImplemented,
  projectName,
} from "@hestia/core";
import { loadConfig } from "./config.ts";
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
  readState,
  writeState,
} from "./state.ts";

export { dockerAvailable } from "./compose/cli.ts";
export * from "./compose/override.ts";

const OVERRIDE_FILE = "compose.override.yml";

interface Prepared {
  ctx: ComposeCtx;
  services: string[];
  servicePorts: Record<string, number[]>;
  repo: string;
  branch: string;
  worktreeRoot: string;
  composeFile: string;
  overridePath: string;
}

/** Everything common to up/down: resolve identity, write the override file. */
async function prepare(cwd: string, opts?: UpOptions): Promise<Prepared> {
  const { repo, branch, worktreeRoot } = await getRepoInfo(cwd);
  const cfg = loadConfig(worktreeRoot);
  const services = opts?.services ?? cfg.services;
  const project = projectName(repo, branch, worktreeRoot);

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
    repo,
    branch,
    worktreeRoot,
    composeFile: cfg.composeFile,
    overridePath,
  };
}

function envKey(service: string): string {
  return service.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export class ComposeEngine implements IsolationEngine {
  async up(cwd: string, opts?: UpOptions): Promise<StackRecord> {
    const p = await prepare(cwd, opts);

    await composeConfig(p.ctx);
    await composeUp(p.ctx);
    const rows = await waitReady(p.ctx, p.services);
    const byName = new Map(rows.map((r) => [r.Service, r]));

    // Surface each service's ephemeral host port as HESTIA_<SVC>_PORT + an
    // endpoint. The caller wires whatever URLs it needs from these.
    const serviceRecords: ServiceRecord[] = [];
    const endpoints: Endpoint[] = [];
    const env: Record<string, string> = {};

    for (const svc of p.services) {
      const row = byName.get(svc);
      const cports = p.servicePorts[svc] ?? [];
      let canonical: number | undefined;
      for (const cp of cports) {
        const pub = publishedPortFor(row, cp);
        if (pub !== undefined && canonical === undefined) canonical = pub;
      }

      serviceRecords.push({
        name: svc,
        backend: "docker",
        state: "healthy",
        containerPort: cports[0],
        publishedPort: canonical,
      });

      if (canonical !== undefined) {
        env[`HESTIA_${envKey(svc)}_PORT`] = String(canonical);
        endpoints.push({
          name: svc,
          host: "127.0.0.1",
          port: canonical,
          reservedName: `${svc}.${p.branch}.${p.repo}.localhost`,
        });
      }
    }

    const record: StackRecord = {
      project: p.ctx.project,
      repo: p.repo,
      branch: p.branch,
      worktree: p.worktreeRoot,
      state: "up",
      services: serviceRecords,
      env,
      endpoints,
      createdAt: new Date().toISOString(),
      composeFile: p.composeFile,
      overrideFile: p.overridePath,
    };
    writeState(p.worktreeRoot, record);
    return record;
  }

  async down(cwd: string, opts?: DownOptions): Promise<void> {
    const p = await prepare(cwd);
    await composeDown(p.ctx, opts?.destroy ?? false);
    clearState(p.worktreeRoot, p.ctx.project);
  }

  async status(cwd: string): Promise<StackRecord | null> {
    const { worktreeRoot } = await getRepoInfo(cwd);
    const record = readState(worktreeRoot);
    if (record === null) return null;

    // Best-effort refresh of live health/ports.
    try {
      const rows = await composePs({
        project: record.project,
        baseFile: record.composeFile,
        overrideFile: record.overrideFile,
        cwd: worktreeRoot,
      });
      const byName = new Map(rows.map((r) => [r.Service, r]));
      let anyUp = false;
      for (const svc of record.services) {
        const row = byName.get(svc.name);
        if (row === undefined) {
          svc.state = "exited";
          continue;
        }
        anyUp = true;
        svc.state = row.Health === "healthy" || row.State === "running"
          ? "healthy"
          : "unhealthy";
        const pub = publishedPortFor(row, svc.containerPort);
        if (pub !== undefined) svc.publishedPort = pub;
      }
      record.state = anyUp ? "up" : "stopped";
    } catch {
      // docker unreachable — report last known state
    }
    return record;
  }

  restartService(): Promise<void> {
    throw new NotImplemented("restartService");
  }
}

export const engine = new ComposeEngine();
