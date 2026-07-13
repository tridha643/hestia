import { dirname, relative } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { HestiaError } from "@hestia/core";
import { writeAtomicTextFile } from "./atomic-json-file.ts";
import { discoverRepository, type DiscoveryReport } from "./discovery.ts";
import { getRepoInfo } from "./git.ts";
import { withLock } from "./proc/lock.ts";
import { hestiaHome } from "./state.ts";
import {
  machineRepositoryConfigPath,
  parseRepositoryWorkloadConfig,
  readConfigLayer,
  renderRepositoryWorkloadConfig,
  repositoryConfigPath,
  type ConfiguredWorkload,
  type EndpointKind,
  type WorkloadSource,
} from "./repository-config.ts";

export type InitScope = "repository" | "machine";

export type InitRequest =
  | { kind: "dockerfile"; name: string; file?: string }
  | { kind: "proc"; name: string; command: string[]; port?: "auto" | "none" }
  | { kind: "wrangler"; name: string; file?: string }
  | { kind: "endpoint"; alias: string; workload: string; binding: string; endpointKind: EndpointKind };

export interface InitResult {
  path: string;
  scope: InitScope;
  written: boolean;
  proposed: string;
  discovery: DiscoveryReport;
  runnable: boolean;
}

function validateName(name: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new HestiaError("usage", `${what} must use letters, digits, dot, dash, or underscore`);
  }
}

function inferredWorkload(report: DiscoveryReport, name: string): ConfiguredWorkload | null {
  const workload = [...report.runnableWorkloads, ...report.candidateWorkloads]
    .find((candidate) => candidate.name === name);
  if (workload === undefined) return null;
  return {
    source: workload.source,
    composeService: workload.source === "compose" ? workload.name : undefined,
    dockerfile: workload.source === "dockerfile" && workload.definitionPath !== undefined
      ? relative(report.repository.worktree, workload.definitionPath)
      : undefined,
    wranglerConfig: workload.source === "wrangler" && workload.definitionPath !== undefined
      ? relative(report.repository.worktree, workload.definitionPath)
      : undefined,
    env: {},
    endpoints: {},
  };
}

function applyRequest(
  report: DiscoveryReport,
  workloads: Record<string, ConfiguredWorkload>,
  request: InitRequest,
): void {
  if (request.kind === "endpoint") {
    validateName(request.alias, "endpoint alias");
    validateName(request.workload, "workload name");
    if (!/^(?:main|[1-9][0-9]{0,4})\/(?:tcp|udp)$/.test(request.binding)) {
      throw new HestiaError("usage", "endpoint binding must be main/tcp or <port>/tcp|udp");
    }
    if (request.endpointKind === "http" && request.binding.endsWith("/udp")) {
      throw new HestiaError("usage", "HTTP endpoints require a TCP binding");
    }
    const workload = workloads[request.workload] ?? inferredWorkload(report, request.workload);
    if (workload === null) {
      throw new HestiaError("service-not-found", `cannot configure endpoint for unknown workload ${request.workload}`);
    }
    workload.endpoints[request.alias] = {
      binding: request.binding,
      kind: request.endpointKind,
      local: request.endpointKind === "http",
    };
    workloads[request.workload] = workload;
    return;
  }

  validateName(request.name, "workload name");
  const source = request.kind as WorkloadSource;
  const existing = workloads[request.name];
  if (existing !== undefined && existing.source !== source) {
    throw new HestiaError(
      "config-conflict",
      `workload ${request.name} is already configured as ${existing.source}`,
    );
  }
  workloads[request.name] = {
    source,
    dockerfile: request.kind === "dockerfile" ? request.file ?? "Dockerfile" : undefined,
    command: request.kind === "proc" ? request.command : undefined,
    port: request.kind === "proc" ? request.port ?? "auto" : undefined,
    wranglerConfig: request.kind === "wrangler" ? request.file ?? "wrangler.toml" : undefined,
    env: existing?.env ?? {},
    endpoints: existing?.endpoints ?? {},
  };
}

/** Propose or explicitly write one validated repository/machine configuration edit. */
export async function initializeRepositoryConfig(
  cwd: string,
  request: InitRequest,
  scope: InitScope,
  write: boolean,
): Promise<InitResult> {
  const repo = await getRepoInfo(cwd);
  const path = scope === "repository"
    ? repositoryConfigPath(repo.worktreeRoot)
    : machineRepositoryConfigPath(repo.repoId);
  const lockRoot = `${hestiaHome()}/config-locks/${repo.repoId}-${scope}`;
  return withLock(lockRoot, async () => {
    const before = await discoverRepository(repo.worktreeRoot);
    const layer = readConfigLayer(path);
    const config = {
      version: 1 as const,
      workloads: Object.fromEntries(
        Object.entries(layer.config.workloads).map(([name, workload]) => [
          name,
          {
            ...workload,
            command: workload.command?.slice(),
            env: { ...workload.env },
            endpoints: { ...workload.endpoints },
          },
        ]),
      ),
    };
    applyRequest(before, config.workloads, request);
    const proposed = renderRepositoryWorkloadConfig(config);
    parseRepositoryWorkloadConfig(proposed, path);
    if (write) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (scope === "machine") chmodSync(dirname(path), 0o700);
      writeAtomicTextFile(path, proposed, 0o600);
    }
    const discovery = write ? await discoverRepository(repo.worktreeRoot) : before;
    return {
      path,
      scope,
      written: write,
      proposed,
      discovery,
      runnable: discovery.conflicts.length === 0 && discovery.runnableWorkloads.length > 0,
    };
  });
}
