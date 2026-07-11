import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StackRecord } from "@hestia/core";
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
  mkdirSync(dir, { recursive: true });
}

/**
 * Persist state in the worktree and mirror FULL COPIES (stack.json + every
 * pidfile) to ~/.hestia, so `down --project` can kill procs and tear down
 * containers after the worktree itself has been deleted.
 */
export function writeState(worktreeRoot: string, record: StackRecord): void {
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
  return JSON.parse(readFileSync(p, "utf8")) as StackRecord;
}

export function readMirrorState(project: string): StackRecord | null {
  const p = join(mirrorDir(project), STATE_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as StackRecord;
}

export function clearState(worktreeRoot: string, project: string): void {
  const p = statePath(worktreeRoot);
  if (existsSync(p)) rmSync(p);
  const mdir = mirrorDir(project);
  if (existsSync(mdir)) rmSync(mdir, { recursive: true, force: true });
}
