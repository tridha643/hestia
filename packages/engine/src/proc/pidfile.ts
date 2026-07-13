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
  if (typeof pidfile.name !== "string" || !Number.isSafeInteger(pidfile.pid) ||
    (pidfile.pid as number) <= 0 ||
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
  const scan = scanPidfiles(dir);
  if (scan.errors[0] !== undefined) throw scan.errors[0];
  return scan.pidfiles;
}

export interface PidfileScanResult {
  pidfiles: Pidfile[];
  errors: Error[];
}

/** Parse pidfiles independently so machine-wide sweeps can contain one corrupt entry. */
export function scanPidfiles(dir: string): PidfileScanResult {
  if (!existsSync(dir)) return { pidfiles: [], errors: [] };
  const pidfiles: Pidfile[] = [];
  const errors: Error[] = [];
  for (const file of readdirSync(dir).filter((candidate) => candidate.endsWith(".json"))) {
    const path = join(dir, file);
    try {
      pidfiles.push(parsePidfile(readFileSync(path, "utf8"), path));
    } catch (error) {
      errors.push(error as Error);
    }
  }
  return { pidfiles, errors };
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
    healthPath: spec.healthPath ?? null,
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
export type ProcessIdentityLiveness = "live" | "dead" | "unknown";

type ProcessStartTimeRead =
  | { status: "ok"; value: string | null }
  | { status: "error" };

function probeProcessStartTime(
  pid: number,
  env: NodeJS.ProcessEnv,
): ProcessStartTimeRead {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env,
    }).trim();
    return { status: "ok", value: out === "" ? null : out };
  } catch {
    return { status: "error" };
  }
}

function readProcessStartTime(pid: number, env: NodeJS.ProcessEnv): string | null {
  const result = probeProcessStartTime(pid, env);
  return result.status === "ok" ? result.value : null;
}

export function startTimeOf(pid: number): string | null {
  // BSD ps localizes lstart. Daemons launched from a TUI and later inspected
  // from a shell can otherwise render the same instant differently, defeating
  // the verbatim identity guard and allowing duplicate supervisors.
  return readProcessStartTime(pid, { ...process.env, LC_ALL: "C", LANG: "C" });
}

let installedProcessLocales: string[] | undefined;
const legacyStartTimeMatches = new Map<string, boolean>();
const legacyMacosProcessLocales = [
  "en_US.UTF-8",
  "fr_FR.UTF-8",
  "de_DE.UTF-8",
  "es_ES.UTF-8",
  "it_IT.UTF-8",
  "pt_BR.UTF-8",
  "ja_JP.UTF-8",
  "ko_KR.UTF-8",
  "zh_CN.UTF-8",
];

function processLocales(): string[] {
  if (installedProcessLocales !== undefined) return installedProcessLocales;
  try {
    const output = execFileSync("locale", ["-a"], { encoding: "utf8" });
    installedProcessLocales = [...new Set([
      process.env.LC_ALL,
      process.env.LC_TIME,
      process.env.LANG,
      "C",
      ...legacyMacosProcessLocales,
      ...output.split("\n"),
    ].filter((locale): locale is string => locale !== undefined && locale !== ""))];
  } catch {
    installedProcessLocales = ["C"];
  }
  return installedProcessLocales;
}

function normalizedLocaleText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function plausibleProcessLocales(
  canonicalStartTime: string,
  recordedStartTime: string,
): string[] {
  const date = new Date(canonicalStartTime);
  const recorded = normalizedLocaleText(recordedStartTime);
  const preferred = [process.env.LC_ALL, process.env.LC_TIME, process.env.LANG, "C"];
  const legacyMacosLocales = new Set(legacyMacosProcessLocales);
  if (Number.isNaN(date.getTime())) {
    return [...new Set(preferred.filter((locale): locale is string => locale !== undefined))];
  }
  const plausible = processLocales().filter((locale) => {
    // BSD ps abbreviations do not always match Intl (for example French
    // `jul` versus `juil.`). The bounded migration list is cheap to try, and
    // safety still comes from exact reproduction of the full lstart string.
    if (preferred.includes(locale) || legacyMacosLocales.has(locale)) return true;
    try {
      const languageTag = locale.replace(/\..*$/, "").replace(/@.*$/, "").replaceAll("_", "-");
      const parts = new Intl.DateTimeFormat(languageTag, {
        weekday: "short",
        month: "short",
      }).formatToParts(date);
      const words = parts
        .filter((part) => part.type === "weekday" || part.type === "month")
        .map((part) => normalizedLocaleText(part.value))
        .filter(Boolean);
      return words.length === 2 && words.every((word) => recorded.includes(word));
    } catch {
      return false;
    }
  });
  return [...new Set(plausible)];
}

