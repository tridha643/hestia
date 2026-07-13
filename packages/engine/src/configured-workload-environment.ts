import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HestiaError, type Endpoint, type StackRecord } from "@hestia/core";
import type { ConfiguredEnvironmentValue } from "./repository-config.ts";

const ENDPOINT_TEMPLATE = /\$\{endpoint:([^}]+)\.(host|port|url)\}/g;

function endpointTemplateValue(endpoint: Endpoint, field: "host" | "port" | "url"): string {
  const value = endpoint[field];
  if (value === undefined) {
    throw new HestiaError(
      "config-invalid",
      `endpoint template requests ${endpoint.name}.${field}, but that endpoint has no ${field}`,
    );
  }
  return String(value);
}

/** Resolve late-bound endpoint fields after their producing workload is ready. */
export function resolveEndpointTemplate(template: string, record: StackRecord): string {
  const resolved = template.replace(ENDPOINT_TEMPLATE, (_match, endpointName: string, field: "host" | "port" | "url") => {
    const endpoint = record.endpoints.find((candidate) => candidate.name === endpointName);
    if (endpoint === undefined) {
      throw new HestiaError(
        "config-invalid",
        `endpoint template references ${JSON.stringify(endpointName)} before that endpoint is available`,
      );
    }
    return endpointTemplateValue(endpoint, field);
  });
  if (resolved.includes("${endpoint:")) {
    throw new HestiaError("config-invalid", `malformed endpoint template ${JSON.stringify(template)}`);
  }
  return resolved;
}

function readIgnoredEnvironmentFile(worktreeRoot: string, file: string): string {
  try {
    return readFileSync(join(worktreeRoot, file), "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    throw new HestiaError(
      "config-invalid",
      `cannot read configured environment file ${file}: ${(error as Error).message}`,
      { path: join(worktreeRoot, file) },
    );
  }
}

/** Materialize configured env without persisting literal or file-backed values. */
export function resolveConfiguredEnvironment(
  worktreeRoot: string,
  configured: Record<string, ConfiguredEnvironmentValue>,
  record: StackRecord,
): Record<string, string> {
  return Object.fromEntries(Object.entries(configured).map(([name, value]) => {
    const raw = typeof value === "string" ? value : readIgnoredEnvironmentFile(worktreeRoot, value.file);
    return [name, resolveEndpointTemplate(raw, record)];
  }));
}
