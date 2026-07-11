import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { slug, type RepoId, type StackRecord } from "@hestia/core";
import { hestiaHome } from "../state.ts";

export const DEFAULT_LOCAL_HOSTNAME_TEMPLATE = "{service}.{branch}.{repo}.localhost";

export interface RouterRepositoryConfig {
  name?: string;
  services: string[];
}

export interface HestiaRouterConfig {
  hostnameTemplate: string;
  repositories: Partial<Record<RepoId, RouterRepositoryConfig>>;
}

export interface HestiaMachineConfig {
  version: 1;
  maxStacks?: number;
  router: HestiaRouterConfig;
}

export interface HestiaConfigReadResult {
  config: HestiaMachineConfig;
  warnings: string[];
  valid: boolean;
  path: string;
}

/** Return the canonical machine-local TOML configuration path. */
export function hestiaConfigTomlPath(): string {
  return join(hestiaHome(), "config.toml");
}

function emptyMachineConfig(): HestiaMachineConfig {
  return {
    version: 1,
    router: {
      hostnameTemplate: DEFAULT_LOCAL_HOSTNAME_TEMPLATE,
      repositories: {},
    },
  };
}

function assertKnownKeys(table: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(table).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) throw new Error(`${path} has unknown key ${JSON.stringify(unknown)}`);
}

function validateHostnameTemplate(value: unknown): string {
  const template = value === undefined ? DEFAULT_LOCAL_HOSTNAME_TEMPLATE : value;
  if (typeof template !== "string") throw new Error("router.hostname_template must be a string");
  for (const token of ["{service}", "{branch}", "{repo}"]) {
    if (!template.includes(token)) throw new Error(`router.hostname_template must contain ${token}`);
  }
  if (!template.endsWith(".localhost")) {
    throw new Error("router.hostname_template must end in .localhost");
  }
  const unknown = template.match(/\{[^}]+\}/g)?.filter(
    (token) => !["{service}", "{branch}", "{repo}"].includes(token),
  );
  if (unknown?.length) throw new Error(`router.hostname_template has unknown token ${unknown[0]}`);
  const worstCase = template.replaceAll(/\{(?:service|branch|repo)\}/g, "x".repeat(63));
  if (worstCase.length > 253) {
    throw new Error("router.hostname_template can exceed the 253-character DNS hostname limit");
  }
  return template;
}

function localHostnameLabel(value: string): string {
  const normalized = slug(value);
  const normalizationIsLossy = value !== normalized;
  if (!normalizationIsLossy && normalized.length <= 63) return normalized;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 6);
  return `${normalized.slice(0, Math.min(56, normalized.length))}-${hash}`;
}

/** Stable lookup key for one stack-local service route. */
export function localRouteKey(record: Pick<StackRecord, "project">, service: string): string {
  return `${record.project}\0${service}`;
}

function identityDisambiguatedHostname(hostname: string, record: StackRecord): string {
  const labels = hostname.split(".");
  const first = labels[0] ?? "service";
  const identity = `${record.repoId ?? record.repo}\0${record.worktree}`;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 6);
  labels[0] = `${first.slice(0, Math.min(56, first.length))}-${hash}`;
  return labels.join(".");
}

function parseRepositoryConfigs(value: unknown): HestiaRouterConfig["repositories"] {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("router.repositories must be a table");
  }
  const repositories: HestiaRouterConfig["repositories"] = {};
  for (const [repoId, raw] of Object.entries(value)) {
    if (!/^repo-[a-f0-9]{16}$/.test(repoId)) {
      throw new Error(`router.repositories key ${JSON.stringify(repoId)} is not a RepoId`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`router.repositories.${repoId} must be a table`);
    }
    const table = raw as Record<string, unknown>;
    assertKnownKeys(table, ["name", "services"], `router.repositories.${repoId}`);
    if (!Array.isArray(table.services) || !table.services.every(
      (service) => typeof service === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service),
    )) {
      throw new Error(`router.repositories.${repoId}.services must be an array of service names`);
    }
    if (table.name !== undefined && typeof table.name !== "string") {
      throw new Error(`router.repositories.${repoId}.name must be a string`);
    }
    repositories[repoId as RepoId] = {
      name: table.name as string | undefined,
      services: [...new Set(table.services as string[])],
    };
  }
  return repositories;
}

