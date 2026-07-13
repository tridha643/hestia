import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HestiaError, type StackRecord } from "@hestia/core";
import {
  declareSharedHostname,
  listSharedHostnames,
  normalizeSharedPath,
  readSharedHostname,
  removeSharedHostname,
  setSharedHolder,
  sharedPathMatches,
  sharedRoot,
  updateSharedHostname,
} from "../src/tunnel/shared.ts";
import { generateMergedConfig } from "../src/tunnel/ingress.ts";
import { startTimeOf } from "../src/proc/pidfile.ts";
import {
  ORIGIN_DEAD_RELEASE_STRIKES,
  SharedArbiter,
} from "../src/daemon/shared-arbiter.ts";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hestia-shared-unit-"));
  for (const k of ["HESTIA_HOME"]) savedEnv[k] = process.env[k];
  process.env.HESTIA_HOME = home;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeMirror(project: string, overrides: Partial<StackRecord> = {}): void {
  const dir = join(home, "stacks", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "stack.json"),
    JSON.stringify({
      project,
      repo: "r",
      branch: "b",
      worktree: join(home, "wt", project),
      state: "up",
      services: [],
      env: {},
      endpoints: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    } satisfies Partial<StackRecord> & { project: string }),
  );
}

function writeMirrorPidfile(project: string, name: string): void {
  const dir = join(home, "stacks", project, "procs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    name,
    pid: process.pid,
    pgid: process.pid,
    startTime: startTimeOf(process.pid)!,
    argv: ["test"],
    specFingerprint: "test",
    logPath: "/dev/null",
    signal: "term",
    backend: "proc",
  }));
}

const DECLARATION = {
  name: "tri-slack",
  hostname: "tri-slack.example.dev",
  tunnelUuid: "uuid-1",
  zone: "example.dev",
  service: "slack",
};

