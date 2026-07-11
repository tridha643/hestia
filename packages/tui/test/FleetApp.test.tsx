import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { FleetEnvelope, FleetSnapshot, FleetStackView, LogLine, RepoId } from "@hestia/core";
import type { DaemonFleetSource } from "../src/fleet-source.ts";
import {
  doctorOmissionSummary,
  FleetApp,
  fleetLogSelectionKey,
  middleTruncateWorktreePath,
} from "../src/FleetApp.tsx";

const repoId = "repo-1234567890abcdef" as RepoId;

function snapshot(): FleetSnapshot {
  return {
    repoId,
    observedAt: new Date().toISOString(),
    capacity: { maxStacks: 5, live: 2, reserved: 0, queued: 0 },
    warnings: [],
    stacks: [
      {
        project: "modem-alpha",
        repoId,
        repo: "modem",
        branch: "alpha",
        worktree: "/tmp/alpha",
        createdAt: "2026-01-01T00:00:00.000Z",
        phase: "up",
        services: [{
          name: "dashboard",
          backend: "proc",
          state: "healthy",
          endpoint: { name: "dashboard", host: "127.0.0.1", port: 4100, url: "http://127.0.0.1:4100" },
        }],
      },
      {
        project: "modem-beta",
        repoId,
        repo: "modem",
        branch: "beta",
        worktree: "/tmp/beta",
        createdAt: "2026-01-02T00:00:00.000Z",
        phase: "up",
        services: [{ name: "ingest", backend: "wrangler", state: "healthy" }],
      },
    ],
  };
}

class FakeFleetSource {
  readonly repoId = repoId;
  downs: string[] = [];
  readonly #ready: Promise<void>;
  #start!: () => void;

  constructor(readonly fleetSnapshot = snapshot()) {
    this.#ready = new Promise((resolve) => { this.#start = resolve; });
  }

