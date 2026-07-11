#!/usr/bin/env bun
import { chmodSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SessionBroker, createSessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-bun";
import { withLock } from "../proc/lock.ts";
import {
  isLive,
  readPidfile,
  removePidfile,
  startTimeOf,
  writePidfile,
} from "../proc/pidfile.ts";
import { ensureDir } from "../state.ts";
import { writeAtomicJsonFile } from "../atomic-json-file.ts";
import { ComposeEngine } from "../index.ts";
import { Admission, HESTIAD_PROTOCOL_VERSION, createRoutes } from "./routes.ts";
import { SlotLedger, daemonDir } from "./slots.ts";
import { startDuties } from "./duties.ts";
import { FleetMonitor } from "./fleet-monitor.ts";

/**
 * hestiad — the machine-global admission + supervision daemon. One instance
 * per HESTIA_HOME, whether spawned by the CLI's ensure path or by launchd
 * RunAtLoad: the single-instance guard lives HERE (not in the spawner) under
 * the daemon dir's lock, because launchd bypasses the CLI entirely. The loser
 * of a start race exits 0 — with KeepAlive={SuccessfulExit:false} launchd
 * does not respawn it.
 */

const PIDFILE_NAME = "hestiad";

async function main(): Promise<void> {
  const root = daemonDir();
  ensureDir(root);
  chmodSync(root, 0o700);

  const won = await withLock(root, async () => {
    const existing = readPidfile(root, PIDFILE_NAME);
    if (existing !== null && isLive(existing)) return false;

    const broker = new SessionBroker({
      // No session semantics this phase — hestiad rejects registrations until
      // the TUI/log-streaming effort defines them.
      parseRegistration: () => null,
      parseSnapshot: () => null,
    });
    const daemon = createSessionBrokerDaemon({
      broker,
      // 0 = disabled (pinned in daemon-vendor.test.ts). hestiad has standing
      // duties; its lifetime belongs to `hestia daemon stop` / launchd.
      idleTimeoutMs: 0,
      capabilities: { version: HESTIAD_PROTOCOL_VERSION },
    });
    const startedAt = new Date().toISOString();
    const admission = new Admission(new SlotLedger());
    const fleet = new FleetMonitor(admission);
    const engine = new ComposeEngine();
    const token = randomBytes(32).toString("hex");
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port: 0,
      handleRequest: createRoutes(admission, startedAt, {
        token,
        fleet,
        logsProject: (project, options) => engine.logsProject(project, options),
      }),
    });

    // Written while still holding the lock: identity first, then discovery.
    const startTime = startTimeOf(process.pid) ?? "";
    writePidfile(root, {
      name: PIDFILE_NAME,
      pid: process.pid,
      pgid: process.pid,
      startTime,
      argv: process.argv,
      logPath: join(root, "daemon.log"),
      signal: "term",
      backend: "proc",
    });
    writeAtomicJsonFile(
      join(root, "daemon.json"),
      {
        pid: process.pid,
        port: server.port,
        protocolVersion: HESTIAD_PROTOCOL_VERSION,
        startedAt,
        token,
      },
      { mode: 0o600 },
    );

    const stopDuties = startDuties(admission);
    const shutdown = () => {
      stopDuties();
      fleet.stop();
      removePidfile(root, PIDFILE_NAME);
      rmSync(join(root, "daemon.json"), { force: true });
      server.stop(true);
      // Exit 0 on intentional stop so launchd's SuccessfulExit:false policy
      // treats it as final rather than a crash to respawn.
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    console.error(
      `hestiad listening on 127.0.0.1:${server.port} (pid ${process.pid}, ` +
        `protocol v${HESTIAD_PROTOCOL_VERSION}, home ${root})`,
    );
    return true;
  });

  if (!won) {
    // Another live instance owns this HESTIA_HOME — idempotent success.
    process.exit(0);
  }
}

main();