describe("shared store", () => {
  test("declare, read back, list", async () => {
    const record = await declareSharedHostname(DECLARATION);
    expect(record.schemaVersion).toBe(1);
    expect(record.holder).toBeUndefined();
    expect(readSharedHostname("tri-slack")?.hostname).toBe("tri-slack.example.dev");
    expect(listSharedHostnames().map((r) => r.name)).toEqual(["tri-slack"]);
  });

  test("re-declare same target is idempotent and preserves the holder", async () => {
    await declareSharedHostname(DECLARATION);
    await setSharedHolder("tri-slack", {
      project: "p-a", worktree: "/wt/a", service: "slack", at: "2026-01-01T00:00:00Z",
    });
    const again = await declareSharedHostname({ ...DECLARATION, service: "slack-v2" });
    expect(again.holder?.project).toBe("p-a");
    expect(again.service).toBe("slack-v2");
  });

  test("re-declare pointing elsewhere is shared-conflict", async () => {
    await declareSharedHostname(DECLARATION);
    await expect(
      declareSharedHostname({ ...DECLARATION, hostname: "other.example.dev" }),
    ).rejects.toMatchObject({ code: "shared-conflict" });
  });

  test("durable queue round-trips through the record file", async () => {
    await declareSharedHostname(DECLARATION);
    await updateSharedHostname("tri-slack", (record) => ({
      ...record,
      queue: [{ project: "p-b", worktree: "/wt/b", at: "2026-01-01T00:00:00Z" }],
    }));
    const raw = JSON.parse(
      readFileSync(join(sharedRoot(), "tri-slack.json"), "utf8"),
    ) as { queue?: unknown[] };
    expect(raw.queue).toHaveLength(1);
    expect(readSharedHostname("tri-slack")?.queue?.[0]?.project).toBe("p-b");
  });

  test("remove refuses while held, succeeds after release", async () => {
    await declareSharedHostname(DECLARATION);
    await setSharedHolder("tri-slack", {
      project: "p-a", worktree: "/wt/a", service: "slack", at: "2026-01-01T00:00:00Z",
    });
    await expect(removeSharedHostname("tri-slack")).rejects.toMatchObject({ code: "shared-held" });
    await setSharedHolder("tri-slack", undefined);
    await removeSharedHostname("tri-slack");
    expect(readSharedHostname("tri-slack")).toBeNull();
  });

  test("invalid names are rejected", async () => {
    await expect(declareSharedHostname({ ...DECLARATION, name: "Bad_Name" }))
      .rejects.toMatchObject({ code: "usage" });
  });

  test("accepts an arbitrary hostname on any zone", async () => {
    const record = await declareSharedHostname({
      ...DECLARATION, name: "acme", hostname: "slack.acme.com", zone: "acme.com",
    });
    expect(record.hostname).toBe("slack.acme.com");
    expect(readSharedHostname("acme")?.hostname).toBe("slack.acme.com");
  });

  test("rejects a non-FQDN hostname", async () => {
    await expect(declareSharedHostname({ ...DECLARATION, hostname: "notadomain" }))
      .rejects.toMatchObject({ code: "usage" });
    await expect(declareSharedHostname({ ...DECLARATION, hostname: "UPPER.example.dev" }))
      .rejects.toMatchObject({ code: "usage" });
  });

  test("two handles may share a hostname with distinct paths", async () => {
    await declareSharedHostname({
      ...DECLARATION, name: "sl", hostname: "acme.com", zone: "acme.com", path: "/slack",
    });
    const st = await declareSharedHostname({
      ...DECLARATION, name: "st", hostname: "acme.com", zone: "acme.com", path: "/stripe/hooks",
    });
    expect(st.path).toBe("/stripe/hooks");
    expect(listSharedHostnames().map((r) => r.name).sort()).toEqual(["sl", "st"]);
  });

  test("identical (hostname, path) across handles is shared-conflict", async () => {
    await declareSharedHostname({
      ...DECLARATION, name: "sl", hostname: "acme.com", zone: "acme.com", path: "/slack",
    });
    await expect(declareSharedHostname({
      ...DECLARATION, name: "sl2", hostname: "acme.com", zone: "acme.com", path: "/slack/",
    })).rejects.toMatchObject({ code: "shared-conflict" });
  });

  test("path is normalized (or dropped) on write, never stored verbatim", async () => {
    const whole = await declareSharedHostname({ ...DECLARATION, name: "whole", path: "/" });
    expect(whole.path).toBeUndefined();
    const trimmed = await declareSharedHostname({
      ...DECLARATION, name: "trim", hostname: "acme.com", zone: "acme.com", path: "webhooks/slack/",
    });
    expect(trimmed.path).toBe("/webhooks/slack");
  });

  test("rejects a path with query, fragment, or traversal", async () => {
    for (const path of ["/a?b", "/a#b", "/a/../b"]) {
      await expect(declareSharedHostname({ ...DECLARATION, name: "p", path }))
        .rejects.toMatchObject({ code: "usage" });
    }
  });
});

describe("path prefix helpers", () => {
  test("normalizeSharedPath", () => {
    expect(normalizeSharedPath(undefined)).toBeUndefined();
    expect(normalizeSharedPath("")).toBeUndefined();
    expect(normalizeSharedPath("/")).toBeUndefined();
    expect(normalizeSharedPath("slack")).toBe("/slack");
    expect(normalizeSharedPath("//a//b/")).toBe("/a/b");
  });

  test("sharedPathMatches at segment boundaries only", () => {
    expect(sharedPathMatches(undefined, "/anything")).toBeTrue();
    expect(sharedPathMatches("/slack", "/slack")).toBeTrue();
    expect(sharedPathMatches("/slack", "/slack/events")).toBeTrue();
    expect(sharedPathMatches("/slack", "/slackbot")).toBeFalse();
    expect(sharedPathMatches("/slack", "/")).toBeFalse();
  });
});

