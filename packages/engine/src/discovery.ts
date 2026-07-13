import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { HestiaError } from "@hestia/core";
import { getRepoInfo } from "./git.ts";
import { readState } from "./state.ts";
import { discoverWorkers } from "./wrangler/discover.ts";
import { tryLoadConfig } from "./config.ts";
import { composeContainerBindings } from "./compose/override.ts";
import {
  machineRepositoryConfigPath,
  readConfigLayer,
  repositoryConfigPath,
  type ConfiguredEndpoint,
  type ConfiguredWorkload,
  type RepositoryWorkloadConfig,
  type WorkloadSource,
} from "./repository-config.ts";

const pexec = promisify(execFile);

export type DiscoverySource = "discovery" | "repository" | "machine" | "worktree";

export interface DiscoveredBinding {
  target: string;
  protocol: "tcp" | "udp";
  configuredEndpoints: string[];
}

export interface DiscoveredWorkload {
  name: string;
  source: WorkloadSource;
  runnable: boolean;
  configured: boolean;
  decisionSource: DiscoverySource;
  definitionPath?: string;
  bindings: DiscoveredBinding[];
  endpoints: Array<ConfiguredEndpoint & { alias: string; source: DiscoverySource }>;
  notes: string[];
}

export interface DiscoveryReport {
  version: 1;
  repository: {
    repo: string;
    repoId: string;
    branch: string;
    worktree: string;
  };
  layers: Array<{ source: DiscoverySource; path?: string; present: boolean }>;
  runnableWorkloads: DiscoveredWorkload[];
  candidateWorkloads: DiscoveredWorkload[];
  missingDecisions: string[];
  conflicts: string[];
  suggestions: string[];
  existingStack: { project: string; state: string; schemaVersion?: number } | null;
}

interface ResolvedComposePort {
  target: string;
  protocol: "tcp" | "udp";
}

interface ResolvedComposeService {
  name: string;
  ports: ResolvedComposePort[];
}

async function resolveComposeServices(composeFile: string, cwd: string): Promise<ResolvedComposeService[]> {
  try {
    const { stdout } = await pexec(
      "docker",
      ["compose", "-f", composeFile, "config", "--format", "json"],
      { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const model = JSON.parse(stdout) as {
      services?: Record<string, { ports?: Array<{ target?: number; protocol?: string }> }>;
    };
    return Object.entries(model.services ?? {}).map(([name, service]) => ({
      name,
      ports: (service.ports ?? []).flatMap((port) =>
        Number.isInteger(port.target) && (port.protocol === undefined || port.protocol === "tcp" || port.protocol === "udp")
          ? [{ target: String(port.target), protocol: (port.protocol ?? "tcp") as "tcp" | "udp" }]
          : []
      ),
    }));
  } catch {
    const config = tryLoadConfig(cwd);
    if (config === null) return [];
    try {
      const model = parseYaml(readFileSync(config.composeFile, "utf8")) as {
        services?: Record<string, { ports?: unknown }>;
      } | null;
      return Object.entries(model?.services ?? {}).map(([name, service]) => ({
        name,
        ports: composeContainerBindings(service.ports).map((port) => ({
          target: String(port.target),
          protocol: port.protocol,
        })),
      }));
    } catch {
      return config.services.map((name) => ({ name, ports: [] }));
    }
  }
}

function sameEndpoint(left: ConfiguredEndpoint, right: ConfiguredEndpoint): boolean {
  return left.binding === right.binding && left.kind === right.kind && left.local === right.local;
}

function cloneWorkload(workload: ConfiguredWorkload): ConfiguredWorkload {
  return {
    ...workload,
    command: workload.command?.slice(),
    env: { ...workload.env },
    endpoints: { ...workload.endpoints },
  };
}

function mergeConfigLayers(
  repository: RepositoryWorkloadConfig,
  machine: RepositoryWorkloadConfig,
): {
  workloads: Record<string, ConfiguredWorkload>;
  sources: Map<string, DiscoverySource>;
  endpointSources: Map<string, DiscoverySource>;
  conflicts: string[];
} {
  const workloads: Record<string, ConfiguredWorkload> = {};
  const sources = new Map<string, DiscoverySource>();
  const endpointSources = new Map<string, DiscoverySource>();
  const conflicts: string[] = [];
  for (const [name, workload] of Object.entries(repository.workloads)) {
    workloads[name] = cloneWorkload(workload);
    sources.set(name, "repository");
    for (const alias of Object.keys(workload.endpoints)) endpointSources.set(`${name}\0${alias}`, "repository");
  }
  for (const [name, overlay] of Object.entries(machine.workloads)) {
    const committed = workloads[name];
    if (committed === undefined) {
      workloads[name] = cloneWorkload(overlay);
      sources.set(name, "machine");
      for (const alias of Object.keys(overlay.endpoints)) endpointSources.set(`${name}\0${alias}`, "machine");
      continue;
    }
    if (overlay.source !== committed.source) {
      conflicts.push(`machine workload ${name} cannot replace committed source ${committed.source} with ${overlay.source}`);
      continue;
    }
    committed.cwd = overlay.cwd ?? committed.cwd;
    committed.varlock = overlay.varlock ?? committed.varlock;
    committed.healthPath = overlay.healthPath ?? committed.healthPath;
    committed.env = { ...committed.env, ...overlay.env };
    for (const [alias, endpoint] of Object.entries(overlay.endpoints)) {
      const existing = committed.endpoints[alias];
      if (existing !== undefined && !sameEndpoint(existing, endpoint)) {
        conflicts.push(`endpoint alias ${alias} for workload ${name} differs between repository and machine config`);
      } else {
        committed.endpoints[alias] = endpoint;
        endpointSources.set(`${name}\0${alias}`, "machine");
      }
    }
  }
  return { workloads, sources, endpointSources, conflicts };
}

/** Resolve committed plus machine-local workload configuration for lifecycle commands. */
export async function resolveConfiguredWorkloads(cwd: string): Promise<{
  repository: Awaited<ReturnType<typeof getRepoInfo>>;
  workloads: Record<string, ConfiguredWorkload>;
  conflicts: string[];
}> {
  const repository = await getRepoInfo(cwd);
  const repositoryLayer = readConfigLayer(repositoryConfigPath(repository.worktreeRoot));
  const machineLayer = readConfigLayer(machineRepositoryConfigPath(repository.repoId));
  const merged = mergeConfigLayers(repositoryLayer.config, machineLayer.config);
  return { repository, workloads: merged.workloads, conflicts: merged.conflicts };
}

function configuredBindings(workload: ConfiguredWorkload): DiscoveredBinding[] {
  const bindings = new Map<string, DiscoveredBinding>();
  for (const [alias, endpoint] of Object.entries(workload.endpoints)) {
    const [target, protocol] = endpoint.binding.split("/") as [string, "tcp" | "udp"];
    const key = `${target}/${protocol}`;
    const binding = bindings.get(key) ?? { target, protocol, configuredEndpoints: [] };
    binding.configuredEndpoints.push(alias);
    bindings.set(key, binding);
  }
  return [...bindings.values()];
}

function packageScriptCandidates(worktreeRoot: string): string[] {
  const path = join(worktreeRoot, "package.json");
  if (!existsSync(path)) return [];
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> };
    return Object.keys(pkg.scripts ?? {}).filter((name) => /^(dev|start|serve)(:|$)/.test(name));
  } catch {
    return [];
  }
}

