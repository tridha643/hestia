import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StackRecord } from "@hestia/core";
import { procsDir, type Pidfile } from "./proc/pidfile.ts";

const STATE_FILE = "stack.json";

export function hestiaDir(worktreeRoot: string): string {
  return join(worktreeRoot, ".hestia");
}

function statePath(worktreeRoot: string): string {
  return join(hestiaDir(worktreeRoot), STATE_FILE);
}

export function mirrorDir(project: string): string {
  return join(homedir(), ".hestia", "stacks", project);
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
  const json = JSON.stringify(record, null, 2);
  writeFileSync(statePath(worktreeRoot), json);
  const mdir = mirrorDir(record.project);
  ensureDir(mdir);
  writeFileSync(join(mdir, STATE_FILE), json);
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
  writeFileSync(join(dst, `${pf.name}.json`), JSON.stringify(pf, null, 2));
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