describe("merged config with shared rules", () => {
  const base = { uuid: "uuid-1", credFile: "/cred.json" };

  test("shared rule keeps the public Host (no originRequest) and sits between base and dynamic", () => {
    const yaml = generateMergedConfig({
      ...base,
      baseRules: [{ hostname: "static.example.dev", service: "http://localhost:3000" }],
      dynamicRules: [{
        project: "p-a", service: "web", hostname: "tri-b-web.example.dev", originPort: 4000,
      }],
      sharedRules: [{ name: "tri-slack", hostname: "tri-slack.example.dev" }],
    });
    const parsed = parseYaml(yaml) as { ingress: Array<Record<string, unknown>> };
    expect(parsed.ingress.map((rule) => rule.hostname)).toEqual([
      "static.example.dev",
      "tri-slack.example.dev",
      "tri-b-web.example.dev",
      undefined, // catch-all
    ]);
    const shared = parsed.ingress[1]!;
    expect(shared.originRequest).toBeUndefined();
    expect(String(shared.service)).toStartWith("unix:");
  });

  test("shared hostname colliding with base rules is hostname-conflict", () => {
    expect(() => generateMergedConfig({
      ...base,
      baseRules: [{ hostname: "tri-slack.example.dev", service: "http://localhost:3000" }],
      dynamicRules: [],
      sharedRules: [{ name: "tri-slack", hostname: "tri-slack.example.dev" }],
    })).toThrow(HestiaError);
  });

  test("dynamic exposure colliding with a shared hostname is hostname-conflict", () => {
    expect(() => generateMergedConfig({
      ...base,
      baseRules: [],
      dynamicRules: [{
        project: "p-a", service: "web", hostname: "tri-slack.example.dev", originPort: 4000,
      }],
      sharedRules: [{ name: "tri-slack", hostname: "tri-slack.example.dev" }],
    })).toThrow(HestiaError);
  });

  test("several path-scoped handles on one hostname collapse to ONE ingress rule", () => {
    const yaml = generateMergedConfig({
      ...base,
      baseRules: [],
      dynamicRules: [],
      sharedRules: [
        { name: "sl", hostname: "acme.com" },
        { name: "st", hostname: "acme.com" },
      ],
    });
    const parsed = parseYaml(yaml) as { ingress: Array<Record<string, unknown>> };
    expect(parsed.ingress.filter((rule) => rule.hostname === "acme.com")).toHaveLength(1);
    // sibling handles sharing a hostname are NOT a mutual conflict
    expect(parsed.ingress.map((rule) => rule.hostname)).toEqual(["acme.com", undefined]);
  });
});

