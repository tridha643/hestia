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
    shared: [],
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

  claims: string[] = [];
  allows: string[] = [];
  denies: string[] = [];
  releases: string[] = [];

  diagnose() { return Promise.resolve([]); }
  down(stack: FleetStackView) { this.downs.push(stack.project); return Promise.resolve(); }
  claimShared(worktree: string, name: string) { this.claims.push(`${worktree}:${name}`); return Promise.resolve(); }
  allowShared(worktree: string, name: string) { this.allows.push(`${worktree}:${name}`); return Promise.resolve(); }
  denyShared(worktree: string, name: string) { this.denies.push(`${worktree}:${name}`); return Promise.resolve(); }
  releaseShared(worktree: string, name: string) { this.releases.push(`${worktree}:${name}`); return Promise.resolve(); }
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

  test("s opens the shared overlay; claim acts as the selected stack, allow as the holder", async () => {
    const withShared: FleetSnapshot = {
      ...snapshot(),
      shared: [{
        name: "tri-slack",
        hostname: "tri-slack.modem.codes",
        url: "https://tri-slack.modem.codes",
        holder: { project: "modem-beta", worktree: "/tmp/beta", mine: true },
        queue: [],
      }],
    };
    const source = new FakeFleetSource(withShared);
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
        await setup.mockInput.typeText("s");
      });
      await setup.waitForFrame((candidate) =>
        candidate.includes("tri-slack.modem.codes") && candidate.includes("held by modem-beta"));
      // claim runs AS the selected stack (modem-alpha), not the holder
      await act(async () => {
        await setup.mockInput.typeText("c");
      });
      await setup.waitForFrame((candidate) => candidate.includes("claiming as modem-alpha"));
      expect(source.claims).toEqual(["/tmp/alpha:tri-slack"]);
      // allow runs AS the holder (modem-beta)
      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await setup.waitForFrame((candidate) => candidate.includes("allowing tri-slack"));
      expect(source.allows).toEqual(["/tmp/beta:tri-slack"]);
      // Esc closes the overlay
      await act(async () => {
        await setup.mockInput.pressKeys(["ESCAPE"], 30);
      });
      await setup.waitForFrame((candidate) => !candidate.includes("held by modem-beta"));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("keyboard navigation selects the next stack row", async () => {
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
        await setup.mockInput.typeText("j");
        await setup.flush();
      });
      const frame = await setup.waitForFrame((candidate) => candidate.includes("Workloads — beta"));
      expect(frame).toContain("ingest");
      expect(frame).toContain("● beta");
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
      const frame = await setup.waitForFrame((candidate) => candidate.includes("Hestia Fleet") && candidate.includes("modem"));
      expect(frame).toContain("Hestia Fleet");
      expect(frame).toContain("modem");
      expect(frame).toContain("/Users/tri/conductor/workspaces/modem/salem");
      expect(frame).not.toContain("secret");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("mouse click selects a stack row", async () => {
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
      // header(1) + context(2) + sidebar border(1) + title(1) → rows begin at y=5
      await act(async () => {
        await setup.mockMouse.click(6, 6);
      });
      const frame = await setup.waitForFrame((candidate) => candidate.includes("Workloads — beta"));
      expect(frame).toContain("ingest");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test(", and . step between stacks from any pane focus", async () => {
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
        await setup.mockInput.typeText(".");
      });
      await setup.waitForFrame((candidate) => candidate.includes("Workloads — beta"));
      await act(async () => {
        await setup.mockInput.typeText(",");
      });
      await setup.waitForFrame((candidate) => candidate.includes("Workloads — alpha"));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("f pauses log follow and f or G resumes it", async () => {
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
      await setup.waitForFrame((candidate) => candidate.includes("following"));
      await act(async () => {
        await setup.mockInput.typeText("f");
      });
      await setup.waitForFrame((candidate) => candidate.includes("paused"));
      await act(async () => {
        await setup.mockInput.typeText("G");
      });
      await setup.waitForFrame((candidate) => candidate.includes("following"));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("Y yanks the stack env block rebuilt from the fleet projection", async () => {
    const withPublished: FleetSnapshot = {
      ...snapshot(),
      stacks: snapshot().stacks.map((stack, index) => index !== 0 ? stack : {
        ...stack,
        services: [{
          name: "dashboard",
          backend: "proc" as const,
          state: "healthy" as const,
          publishedPort: 4100,
          endpoint: {
            name: "dashboard",
            host: "127.0.0.1",
            port: 4100,
            url: "http://127.0.0.1:4100",
            publicUrl: "https://alpha.dev.example.com",
          },
        }],
      }),
    };
    const source = new FakeFleetSource(withPublished);
    const setup = await testRender(
      <FleetApp source={source as unknown as DaemonFleetSource} preferredProject="modem-alpha" invokingRepository={invokingRepository} onQuit={() => {}} />,
      { width: 130, height: 28 },
    );
    try {
      await act(async () => {
        source.start();
        await setup.flush();
      });
      const frame = await setup.waitForFrame((candidate) => candidate.includes("dashboard ready"));
      // endpoints with a public URL advertise it inline
      expect(frame).toContain("pub");
      await act(async () => {
        await setup.mockInput.typeText("Y");
      });
      await setup.waitForFrame((candidate) => candidate.includes("env block (3 keys)"));
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
