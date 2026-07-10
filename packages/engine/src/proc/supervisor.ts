import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { HestiaError, type ProcSpec, type ServiceRecord } from "@hestia/core";
import { allocatePort, inspectPort, processTree } from "./ports.ts";
import {
  type Pidfile,
  isLive,
  removePidfile,
  startTimeOf,
  writePidfile,
} from "./pidfile.ts";
import { stopProcTree } from "./shutdown.ts";
import { requireVarlock, wrapWithVarlock } from "./resolver.ts";

const READY_TIMEOUT_MS = 60_000;
const NO_PORT_GRACE_MS = 2_000;
const POLL_MS = 300;
const MAX_ATTEMPTS = 3;
const PROC_RESTART_SENTINEL = "--- hestia: proc restarted (port stolen) ---\n";

export function envKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

const PORT_TOKEN = "{port}";
const ESCAPED = "{{port}}";
// round-trip placeholder for escaped braces; NUL cannot appear in argv text
const SENTINEL = "\u0000";

export function substitutePort(argv: string[], port: number): string[] {
  return argv.map((a) =>
    a
      .replaceAll(ESCAPED, SENTINEL)
      .replaceAll(PORT_TOKEN, String(port))
      .replaceAll(SENTINEL, PORT_TOKEN),
  );
}

export interface ProcStartResult {
  record: ServiceRecord;
  pidfile: Pidfile;
  /** Set for ready-timeout: the proc is left running for inspection. */
  error?: HestiaError;
}

function validateName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new HestiaError(
      "name-conflict",
      `invalid proc name "${name}" (use letters, digits, - and _)`,
    );
  }
}

function spawnOnce(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  logPath: string,
  attempt: number,
): Promise<number> {
  const fd = openProcAttemptLog(logPath, attempt);
  return new Promise((resolve, reject) => {
    // node:child_process, not Bun.spawn — Bun's native API has no `detached`.
    // detached makes the child its own process-group leader (pgid == pid), so
    // one negative-pgid signal later reaches the whole tree.
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.once("error", (err) => {
      closeSync(fd);
      reject(
        new HestiaError(
          "proc-spawn-failed",
          `failed to spawn ${argv[0]}: ${err.message}`,
        ),
      );
    });
    child.once("spawn", () => {
      closeSync(fd);
      child.unref();
      resolve(child.pid!);
    });
  });
}

/** Open a fresh first-attempt proc log or append a visible port-steal retry sentinel. */
export function openProcAttemptLog(logPath: string, attempt: number): number {
  if (attempt > 1) appendFileSync(logPath, PROC_RESTART_SENTINEL);
  return openSync(logPath, attempt > 1 ? "a" : "w");
}

/**
 * Spawn + supervise one host process until it proves ready (see inspectPort
 * for the ownership oracle). Retries only on definitive evidence of a stolen
 * port; a silent timeout never retries — the proc is left running and the
 * error tells the caller where the logs are.
 */