describe("shared arbiter", () => {
  test("claim on unclaimed grants immediately; repeat claim is idempotent", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    const arbiter = new SharedArbiter();
    const first = await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    expect(first.granted).toBeTrue();
    expect(first.holder?.project).toBe("p-a");
    const again = await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    expect(again.granted).toBeTrue();
  });

  test("claim on a held name queues durably; re-request keeps position", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-b");
    writeMirror("p-c");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    const queuedB = await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);
    expect(queuedB.granted).toBeFalse();
    await arbiter.request("tri-slack", { project: "p-c", worktree: "/wt/c" }, 0);
    // p-b re-requests (CLI came back after a timeout) — still first in line
    const reattached = await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);
    expect(reattached.granted).toBeFalse();
    expect(reattached.queued.map((waiter) => waiter.project)).toEqual(["p-b", "p-c"]);
    // durability: a NEW arbiter (daemon restart) sees the same queue
    const rebooted = new SharedArbiter();
    const view = await rebooted.request("tri-slack", { project: "p-c", worktree: "/wt/c" }, 0);
    expect(view.queued.map((waiter) => waiter.project)).toEqual(["p-b", "p-c"]);
  });

  test("allow hands over to the head and wakes its long-poll", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-b");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    const pending = arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 5_000);
    await Bun.sleep(20); // the waiter must be enqueued before the holder allows
    await arbiter.allow("tri-slack", "p-a");
    const granted = await pending;
    expect(granted.granted).toBeTrue();
    expect(granted.holder?.project).toBe("p-b");
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-b");
  });

  test("deny keeps the waiter queued; release then grants it", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-b");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);
    const denied = await arbiter.deny("tri-slack", "p-a");
    expect(denied.queued[0]).toMatchObject({ project: "p-b", denied: true });
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");
    await arbiter.release("tri-slack", "p-a");
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-b");
  });

  test("allow with an empty queue releases; non-holders cannot arbitrate", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await expect(arbiter.allow("tri-slack", "p-x")).rejects.toMatchObject({ code: "shared-not-holder" });
    await arbiter.allow("tri-slack", "p-a");
    expect(readSharedHostname("tri-slack")?.holder).toBeUndefined();
  });

  test("cancel drops the durable entry", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-b");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);
    await arbiter.cancel("tri-slack", "p-b");
    expect(readSharedHostname("tri-slack")?.queue ?? []).toHaveLength(0);
  });

  test("releaseProject frees only matching service contracts", async () => {
    await declareSharedHostname(DECLARATION);
    await declareSharedHostname({
      name: "tri-api", hostname: "tri-api.example.dev",
      tunnelUuid: "uuid-1", zone: "example.dev", service: "api",
    });
    writeMirror("p-a");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-api", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.releaseProject("p-a", "slack"); // `hestia stop` of the slack workload
    expect(readSharedHostname("tri-slack")?.holder).toBeUndefined();
    expect(readSharedHostname("tri-api")?.holder?.project).toBe("p-a");
    await arbiter.releaseProject("p-a"); // full `hestia down`
    expect(readSharedHostname("tri-api")?.holder).toBeUndefined();
  });

  test("grant skips dead waiters; sweep releases dead holders and prunes the queue", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-c");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0); // no mirror → dead
    await arbiter.request("tri-slack", { project: "p-c", worktree: "/wt/c" }, 0);
    rmSync(join(home, "stacks", "p-b"), { recursive: true, force: true });
    await arbiter.release("tri-slack", "p-a");
    // p-b's mirror is gone — the grant skips straight to p-c
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-c");
    // now p-c's stack dies without a down; the sweep frees the name
    rmSync(join(home, "stacks", "p-c"), { recursive: true, force: true });
    await arbiter.sweep(new Set(["p-a"]));
    expect(readSharedHostname("tri-slack")?.holder).toBeUndefined();
  });

  test("releases an occupied holder only after three dead-origin strikes", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-b");
    const arbiter = new SharedArbiter({ probeHolderOrigin: async () => "dead" });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);

    for (let strike = 1; strike < ORIGIN_DEAD_RELEASE_STRIKES; strike += 1) {
      expect(await arbiter.sweep(new Set(["p-a"]))).toEqual([]);
      expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");
    }
    expect(await arbiter.sweep(new Set(["p-a"]))).toEqual([{
      name: "tri-slack", project: "p-a", reason: "origin-dead",
    }]);
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-b");
  });

  test("live resets dead strikes while unknown preserves them without advancing", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    let origin: "live" | "dead" | "unknown" = "dead";
    const arbiter = new SharedArbiter({ probeHolderOrigin: async () => origin });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);

    await arbiter.sweep(new Set(["p-a"]));
    await arbiter.sweep(new Set(["p-a"]));
    origin = "live";
    await arbiter.sweep(new Set(["p-a"]));
    origin = "dead";
    await arbiter.sweep(new Set(["p-a"]));
    await arbiter.sweep(new Set(["p-a"]));
    origin = "unknown";
    expect(await arbiter.sweep(new Set(["p-a"]))).toEqual([]);
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");
    origin = "dead";
    expect((await arbiter.sweep(new Set(["p-a"])))[0]?.reason).toBe("origin-dead");
  });

  test("non-occupied stacks preserve ownership when a resolvable origin probe is unknown", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a", {
      services: [{
        name: "slack", backend: "proc", state: "healthy", publishedPort: 4100,
        pid: process.pid, startTime: "test identity",
      }],
      endpoints: [{ name: "slack", host: "127.0.0.1", port: 4100 }],
    });
    const arbiter = new SharedArbiter({ probeHolderOrigin: async () => "unknown" });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    for (let tick = 0; tick < ORIGIN_DEAD_RELEASE_STRIKES + 1; tick += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");
  });

  test("non-occupied stacks preserve an unresolved contract while another proc is live", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a", {
      services: [{
        name: "other", backend: "proc", state: "healthy", publishedPort: 4100,
        pid: process.pid, startTime: startTimeOf(process.pid)!,
      }],
      endpoints: [],
    });
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    for (let tick = 0; tick < ORIGIN_DEAD_RELEASE_STRIKES + 1; tick += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");
  });

  test("non-occupied stacks preserve a live pre-state-write mirrored pidfile", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a", { services: [{
      name: "malformed", backend: "proc", state: "healthy", pid: 0, startTime: "invalid",
    }] });
    writeMirrorPidfile("p-a", "starting-web");
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    for (let tick = 0; tick < ORIGIN_DEAD_RELEASE_STRIKES + 1; tick += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");
  });

  test("debounces dead stacks, protects startup, and contains corrupt mirrors", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a", { state: "starting" });
    const arbiter = new SharedArbiter({ probeHolderOrigin: async () => "dead" });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    for (let tick = 0; tick < ORIGIN_DEAD_RELEASE_STRIKES + 1; tick += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-a");

    writeMirror("p-a", { state: "up" });
    for (let strike = 1; strike < ORIGIN_DEAD_RELEASE_STRIKES; strike += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect((await arbiter.sweep(new Set()))[0]?.reason).toBe("stack-dead");

    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    writeFileSync(join(home, "stacks", "p-a", "stack.json"), "{broken");
    for (let strike = 1; strike < ORIGIN_DEAD_RELEASE_STRIKES; strike += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect((await arbiter.sweep(new Set()))[0]?.reason).toBe("stack-dead");
  });

  test("contains parseable nested mirror corruption per holder", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a", { state: "up" });
    const arbiter = new SharedArbiter();
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    const path = join(home, "stacks", "p-a", "stack.json");
    const malformed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete malformed.starter;
    malformed.services = [{
      name: "slack", backend: "proc", state: "healthy", publishedPort: 4100,
      pid: 0, startTime: "invalid",
    }];
    malformed.endpoints = [{ name: "slack", host: "127.0.0.1", port: 4100 }];
    writeFileSync(path, JSON.stringify(malformed));
    for (let strike = 1; strike < ORIGIN_DEAD_RELEASE_STRIKES; strike += 1) {
      expect(await arbiter.sweep(new Set())).toEqual([]);
    }
    expect((await arbiter.sweep(new Set()))[0]?.reason).toBe("stack-dead");
  });

  test("a holder handoff resets strikes for the new holder incarnation", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    writeMirror("p-b");
    const arbiter = new SharedArbiter({ probeHolderOrigin: async () => "dead" });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);
    await arbiter.sweep(new Set(["p-a"]));
    await arbiter.sweep(new Set(["p-a"]));
    await arbiter.allow("tri-slack", "p-a");
    expect(await arbiter.sweep(new Set(["p-b"]))).toEqual([]);
    expect(readSharedHostname("tri-slack")?.holder?.project).toBe("p-b");
  });

  test("does not prune a waiter whose mirror appears during the holder probe", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    let beginProbe!: () => void;
    let finishProbe!: () => void;
    const probing = new Promise<void>((resolve) => { beginProbe = resolve; });
    const finish = new Promise<void>((resolve) => { finishProbe = resolve; });
    const arbiter = new SharedArbiter({
      probeHolderOrigin: async () => {
        beginProbe();
        await finish;
        return "live";
      },
    });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await arbiter.request("tri-slack", { project: "p-b", worktree: "/wt/b" }, 0);

    const sweep = arbiter.sweep(new Set(["p-a"]));
    await probing;
    writeMirror("p-b");
    finishProbe();
    await sweep;
    expect(readSharedHostname("tri-slack")?.queue?.map((waiter) => waiter.project)).toEqual(["p-b"]);
  });

  test("probes the current holder contract after a re-declaration changes future grants", async () => {
    await declareSharedHostname(DECLARATION);
    writeMirror("p-a");
    const probedContracts: string[] = [];
    const arbiter = new SharedArbiter({
      probeHolderOrigin: async (_mirror, contractService) => {
        probedContracts.push(contractService);
        return "live";
      },
    });
    await arbiter.request("tri-slack", { project: "p-a", worktree: "/wt/a" }, 0);
    await declareSharedHostname({ ...DECLARATION, service: "slack-v2" });
    await arbiter.sweep(new Set(["p-a"]));
    expect(probedContracts).toEqual(["slack"]);
  });

  test("unknown names surface shared-not-found", async () => {
    const arbiter = new SharedArbiter();
    await expect(arbiter.request("nope", { project: "p-a", worktree: "/wt/a" }, 0))
      .rejects.toMatchObject({ code: "shared-not-found" });
  });
});