function probeLegacyLocalizedStartTime(
  pid: number,
  canonicalStartTime: string,
  recordedStartTime: string,
): ProcessIdentityLiveness {
  const cacheKey = `${pid}\0${canonicalStartTime}\0${recordedStartTime}`;
  const cached = legacyStartTimeMatches.get(cacheKey);
  if (cached !== undefined) return cached ? "live" : "dead";
  let matched = false;
  let readFailed = false;
  for (const locale of plausibleProcessLocales(canonicalStartTime, recordedStartTime)) {
    const read = probeProcessStartTime(pid, {
      ...process.env,
      LC_ALL: locale,
      LANG: locale,
    });
    if (read.status === "error") {
      readFailed = true;
      continue;
    }
    if (read.value !== null && processStartTimeMatches(read.value, recordedStartTime)) {
      matched = true;
      break;
    }
  }
  if (!matched && readFailed) return "unknown";
  if (legacyStartTimeMatches.size >= 512) {
    const oldest = legacyStartTimeMatches.keys().next().value;
    if (oldest !== undefined) legacyStartTimeMatches.delete(oldest);
  }
  legacyStartTimeMatches.set(cacheKey, matched);
  return matched ? "live" : "dead";
}

function legacyLocalizedStartTimeMatches(
  pid: number,
  canonicalStartTime: string,
  recordedStartTime: string,
): boolean {
  return probeLegacyLocalizedStartTime(pid, canonicalStartTime, recordedStartTime) === "live";
}

function processStartTimeMatches(current: string, recorded: string): boolean {
  if (current === recorded) return true;
  // Pre-normalization pidfiles can contain the same BSD lstart fields in a
  // locale-dependent order (`Sat 11 Jul` instead of `Sat Jul 11`). Preserve
  // upgrade safety without accepting a different instant: every complete
  // token must still match, and future writes always use the canonical form.
  const currentTokens = current.split(/\s+/);
  const recordedTokens = recorded.split(/\s+/);
  if (currentTokens.length !== 5 || recordedTokens.length !== 5) return false;
  return currentTokens.toSorted().join("\0") === recordedTokens.toSorted().join("\0");
}

/** Live means: pid exists AND it is still the same process we spawned. */
export function isLive(pf: Pick<Pidfile, "pid" | "startTime">): boolean {
  try {
    process.kill(pf.pid, 0);
  } catch {
    return false;
  }
  const current = startTimeOf(pf.pid);
  if (current !== null && processStartTimeMatches(current, pf.startTime)) return true;
  return current !== null &&
    legacyLocalizedStartTimeMatches(pf.pid, current, pf.startTime);
}

/** Probe PID+lstart identity without collapsing process-inspection failures into death. */
export function probeProcessIdentity(
  pf: Pick<Pidfile, "pid" | "startTime">,
): ProcessIdentityLiveness {
  try {
    process.kill(pf.pid, 0);
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH" ? "dead" : "unknown";
  }
  let current: string;
  try {
    current = execFileSync("ps", ["-o", "lstart=", "-p", String(pf.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
  } catch {
    return "unknown";
  }
  if (current === "") return "dead";
  if (processStartTimeMatches(current, pf.startTime)) return "live";
  return probeLegacyLocalizedStartTime(pf.pid, current, pf.startTime);
}
