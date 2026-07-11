import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HestiaError, type RepoId } from "@hestia/core";
import { hestiaHome } from "./state.ts";

export type WorkloadSource = "compose" | "dockerfile" | "proc" | "wrangler";
export type EndpointKind = "http" | "tcp" | "udp";

export interface ConfiguredEndpoint {
  binding: string;
  kind: EndpointKind;
  local?: boolean;
}

export interface ConfiguredWorkload {
  source: WorkloadSource;
  composeService?: string;
  dockerfile?: string;
  command?: string[];
  wranglerConfig?: string;
  port?: "auto" | "none";
  endpoints: Record<string, ConfiguredEndpoint>;
}

export interface RepositoryWorkloadConfig {
  version: 1;
  workloads: Record<string, ConfiguredWorkload>;
}

export interface ConfigLayerReadResult {
  path: string;
  exists: boolean;
  config: RepositoryWorkloadConfig;
}

const WORKLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BINDING = /^(?:main|[1-9][0-9]{0,4})\/(?:tcp|udp)$/;

function emptyConfig(): RepositoryWorkloadConfig {
  return { version: 1, workloads: {} };
}

function table(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a table`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${path} has unknown key ${JSON.stringify(unknown)}`);
}

function parseEndpoints(value: unknown, path: string): Record<string, ConfiguredEndpoint> {
  if (value === undefined) return {};
  const endpoints: Record<string, ConfiguredEndpoint> = {};
  for (const [name, rawEndpoint] of Object.entries(table(value, path))) {
    if (!WORKLOAD_NAME.test(name)) throw new Error(`${path} has invalid endpoint name ${JSON.stringify(name)}`);
    const endpoint = table(rawEndpoint, `${path}.${name}`);
    knownKeys(endpoint, ["binding", "kind", "local"], `${path}.${name}`);
    if (typeof endpoint.binding !== "string" || !BINDING.test(endpoint.binding)) {
      throw new Error(`${path}.${name}.binding must be main/tcp or <port>/tcp|udp`);
    }
    if (!(["http", "tcp", "udp"] as unknown[]).includes(endpoint.kind)) {
      throw new Error(`${path}.${name}.kind must be http, tcp, or udp`);
    }
    if (endpoint.kind === "http" && endpoint.binding.endsWith("/udp")) {
      throw new Error(`${path}.${name}: HTTP endpoints require a TCP binding`);
    }
    if (endpoint.local !== undefined && typeof endpoint.local !== "boolean") {
      throw new Error(`${path}.${name}.local must be a boolean`);
    }
    if (endpoint.local === true && endpoint.kind !== "http") {
      throw new Error(`${path}.${name}: local routes require an HTTP endpoint`);
    }
    endpoints[name] = {
      binding: endpoint.binding,
      kind: endpoint.kind as EndpointKind,
      local: endpoint.local as boolean | undefined,
    };
  }
  return endpoints;
}

/** Strictly validate one repository or machine-overlay workload document. */
export function parseRepositoryWorkloadConfig(source: string, path: string): RepositoryWorkloadConfig {
  let raw: Record<string, unknown>;
  try {
    raw = table(Bun.TOML.parse(source), "config");
    knownKeys(raw, ["version", "workloads"], "config");
    if (raw.version !== 1) throw new Error("version must equal 1");
    const workloads: Record<string, ConfiguredWorkload> = {};
    for (const [name, rawWorkload] of Object.entries(table(raw.workloads ?? {}, "workloads"))) {
      if (!WORKLOAD_NAME.test(name)) throw new Error(`invalid workload name ${JSON.stringify(name)}`);
      const workload = table(rawWorkload, `workloads.${name}`);
      knownKeys(
        workload,
        ["source", "compose_service", "dockerfile", "command", "wrangler_config", "port", "endpoints"],
        `workloads.${name}`,
      );
      if (!(["compose", "dockerfile", "proc", "wrangler"] as unknown[]).includes(workload.source)) {
        throw new Error(`workloads.${name}.source must be compose, dockerfile, proc, or wrangler`);
      }
      const sourceKind = workload.source as WorkloadSource;
      if (workload.command !== undefined &&
        (!Array.isArray(workload.command) || !workload.command.every((part) => typeof part === "string"))) {
        throw new Error(`workloads.${name}.command must be an array of strings`);
      }
      if (workload.port !== undefined && workload.port !== "auto" && workload.port !== "none") {
        throw new Error(`workloads.${name}.port must be auto or none`);
      }
      for (const key of ["compose_service", "dockerfile", "wrangler_config"] as const) {
        if (workload[key] !== undefined && typeof workload[key] !== "string") {
          throw new Error(`workloads.${name}.${key} must be a string`);
        }
      }
      if (sourceKind === "compose" && typeof workload.compose_service !== "string") {
        throw new Error(`workloads.${name}.compose_service is required for compose`);
      }
      if (sourceKind === "proc" && !Array.isArray(workload.command)) {
        throw new Error(`workloads.${name}.command is required for proc`);
      }
      workloads[name] = {
        source: sourceKind,
        composeService: workload.compose_service as string | undefined,
        dockerfile: workload.dockerfile as string | undefined,
        command: workload.command as string[] | undefined,
        wranglerConfig: workload.wrangler_config as string | undefined,
        port: workload.port as "auto" | "none" | undefined,
        endpoints: parseEndpoints(workload.endpoints, `workloads.${name}.endpoints`),
      };
    }
    return { version: 1, workloads };
  } catch (error) {
    if (error instanceof HestiaError) throw error;
    throw new HestiaError("config-invalid", `invalid ${path}: ${(error as Error).message}`, { path });
  }
}

export function repositoryConfigPath(worktreeRoot: string): string {
  return join(worktreeRoot, "hestia.toml");
}

export function machineRepositoryConfigPath(repoId: RepoId): string {
  return join(hestiaHome(), "repositories", `${repoId}.toml`);
}

export function readConfigLayer(path: string): ConfigLayerReadResult {
  if (!existsSync(path)) return { path, exists: false, config: emptyConfig() };
  return {
    path,
    exists: true,
    config: parseRepositoryWorkloadConfig(readFileSync(path, "utf8"), path),
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Deterministic TOML rendering used by explicit `hestia init --write`. */
export function renderRepositoryWorkloadConfig(config: RepositoryWorkloadConfig): string {
  const lines = ["version = 1", ""];
  for (const name of Object.keys(config.workloads).sort()) {
    const workload = config.workloads[name]!;
    const prefix = `workloads.${quote(name)}`;
    lines.push(`[${prefix}]`, `source = ${quote(workload.source)}`);
    if (workload.composeService !== undefined) lines.push(`compose_service = ${quote(workload.composeService)}`);
    if (workload.dockerfile !== undefined) lines.push(`dockerfile = ${quote(workload.dockerfile)}`);
    if (workload.command !== undefined) lines.push(`command = [${workload.command.map(quote).join(", ")}]`);
    if (workload.wranglerConfig !== undefined) lines.push(`wrangler_config = ${quote(workload.wranglerConfig)}`);
    if (workload.port !== undefined) lines.push(`port = ${quote(workload.port)}`);
    lines.push("");
    for (const alias of Object.keys(workload.endpoints).sort()) {
      const endpoint = workload.endpoints[alias]!;
      lines.push(
        `[${prefix}.endpoints.${quote(alias)}]`,
        `binding = ${quote(endpoint.binding)}`,
        `kind = ${quote(endpoint.kind)}`,
      );
      if (endpoint.local !== undefined) lines.push(`local = ${endpoint.local}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