/** Read-only, source-attributed repository discovery for humans and agents. */
export async function discoverRepository(cwd: string): Promise<DiscoveryReport> {
  const repo = await getRepoInfo(cwd);
  const repositoryLayer = readConfigLayer(repositoryConfigPath(repo.worktreeRoot));
  const machineLayer = readConfigLayer(machineRepositoryConfigPath(repo.repoId));
  const merged = mergeConfigLayers(repositoryLayer.config, machineLayer.config);
  const compose = tryLoadConfig(repo.worktreeRoot);
  const composeServices = compose === null ? [] : await resolveComposeServices(compose.composeFile, repo.worktreeRoot);
  const automatic = new Map<string, DiscoveredWorkload>();
  for (const service of composeServices) {
    automatic.set(service.name, {
      name: service.name,
      source: "compose",
      runnable: true,
      configured: false,
      decisionSource: "discovery",
      definitionPath: compose?.composeFile,
      bindings: service.ports.map((port) => ({ ...port, configuredEndpoints: [] })),
      endpoints: [],
      notes: [],
    });
  }
  for (const worker of discoverWorkers(repo.worktreeRoot)) {
    const workerRelativePath = relative(repo.worktreeRoot, worker.configPath);
    if (/^(?:test|tests)\/fixtures\//.test(workerRelativePath) || workerRelativePath.includes("/fixtures/")) {
      continue;
    }
    const name = worker.name ?? basename(worker.configPath).replace(/^wrangler\.|\.(?:jsonc|json|toml)$/g, "");
    if (!automatic.has(name)) {
      automatic.set(name, {
        name,
        source: "wrangler",
        runnable: true,
        configured: false,
        decisionSource: "discovery",
        definitionPath: worker.configPath,
        bindings: [{ target: "main", protocol: "tcp", configuredEndpoints: [] }],
        endpoints: [],
        notes: worker.hasRemote ? ["declares remote bindings; up requires --allow-remote"] : [],
      });
    }
  }

  const workloads = new Map(automatic);
  for (const [name, config] of Object.entries(merged.workloads)) {
    const discovered = workloads.get(name);
    const bindings = configuredBindings(config);
    if (discovered !== undefined && discovered.source !== config.source) {
      merged.conflicts.push(
        `configured workload ${name} uses ${config.source}, but automatic discovery found ${discovered.source}`,
      );
    }
    workloads.set(name, {
      name,
      source: config.source,
      runnable:
        config.source === "proc" ? (config.command?.length ?? 0) > 0 :
        config.source === "dockerfile" ? existsSync(join(repo.worktreeRoot, config.dockerfile ?? "Dockerfile")) :
        config.source === "wrangler" ? existsSync(join(repo.worktreeRoot, config.wranglerConfig ?? "wrangler.toml")) :
        composeServices.some((service) => service.name === config.composeService),
      configured: true,
      decisionSource: merged.sources.get(name) ?? "repository",
      definitionPath:
        config.source === "dockerfile" ? join(repo.worktreeRoot, config.dockerfile ?? "Dockerfile") :
        config.source === "wrangler" ? join(repo.worktreeRoot, config.wranglerConfig ?? "wrangler.toml") :
        config.source === "compose" ? compose?.composeFile : undefined,
      bindings: bindings.length > 0 ? bindings : discovered?.bindings ?? [],
      endpoints: Object.entries(config.endpoints).map(([alias, endpoint]) => ({
        alias,
        ...endpoint,
        source: merged.endpointSources.get(`${name}\0${alias}`) ?? merged.sources.get(name) ?? "repository",
      })),
      notes: discovered?.notes ?? [],
    });
  }

  const candidates: DiscoveredWorkload[] = [];
  for (const file of ["Dockerfile", "dockerfile"]) {
    const path = join(repo.worktreeRoot, file);
    if (existsSync(path) && ![...workloads.values()].some((workload) => workload.source === "dockerfile")) {
      candidates.push({
        name: "web",
        source: "dockerfile",
        runnable: false,
        configured: false,
        decisionSource: "discovery",
        definitionPath: path,
        bindings: [],
        endpoints: [],
        notes: ["Dockerfile is a candidate; choose a workload name and endpoint semantics"],
      });
    }
  }
  for (const script of packageScriptCandidates(repo.worktreeRoot)) {
    candidates.push({
      name: script,
      source: "proc",
      runnable: false,
      configured: false,
      decisionSource: "discovery",
      bindings: [],
      endpoints: [],
      notes: ["package scripts are suggestions and are never executed automatically"],
    });
  }

  const missingDecisions = candidates.map((candidate) =>
    `${candidate.source} candidate ${candidate.name} requires explicit setup`
  );
  const suggestions = [
    ...candidates.map((candidate) => candidate.source === "dockerfile"
      ? `hestia init dockerfile ${candidate.name} ${relative(repo.worktreeRoot, candidate.definitionPath!)} --scope repository`
      : `hestia init proc ${candidate.name} --scope repository -- bun run ${candidate.name}`),
    ...[...workloads.values()].flatMap((workload) => workload.bindings.length > 1 && workload.endpoints.length === 0
      ? [`hestia init endpoint <alias> ${workload.name} <target/tcp|udp> <http|tcp|udp> --scope repository`]
      : []),
  ];
  const state = readState(repo.worktreeRoot);
  return {
    version: 1,
    repository: {
      repo: repo.repo,
      repoId: repo.repoId,
      branch: repo.branch,
      worktree: repo.worktreeRoot,
    },
    layers: [
      { source: "discovery", present: automatic.size > 0 || candidates.length > 0 },
      { source: "repository", path: repositoryLayer.path, present: repositoryLayer.exists },
      { source: "machine", path: machineLayer.path, present: machineLayer.exists },
      { source: "worktree", path: join(repo.worktreeRoot, ".hestia"), present: state !== null },
    ],
    runnableWorkloads: [...workloads.values()].filter((workload) => workload.runnable)
      .sort((left, right) => left.name.localeCompare(right.name)),
    candidateWorkloads: [
      ...[...workloads.values()].filter((workload) => !workload.runnable),
      ...candidates,
    ].sort((left, right) => left.name.localeCompare(right.name)),
    missingDecisions,
    conflicts: merged.conflicts,
    suggestions,
    existingStack: state === null
      ? null
      : { project: state.project, state: state.state, schemaVersion: state.schemaVersion },
  };
}

export function assertDiscoveryRunnable(report: DiscoveryReport): void {
  if (report.conflicts.length > 0) {
    throw new HestiaError("config-conflict", report.conflicts.join("; "), { conflicts: report.conflicts });
  }
  if (report.runnableWorkloads.length === 0 && report.missingDecisions.length > 0) {
    throw new HestiaError(
      "setup-required",
      `repository setup is incomplete; run hestia discover --json for suggestions`,
      { missingDecisions: report.missingDecisions, suggestions: report.suggestions },
    );
  }
}
