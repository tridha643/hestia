import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { HestiaError, type DaemonHealth } from "@hestia/core";
import { withLock } from "../proc/lock.ts";
import { isLive, readPidfile } from "../proc/pidfile.ts";
import { ensureDir } from "../state.ts";
import { fetchHealth, readDaemonJson } from "./client.ts";
import { daemonMainPath, kickstart, launchdManagesThisHome } from "./launchd.ts";
import { HESTIAD_PROTOCOL_VERSION } from "./routes.ts";
import { daemonDir } from "./slots.ts";

const START_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const PIDFILE_NAME = "hestiad";

export interface DaemonHandle {
  port: number;
  health: DaemonHealth;
}

async function healthy(): Promise<DaemonHandle | null> {
  const j = readDaemonJson();
  if (j === null) return null;
  const health = await fetchHealth(j.port);
  if (health === null) return null;
  return { port: j.port, health };
}

function spawnDaemon(): void {
  const root = daemonDir();
  ensureDir(root);
  const fd = openSync(join(root, "daemon.log"), "a");
  // Same detached-spawn shape as the proc supervisor (node:child_process —
  // Bun.spawn has no `detached`); the daemon manages its own pidfile.
  const child = spawn(process.execPath, ["run", daemonMainPath()], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.once("error", () => closeSync(fd));
  child.once("spawn", () => {
    closeSync(fd);
    child.unref();
  });
}

/** SIGTERM the live daemon by pidfile identity and wait for it to die. */
export async function stopDaemonProcess(timeoutMs = 5_000): Promise<boolean> {
  const pf = readPidfile(daemonDir(), PIDFILE_NAME);
  if (pf === null || !isLive(pf)) return false;
  try {
    process.kill(pf.pid, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLive(pf)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    process.kill(pf.pid, "SIGKILL");
  } catch {}
  return true;
}

/**
 * Make sure a protocol-compatible hestiad is serving; spawn or restart one if
 * not. Launchd-managed daemons are restarted through launchd (`kickstart -k`)
 * — killing them directly would just race KeepAlive.
 */
export async function ensureDaemon(): Promise<DaemonHandle> {
  const current = await healthy();
  if (current !== null && current.health.protocolVersion === HESTIAD_PROTOCOL_VERSION) {
    return current;
  }

  if (current !== null) {
    // Live but wrong protocol — restart it our way or launchd's way.
    if (launchdManagesThisHome()) kickstart();
    else {
      await stopDaemonProcess();
      spawnDaemon();
    }
    const restarted = await pollHealthy();
    if (restarted !== null) return restarted;
    throw new HestiaError(
      "daemon-start-failed",
      `hestiad restart after a protocol mismatch did not come up within ${START_TIMEOUT_MS / 1000}s`,
    );
  }

  // Not reachable — serialize the spawn decision so parallel agents fork at
  // most a couple of candidates (main.ts's own guard picks the single winner).
  // The lock covers ONLY check+spawn: main.ts takes the same lock to start
  // serving, so polling inside it would deadlock the startup we're waiting on.
  const raced = await withLock(daemonDir(), async () => {
    const h = await healthy();
    if (h !== null) return h;
    spawnDaemon();
    return null;
  });
  if (raced !== null) return raced;
  const started = await pollHealthy();
  if (started !== null) return started;
  throw new HestiaError(
    "daemon-start-failed",
    `hestiad did not come up within ${START_TIMEOUT_MS / 1000}s — ` +
      `logs: ${join(daemonDir(), "daemon.log")}`,
  );
}

async function pollHealthy(): Promise<DaemonHandle | null> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const h = await healthy();
    if (h !== null && h.health.protocolVersion === HESTIAD_PROTOCOL_VERSION) return h;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}
