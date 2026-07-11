import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoId, StackRecord } from "@hestia/core";
import { startTimeOf } from "../src/proc/pidfile.ts";
import { writeState } from "../src/state.ts";
import { collectFleetSnapshot, FleetMonitor } from "../src/daemon/fleet-monitor.ts";
import { parseDockerFleetServices } from "../src/daemon/fleet-monitor.ts";
import { Admission, createRoutes } from "../src/daemon/routes.ts";
import { SlotLedger } from "../src/daemon/slots.ts";

const roots: string[] = [];
const repoId = "repo-1234567890abcdef" as RepoId;

function fixtureRecord(worktree: string): StackRecord {
  return {
    project: "fixture-fleet",
    repoId,
    repo: "fixture",
    branch: "fleet",
    worktree,
    state: "up",
    services: [{
      name: "web",
      backend: "proc",
      state: "healthy",
      pid: process.pid,
      startTime: startTimeOf(process.pid),
      publishedPort: 43123,
      logPath: "/secret/application.log",
    }],
    env: { API_TOKEN: "must-not-leak" },
    endpoints: [{ name: "web", host: "127.0.0.1", port: 43123 }],
    createdAt: new Date(0).toISOString(),
  };
}

function setupFleet(): { root: string; admission: Admission } {
  const root = mkdtempSync(join(tmpdir(), "hestia-fleet-test-"));
  roots.push(root);
  process.env.HESTIA_HOME = join(root, "home");
  writeState(root, fixtureRecord(root));
  return {
    root,
    admission: new Admission(new SlotLedger(async () => "dead")),
  };
}

afterEach(() => {
  delete process.env.HESTIA_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Fleet snapshot collection", () => {
  test("maps Docker health and restart states without another probe", () => {
    const services = parseDockerFleetServices([
      "project\tdb\trunning\tUp 5 seconds (healthy)",
      "project\tapi\trunning\tUp 2 seconds (health: starting)",
      "project\tworker\trestarting\tRestarting (1) 1 second ago",
    ].join("\n"));
    expect(services.get("project")?.get("db")).toBe("healthy");
    expect(services.get("project")?.get("api")).toBe("unhealthy");
    expect(services.get("project")?.get("worker")).toBe("unhealthy");
  });

  test("does not count a dead empty provisional mirror as live", async () => {
    const { root, admission } = setupFleet();
    writeState(root, {
      ...fixtureRecord(root),
      state: "starting",
      starter: { pid: 999_999_999, startTime: "dead" },
      services: [],
    });
    const snapshot = await collectFleetSnapshot(repoId, admission);
    expect(snapshot.stacks[0]?.phase).toBe("stopped");
    expect(snapshot.capacity.live).toBe(0);
  });

  test("counts a live empty provisional mirror as occupying capacity", async () => {
    const { root, admission } = setupFleet();
    writeState(root, {
      ...fixtureRecord(root),
      state: "starting",
      starter: { pid: process.pid, startTime: startTimeOf(process.pid) ?? "" },
      services: [],
    });
    const snapshot = await collectFleetSnapshot(repoId, admission);
    expect(snapshot.stacks[0]?.phase).toBe("starting");
    expect(snapshot.capacity.live).toBe(1);
  });

  test("overlays queued admission state onto an existing stopped mirror", async () => {
    const { root, admission } = setupFleet();
    const stopped = { ...fixtureRecord(root), state: "stopped" as const, services: [] };
    writeState(root, stopped);
    const snapshot = await collectFleetSnapshot(repoId, {
      ledger: admission.ledger,
      queuedIdentitySnapshot: () => [{
        project: stopped.project,
        repoId,
        repo: stopped.repo,
        branch: stopped.branch,
        worktree: stopped.worktree,
      }],
    });
    expect(snapshot.stacks[0]?.phase).toBe("queued");
  });

  test("capacity excludes tunnel-only mirrors and mirror-backed reservations", async () => {
    const { root, admission } = setupFleet();
    const tunnelRoot = join(root, "tunnel-stack");
    writeState(tunnelRoot, {
      ...fixtureRecord(tunnelRoot),
      project: "fixture-tunnel-only",
      services: [{
        name: "public",
        backend: "tunnel",
        state: "healthy",
        pid: process.pid,
        startTime: startTimeOf(process.pid),
      }],
    });
    admission.ledger.reserveFor("fixture-fleet", {
      pid: process.pid,
      startTime: startTimeOf(process.pid) ?? "",
    });
    const snapshot = await collectFleetSnapshot(repoId, admission);
    expect(snapshot.capacity.live).toBe(1);
    expect(snapshot.capacity.reserved).toBe(0);
  });

  test("projects only managed mirrors and omits raw state secrets", async () => {
    const { admission } = setupFleet();
    const snapshot = await collectFleetSnapshot(repoId, admission);
    expect(snapshot.stacks).toHaveLength(1);
    expect(snapshot.stacks[0]).toMatchObject({
      project: "fixture-fleet",
      repoId,
      branch: "fleet",
    });
    const wire = JSON.stringify(snapshot);
    expect(wire).not.toContain("must-not-leak");
    expect(wire).not.toContain("application.log");
    expect(wire).not.toContain('"pid"');
  });
});

describe("authenticated daemon Fleet routes", () => {
  test("rejects missing bearer auth and streams an initial full snapshot", async () => {
    const { admission } = setupFleet();
    const fleet = new FleetMonitor(admission, { refreshMs: 20, heartbeatMs: 100 });
    const routes = createRoutes(admission, new Date(0).toISOString(), {
      token: "test-token",
      fleet,
      logsProject: async function* () {},
    });
    try {
      const unauthorized = await routes(new Request("http://localhost/hestia/health"));
      expect(unauthorized?.status).toBe(401);

      const response = await routes(new Request(
        `http://localhost/hestia/fleet?repoId=${repoId}`,
        { headers: { authorization: "Bearer test-token" } },
      ));
      expect(response?.status).toBe(200);
      const reader = response!.body!.getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain('"type":"snapshot"');
      expect(text).toContain('"project":"fixture-fleet"');
      await reader.cancel();
    } finally {
      fleet.stop();
    }
  });

  test("rejects a chunked JSON body as soon as it exceeds 16 KiB", async () => {
    const { admission } = setupFleet();
    const fleet = new FleetMonitor(admission);
    const routes = createRoutes(admission, new Date(0).toISOString(), {
      token: "test-token",
      fleet,
      logsProject: async function* () {},
    });
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(20 * 1024)));
          controller.close();
        },
      });
      const response = await routes(new Request("http://localhost/hestia/acquire", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body,
      }));
      expect(response?.status).toBe(400);
      expect(await response?.text()).toContain("exceeds");
    } finally {
      fleet.stop();
    }
  });
});
