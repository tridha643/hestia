import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HestiaError } from "@hestia/core";

export interface StackConfig {
  /** Absolute path to the repo's compose file. */
  composeFile: string;
  /** All services declared in the compose file. */
  services: string[];
}

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

function firstExisting(root: string, names: string[]): string | undefined {
  for (const n of names) {
    const p = join(root, n);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function serviceNames(composeFile: string): string[] {
  const doc = parseYaml(readFileSync(composeFile, "utf8")) as {
    services?: Record<string, unknown>;
  } | null;
  return Object.keys(doc?.services ?? {});
}

/**
 * Single interface: zero-config. Detect the repo's compose file and read its
 * services. hestia never requires a config file of its own — the caller reads
 * the ephemeral ports back from `up` and wires whatever URLs it needs.
 */
export function loadConfig(worktreeRoot: string): StackConfig {
  const cfg = tryLoadConfig(worktreeRoot);
  if (cfg === null) {
    throw new HestiaError(
      "config-missing",
      `no compose file found in ${worktreeRoot}`,
    );
  }
  return cfg;
}

/** Procs-only stacks are legal — a missing compose file is not an error here. */
export function tryLoadConfig(worktreeRoot: string): StackConfig | null {
  const composeFile = firstExisting(worktreeRoot, COMPOSE_FILES);
  if (composeFile === undefined) return null;
  return { composeFile, services: serviceNames(composeFile) };
}
