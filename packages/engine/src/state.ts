import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HestiaError, STATE_SCHEMA_VERSION, type StackRecord } from "@hestia/core";
import { procsDir, type Pidfile } from "./proc/pidfile.ts";
import { writeAtomicJsonFile } from "./atomic-json-file.ts";

const STATE_FILE = "stack.json";

/**
 * Machine-global hestia root (mirrors, tunnel singleton, daemon). Evaluated at
 * call time so tests can point a spawned CLI/daemon at a temp dir via
 * HESTIA_HOME — cap accounting is machine-global, so the daemon e2e must not
 * see (or pollute) the real ~/.hestia.
 */
export function hestiaHome(): string {
  return process.env.HESTIA_HOME ?? join(homedir(), ".hestia");
}

export function hestiaDir(worktreeRoot: string): string {
  return join(worktreeRoot, ".hestia");
}

function statePath(worktreeRoot: string): string {
  return join(hestiaDir(worktreeRoot), STATE_FILE);
}

export function mirrorDir(project: string): string {
  return join(hestiaHome(), "stacks", project);
}

export function mirrorProcsDir(project: string): string {
  return join(mirrorDir(project), "procs");
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function corruptState(path: string, reason: string): HestiaError {
  return new HestiaError(
    "state-corrupt",
    `invalid Hestia state at ${path}: ${reason}; recover with hestia down --project <project>`,
    { path, recovery: "hestia down --project <project>" },
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

/** Parse persisted stack state without trusting a JSON cast. */
export function parseStackRecord(source: string, path: string): StackRecord {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw corruptState(path, `malformed JSON (${(error as Error).message})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corruptState(path, "expected an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== undefined && record.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw corruptState(path, `unsupported schemaVersion ${String(record.schemaVersion)}`);
  }
  for (const key of ["project", "repo", "branch", "worktree", "state", "createdAt"] as const) {
    if (typeof record[key] !== "string" || record[key] === "") {
      throw corruptState(path, `expected non-empty ${key}`);
    }
  }
  if (!Array.isArray(record.services) || !Array.isArray(record.endpoints)) {
    throw corruptState(path, "services and endpoints must be arrays");
  }
  if (!isStringRecord(record.env)) throw corruptState(path, "env must contain only string values");
  return record as unknown as StackRecord;
}

/** Reject mutation of legacy state while preserving inspection and teardown. */
export function assertMutableStackRecord(record: StackRecord, path: string): void {
  if (record.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new HestiaError(
      "migration-required",
      `legacy Hestia state at ${path} is inspection/down-only; run hestia down before starting it again`,
      { path, recovery: `hestia down --project ${record.project}` },
    );
  }
}

/**
 * Persist state in the worktree and mirror FULL COPIES (stack.json + every
 * pidfile) to ~/.hestia, so `down --project` can kill procs and tear down
 * containers after the worktree itself has been deleted.
 */
export function writeState(worktreeRoot: string, record: StackRecord): void {
  assertMutableStackRecord(record, statePath(worktreeRoot));
  ensureDir(hestiaDir(worktreeRoot));
  writeAtomicJsonFile(statePath(worktreeRoot), record);
  const mdir = mirrorDir(record.project);
  ensureDir(mdir);
  writeAtomicJsonFile(join(mdir, STATE_FILE), record);
  syncMirrorPidfiles(worktreeRoot, record.project);
}

/** Refresh the mirror's pidfile copies from the worktree (full replace). */
export function syncMirrorPidfiles(
  worktreeRoot: string,
  project: string,
): void {
  const src = procsDir(worktreeRoot);
  const dst = mirrorProcsDir(project);
  rmSync(dst, { recursive: true, force: true });
  if (!existsSync(src)) return;
  ensureDir(dst);
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(dst, f));
  }
}

/** Copy one pidfile into the mirror immediately (pre-ready crash safety). */
export function mirrorPidfile(project: string, pf: Pidfile): void {
  const dst = mirrorProcsDir(project);
  ensureDir(dst);
  writeAtomicJsonFile(join(dst, `${pf.name}.json`), pf);
}

export function readState(worktreeRoot: string): StackRecord | null {
  const p = statePath(worktreeRoot);
  if (!existsSync(p)) return null;
  const record = parseStackRecord(readFileSync(p, "utf8"), p);
  chmodSync(p, 0o600);
  return record;
}

export function readMirrorState(project: string): StackRecord | null {
  const p = join(mirrorDir(project), STATE_FILE);
  if (!existsSync(p)) return null;
  const record = parseStackRecord(readFileSync(p, "utf8"), p);
  chmodSync(p, 0o600);
  return record;
}

export function clearState(worktreeRoot: string, project: string): void {
  const p = statePath(worktreeRoot);
  if (existsSync(p)) rmSync(p);
  const mdir = mirrorDir(project);
  if (existsSync(mdir)) rmSync(mdir, { recursive: true, force: true });
}