  start() { this.#start(); }

  async *fleet(signal: AbortSignal): AsyncGenerator<FleetEnvelope> {
    await this.#ready;
    yield { type: "snapshot", sequence: 1, snapshot: this.fleetSnapshot };
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  async *logs(project: string, service: string, signal: AbortSignal): AsyncGenerator<LogLine> {
    await this.#ready;
    yield { project, service, source: "proc", text: "dashboard ready" };
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }

  diagnose() { return Promise.resolve([]); }
  down(stack: FleetStackView) { this.downs.push(stack.project); return Promise.resolve(); }
  stop() {}
}

const invokingRepository = { repo: "modem", branch: "alpha", worktree: "/tmp/alpha" };

describe("FleetApp", () => {
  test("log selection keys change across stack and service incarnations", () => {
    const original = snapshot().stacks[0]!;
    const replacedStack = { ...original, createdAt: "2026-01-03T00:00:00.000Z" };
    const rotatedService = {
      ...original,
      services: original.services.map((service) => ({ ...service, publishedPort: 4200 })),
    };
    const key = fleetLogSelectionKey(original, "dashboard");
    expect(fleetLogSelectionKey(replacedStack, "dashboard")).not.toBe(key);
    expect(fleetLogSelectionKey(rotatedService, "dashboard")).not.toBe(key);
  });

  test("renders wide and narrow layouts while retaining managed selection and logs", async () => {
    const source = new FakeFleetSource();
    const setup = await testRender(
      <FleetApp source={source as unknown as DaemonFleetSource} preferredProject="modem-alpha" invokingRepository={invokingRepository} onQuit={() => {}} />,
      { width: 140, height: 28 },
    );
    try {
      await act(async () => {
        source.start();
        await setup.flush();
      });
      const initial = await setup.waitForFrame((candidate) => candidate.includes("dashboard ready"));
      let frame = initial;
      expect(frame).toContain("alpha");
      expect(frame).toContain("beta");
      expect(frame).toContain("dashboard ready");

      await act(async () => {
        setup.resize(88, 28);
        await setup.flush();
      });
      frame = setup.captureCharFrame();
      expect(frame).toContain("alpha");
      expect(frame).toContain("dashboard");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("down confirmation consumes keys, cancels, then confirms without destroy", async () => {
    const source = new FakeFleetSource();
    const setup = await testRender(
      <FleetApp source={source as unknown as DaemonFleetSource} preferredProject="modem-alpha" invokingRepository={invokingRepository} onQuit={() => {}} />,
      { width: 120, height: 28 },
    );
    try {
      await act(async () => {
        source.start();
        await setup.flush();
      });
      await setup.waitForFrame((candidate) => candidate.includes("dashboard ready"));
      await act(async () => {
        await setup.mockInput.typeText("d");
      });
      await setup.waitForFrame((candidate) => candidate.includes("Named volumes are retained"));
      await act(async () => {
        await setup.mockInput.pressKeys(["ESCAPE", "x"], 30);
      });
      await setup.waitForFrame((candidate) => !candidate.includes("Named volumes are retained"));
      await act(async () => {
        await setup.mockInput.typeText("d");
      });
      await setup.waitForFrame((candidate) => candidate.includes("Named volumes are retained"));
      await act(async () => setup.mockInput.pressEnter());
      await setup.waitForFrame((candidate) => candidate.includes("named volumes retained"));
      expect(source.downs).toEqual(["modem-alpha"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("mouse clicks select a stack row", async () => {
    const source = new FakeFleetSource();
    const setup = await testRender(
      <FleetApp source={source as unknown as DaemonFleetSource} preferredProject="modem-alpha" invokingRepository={invokingRepository} onQuit={() => {}} />,
      { width: 120, height: 28 },
    );
    try {
      await act(async () => {
        source.start();
        await setup.flush();
      });
      await setup.waitForFrame((candidate) => candidate.includes("Workloads — alpha"));
      await act(async () => {
        await setup.mockMouse.click(2, 8);
        await setup.flush();
      });
      const frame = await setup.waitForFrame((candidate) => candidate.includes("Workloads — beta"));
      expect(frame).toContain("ingest");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("does not offer down for queued or reserved synthetic rows", async () => {
    const source = new FakeFleetSource({
      ...snapshot(),
      capacity: { maxStacks: 5, live: 0, reserved: 0, queued: 1 },
      stacks: [{
        project: "modem-queued",
        repoId,
        repo: "modem",
        branch: "queued",
        worktree: "/tmp/queued",
        phase: "queued",
        services: [],
      }],
    });
    const setup = await testRender(
      <FleetApp source={source as unknown as DaemonFleetSource} preferredProject="modem-queued" invokingRepository={invokingRepository} onQuit={() => {}} />,
      { width: 120, height: 28 },
    );
    try {
      await act(async () => {
        source.start();
        await setup.flush();
      });
      await setup.waitForFrame((candidate) => candidate.includes("queued"));
      await act(async () => setup.mockInput.typeText("d"));
      const frame = await setup.waitForFrame((candidate) => candidate.includes("down is available after startup begins"));
      expect(frame).not.toContain("Confirm stack down");
      expect(source.downs).toEqual([]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("summarizes doctor rows hidden below the fixed-height report", () => {
    const rows = Array.from({ length: 13 }, (_, index) => ({
      check: `check-${index}`,
      level: index === 11 ? "error" as const : index === 12 ? "warn" as const : "ok" as const,
      detail: "detail",
    }));
    expect(doctorOmissionSummary(rows)).toBe("… 3 more (1 errors, 1 warnings)");
  });

  test("keeps invoking repository context visible with zero stacks", async () => {
    const source = new FakeFleetSource({
      ...snapshot(),
      capacity: { maxStacks: 5, live: 0, reserved: 0, queued: 0 },
      stacks: [],
    });
    const setup = await testRender(
      <FleetApp
        source={source as unknown as DaemonFleetSource}
        preferredProject="missing"
        invokingRepository={{
          repo: "modem\x1b]52;c;secret\x07",
          branch: "salem",
          worktree: "/Users/tri/conductor/workspaces/modem/salem",
        }}
        onQuit={() => {}}
      />,
      { width: 100, height: 24 },
    );
    try {
      await act(async () => {
        source.start();
        await setup.flush();
      });
      const frame = await setup.waitForFrame((candidate) => candidate.includes("Hestia Fleet — modem"));
      expect(frame).toContain("Hestia Fleet — modem");
      expect(frame).toContain("/Users/tri/conductor/workspaces/modem/salem");
      expect(frame).not.toContain("secret");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("middle-truncates paths while preserving orientation and basename", () => {
    const path = "/Users/tri/conductor/workspaces/modem/a-very-long-branch";
    const truncated = middleTruncateWorktreePath(path, 30);
    expect(truncated.length).toBeLessThanOrEqual(30);
    expect(truncated.startsWith("/Users/")).toBe(true);
    expect(truncated.endsWith("a-very-long-branch")).toBe(true);
  });
});
