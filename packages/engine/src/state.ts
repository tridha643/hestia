import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StackRecord } from "@hestia/core";

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

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Persist state in the worktree and mirror it to ~/.hestia so `down` still
 * works if the worktree is later deleted. */
export function writeState(worktreeRoot: string, record: StackRecord): void {
  ensureDir(hestiaDir(worktreeRoot));
  const json = JSON.stringify(record, null, 2);
  writeFileSync(statePath(worktreeRoot), json);
  const mdir = mirrorDir(record.project);
  ensureDir(mdir);
  writeFileSync(join(mdir, STATE_FILE), json);
}

export function readState(worktreeRoot: string): StackRecord | null {
  const p = statePath(worktreeRoot);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as StackRecord;
}

export function clearState(worktreeRoot: string, project: string): void {
  const p = statePath(worktreeRoot);
  if (existsSync(p)) rmSync(p);
  const mdir = mirrorDir(project);
  if (existsSync(mdir)) rmSync(mdir, { recursive: true, force: true });
}