/** Strictly parse machine TOML; invalid router defaults are disabled with warnings. */
export function readHestiaMachineConfig(path = hestiaConfigTomlPath()): HestiaConfigReadResult {
  const fallback = emptyMachineConfig();
  if (!existsSync(path)) return { config: fallback, warnings: [], valid: true, path };
  try {
    const raw = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assertKnownKeys(raw, ["version", "max_stacks", "router"], "config");
    if (raw.version !== 1) throw new Error("version must equal 1");
    const maxStacks = raw.max_stacks;
    if (maxStacks !== undefined && (!Number.isInteger(maxStacks) || (maxStacks as number) <= 0)) {
      throw new Error("max_stacks must be a positive integer");
    }
    const router = raw.router;
    const config = { ...fallback, maxStacks: maxStacks as number | undefined };
    try {
      if (router !== undefined && (typeof router !== "object" || router === null || Array.isArray(router))) {
        throw new Error("router must be a table");
      }
      const routerTable = (router ?? {}) as Record<string, unknown>;
      assertKnownKeys(routerTable, ["hostname_template", "repositories"], "router");
      config.router = {
        hostnameTemplate: validateHostnameTemplate(routerTable.hostname_template),
        repositories: parseRepositoryConfigs(routerTable.repositories),
      };
    } catch (error) {
      return {
        config,
        warnings: [`invalid router section in ${path}: ${(error as Error).message} — configured routes disabled`],
        valid: false,
        path,
      };
    }
    return {
      config,
      warnings: [],
      valid: true,
      path,
    };
  } catch (error) {
    return {
      config: fallback,
      warnings: [`invalid ${path}: ${(error as Error).message} — configured routes disabled`],
      valid: false,
      path,
    };
  }
}

/** Return repository-default services selected in machine-local config. */
export function configuredLocalRouteServices(
  repoId: RepoId | undefined,
  config = readHestiaMachineConfig().config,
): string[] {
  if (repoId === undefined) return [];
  return config.router.repositories[repoId]?.services ?? [];
}

/** Union per-worktree CLI intent with repository-default local route services. */
export function effectiveLocalRouteServices(
  record: StackRecord,
  config = readHestiaMachineConfig().config,
): string[] {
  return [...new Set([
    ...(record.localRoutes ?? []).map((route) => route.service),
    ...configuredLocalRouteServices(record.repoId, config),
  ])].sort();
}

/** Render one collision-safe local hostname from a validated template. */
export function localRouteHostname(
  record: Pick<StackRecord, "repoId" | "repo" | "branch" | "worktree">,
  service: string,
  config = readHestiaMachineConfig().config,
): string {
  const repositoryName = record.repoId === undefined
    ? record.repo
    : config.router.repositories[record.repoId]?.name ?? record.repo;
  const expanded = config.router.hostnameTemplate
    .replaceAll("{service}", service)
    .replaceAll("{branch}", record.branch)
    .replaceAll("{repo}", repositoryName);
  const hostname = expanded.split(".").map((label) => localHostnameLabel(label)).join(".");
  if (hostname.length > 253) throw new Error("expanded local route hostname exceeds 253 characters");
  return hostname;
}

/** Resolve hostnames with stable identity hashes so later stacks can never rename them. */
export function resolveLocalRouteHostnames(
  records: StackRecord[],
  config = readHestiaMachineConfig().config,
): Map<string, string> {
  const candidates: Array<{ key: string; hostname: string; record: StackRecord }> = [];
  for (const record of records) {
    const services = new Set([
      ...effectiveLocalRouteServices(record, config),
      ...record.endpoints.map((endpoint) => endpoint.name),
    ]);
    for (const service of services) {
      candidates.push({
        key: localRouteKey(record, service),
        hostname: localRouteHostname(record, service, config),
        record,
      });
    }
  }
  return new Map(candidates.map((candidate) => [
    candidate.key,
    identityDisambiguatedHostname(candidate.hostname, candidate.record),
  ]));
}