export async function startProc(
  worktreeRoot: string,
  spec: ProcSpec,
  stackEnv: Record<string, string>,
  mirrorPidfile?: (pf: Pidfile) => void,
): Promise<ProcStartResult> {
  validateName(spec.name);
  const logsDir = join(worktreeRoot, ".hestia", "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `${spec.name}.log`);
  const cwd = spec.cwd ? join(worktreeRoot, spec.cwd) : worktreeRoot;
  const wantPort = spec.port !== "none";
  const readyTimeoutMs = spec.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const varlockBin = spec.varlock ? requireVarlock(worktreeRoot) : null;

  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = wantPort ? await allocatePort() : undefined;
    let argv = port === undefined ? spec.argv : substitutePort(spec.argv, port);
    if (varlockBin !== null) argv = wrapWithVarlock(varlockBin, argv);

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...stackEnv,
      ...(port !== undefined
        ? { PORT: String(port), [`HESTIA_${envKey(spec.name)}_PORT`]: String(port) }
        : {}),
      ...spec.env,
    };

    const pid = await spawnOnce(argv, cwd, env, logPath, attempt);
    const startTime = startTimeOf(pid) ?? "";
    const pf: Pidfile = {
      name: spec.name,
      pid,
      pgid: pid,
      startTime,
      argv: spec.argv,
      env: spec.env,
      port,
      inspectorPort: spec.inspectorPort,
      logPath,
      signal: spec.signal ?? "term",
      backend: spec.backend ?? "proc",
      configPath: spec.configPath,
    };
    // Written (and mirrored) before the ready wait so a crashed CLI still
    // leaves enough on disk for `down` to clean up.
    writePidfile(worktreeRoot, pf);
    mirrorPidfile?.(pf);

    const outcome = await waitUntilReady(pf, port, readyTimeoutMs);
    const record: ServiceRecord = {
      name: spec.name,
      backend: pf.backend,
      state: "healthy",
      publishedPort: port,
      pid,
      pgid: pid,
      startTime,
      inspectorPort: spec.inspectorPort,
      logPath,
      configPath: spec.configPath,
      originService: spec.originService,
    };

    switch (outcome.kind) {
      case "ready": {
        // Descendant snapshot for teardown: wrapper runners (varlock) start
        // their child in a new process group, so record every subtree
        // identity while it can still be walked exactly.
        pf.children = processTree(pid)
          .filter((r) => r.pid !== pid)
          .map((r) => ({
            pid: r.pid,
            pgid: r.pgid,
            startTime: startTimeOf(r.pid) ?? "",
          }))
          .filter((c) => c.startTime !== "");
        writePidfile(worktreeRoot, pf);
        mirrorPidfile?.(pf);
        return { record, pidfile: pf };
      }
      case "exited":
        removePidfile(worktreeRoot, spec.name);
        throw new HestiaError(
          "proc-exited",
          `"${spec.name}" exited before becoming ready — logs: ${logPath}`,
        );
      case "stolen":
        // Definitive: a process outside our group owns the assigned port —
        // the exact condition that makes next/vite auto-increment. Kill the
        // group (it may be serving on the wrong port) and try a fresh port.
        lastFailure = `port ${port} taken by pid ${outcome.byPid}`;
        await stopProcTree(pf, 2_000);
        removePidfile(worktreeRoot, spec.name);
        continue;
      case "timeout": {
        record.state = "unhealthy";
        const bound =
          outcome.memberPorts.length > 0
            ? `it is listening on port(s) ${outcome.memberPorts.join(", ")} instead`
            : `it never opened a listening socket (if it isn't a server, use --no-port)`;
        return {
          record,
          pidfile: pf,
          error: new HestiaError(
            "proc-ready-timeout",
            `"${spec.name}" did not listen on port ${port} within ` +
              `${Math.round(readyTimeoutMs / 1000)}s — ${bound}; left running, logs: ${logPath}`,
          ),
        };
      }
    }
  }
  throw new HestiaError(
    "port-allocation-failed",
    `could not hold a port for "${spec.name}" after ${MAX_ATTEMPTS} attempts (${lastFailure})`,
  );
}

type ReadyOutcome =
  | { kind: "ready" }
  | { kind: "exited" }
  | { kind: "stolen"; byPid: number }
  | { kind: "timeout"; memberPorts: number[] };

async function waitUntilReady(
  pf: Pidfile,
  port: number | undefined,
  timeoutMs: number,
): Promise<ReadyOutcome> {
  const deadline = Date.now() + timeoutMs;

  if (port === undefined) {
    // No port contract — alive after a short grace is the whole check.
    await new Promise((r) => setTimeout(r, NO_PORT_GRACE_MS));
    return isLive(pf) ? { kind: "ready" } : { kind: "exited" };
  }

  let memberPorts: number[] = [];
  while (Date.now() < deadline) {
    if (!isLive(pf)) return { kind: "exited" };
    const view = await inspectPort(pf.pgid, port);
    memberPorts = view.memberPorts;
    if (view.ownerIsMember) return { kind: "ready" };
    if (view.owner !== undefined) {
      return { kind: "stolen", byPid: view.owner.pid };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { kind: "timeout", memberPorts };
}
