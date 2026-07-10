import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** On-disk record for one supervised proc: `<worktree>/.hestia/procs/<name>.json`. */
export interface Pidfile {
  name: string;
  pid: number;
  /** == pid: detached spawn makes the child its own process-group leader. */
  pgid: number;
  /** Verbatim `ps -o lstart=` output — compared string-equal as the PID-reuse guard. */
  startTime: string;
  /** Original (pre-{port}-substitution) argv, for idempotent-replace comparison. */
  argv: string[];
  env?: Record<string, string>;
  port?: number;
  inspectorPort?: number;
  logPath: string;
  signal: "term" | "int";
  backend: "proc" | "wrangler";
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
  mkdirSync(procsDir(worktreeRoot), { recursive: true });
  writeFileSync(pidfilePath(worktreeRoot, pf.name), JSON.stringify(pf, null, 2));
}

export function readPidfile(
  worktreeRoot: string,
  name: string,
): Pidfile | null {
  const p = pidfilePath(worktreeRoot, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Pidfile;
}

export function removePidfile(worktreeRoot: string, name: string): void {
  rmSync(pidfilePath(worktreeRoot, name), { force: true });
}

export function listPidfiles(dir: string): Pidfile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Pidfile);
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
