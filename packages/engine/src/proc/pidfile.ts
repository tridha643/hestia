import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { HestiaError, STATE_SCHEMA_VERSION, type ProcSpec } from "@hestia/core";
import { writeAtomicJsonFile } from "../atomic-json-file.ts";

/** On-disk record for one supervised proc: `<worktree>/.hestia/procs/<name>.json`. */
export interface Pidfile {
  schemaVersion?: typeof STATE_SCHEMA_VERSION;
  name: string;
  pid: number;
  /** == pid: detached spawn makes the child its own process-group leader. */
  pgid: number;
  /** Verbatim `ps -o lstart=` output — compared string-equal as the PID-reuse guard. */
  startTime: string;
  /** SHA-256 of spawn intent; raw argv environment values are never persisted. */
  specFingerprint: string;
  /** Legacy-only fields accepted for inspection/teardown, never written by v1. */
  argv?: string[];
  env?: Record<string, string>;
  port?: number;
  inspectorPort?: number;
  logPath: string;
  signal: "term" | "int";
  backend: "proc" | "wrangler" | "tunnel";
  configPath?: string;
  /**
   * Descendant snapshot taken at ready time. Wrapper runners (varlock) start
   * their child in a NEW process group, so teardown must know every group in
   * the tree — and if the root dies first, these identities (pid + verbatim
   * start time) let orphan groups be killed without pid-reuse risk.
   */
  children?: Array<{ pid: number; pgid: number; startTime: string }>;
}

export function procsDir(worktreeRoot: string): string {
  return join(worktreeRoot, ".hestia", "procs");
}

export function pidfilePath(worktreeRoot: string, name: string): string {
  return join(procsDir(worktreeRoot), `${name}.json`);
}

export function writePidfile(worktreeRoot: string, pf: Pidfile): void {
  pf.schemaVersion = STATE_SCHEMA_VERSION;
  delete pf.argv;
  delete pf.env;
  writeAtomicJsonFile(pidfilePath(worktreeRoot, pf.name), pf);
}

function parsePidfile(source: string, path: string): Pidfile {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new HestiaError("state-corrupt", `invalid pidfile ${path}: ${(error as Error).message}`, { path });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HestiaError("state-corrupt", `invalid pidfile ${path}: expected an object`, { path });
  }
  const pidfile = value as Record<string, unknown>;
  if (pidfile.schemaVersion !== undefined && pidfile.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new HestiaError("state-corrupt", `invalid pidfile ${path}: unsupported schemaVersion`, { path });
  }
  if (typeof pidfile.name !== "string" || !Number.isInteger(pidfile.pid) ||
    typeof pidfile.startTime !== "string" || typeof pidfile.logPath !== "string") {
    throw new HestiaError("state-corrupt", `invalid pidfile ${path}: missing process identity`, { path });
  }
  if (pidfile.schemaVersion === STATE_SCHEMA_VERSION && typeof pidfile.specFingerprint !== "string") {
    throw new HestiaError("state-corrupt", `invalid pidfile ${path}: missing specFingerprint`, { path });
  }
  return pidfile as unknown as Pidfile;
}

export function readPidfile(
  worktreeRoot: string,
  name: string,
): Pidfile | null {
  const p = pidfilePath(worktreeRoot, name);
  if (!existsSync(p)) return null;
  return parsePidfile(readFileSync(p, "utf8"), p);
}

export function removePidfile(worktreeRoot: string, name: string): void {
  rmSync(pidfilePath(worktreeRoot, name), { force: true });
}

export function listPidfiles(dir: string): Pidfile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(dir, f);
      return parsePidfile(readFileSync(path, "utf8"), path);
    });
}

/** Stable spawn-intent hash used for idempotent replacement without persisting secrets. */
export function procSpecFingerprint(spec: ProcSpec): string {
  const env = Object.entries(spec.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const canonical = JSON.stringify({
    argv: spec.argv,
    cwd: spec.cwd ?? ".",
    env,
    port: spec.port ?? "auto",
    signal: spec.signal ?? "term",
    backend: spec.backend ?? "proc",
    resolver: spec.varlock ? "varlock" : "direct",
    inspectorPort: spec.inspectorPort ?? null,
    configPath: spec.configPath ?? null,
    originService: spec.originService ?? null,
    originEndpoint: spec.originEndpoint ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Verbatim process start time, or null if the pid is gone. Captured once
 * post-spawn and re-read on every liveness check; both reads run on the same
 * host so the platform's `lstart` format never has to be parsed.
 */
export function startTimeOf(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Live means: pid exists AND it is still the same process we spawned. */
export function isLive(pf: Pick<Pidfile, "pid" | "startTime">): boolean {
  try {
    process.kill(pf.pid, 0);
  } catch {
    return false;
  }
  return startTimeOf(pf.pid) === pf.startTime;
}
