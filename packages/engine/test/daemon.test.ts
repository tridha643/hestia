import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackRecord } from "@hestia/core";
import { startTimeOf } from "../src/proc/pidfile.ts";
import {
  DEFAULT_MAX_STACKS,
  SlotLedger,
  type DockerProbe,
  resolveMaxStacks,
} from "../src/daemon/slots.ts";
import { Admission } from "../src/daemon/routes.ts";
import { generatePlist } from "../src/daemon/launchd.ts";
import { readAdopted } from "../src/tunnel/registry.ts";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hestia-daemon-unit-"));
  for (const k of ["HESTIA_HOME", "HESTIA_MAX_STACKS"]) savedEnv[k] = process.env[k];
  process.env.HESTIA_HOME = home;
  delete process.env.HESTIA_MAX_STACKS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const me = () => ({ pid: process.pid, startTime: startTimeOf(process.pid) ?? "" });
const deadHolder = { pid: 99999999, startTime: "Thu Jan  1 00:00:00 1970" };

function writeMirror(project: string, record: Partial<StackRecord>): void {
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
      ...record,
    }),
  );
}

function writeMirrorPidfile(project: string, name: string, live: boolean, backend = "proc"): void {
  const dir = join(home, "stacks", project, "procs");
  mkdirSync(dir, { recursive: true });
  const id = live ? me() : deadHolder;
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({
      name,
      pid: id.pid,
      pgid: id.pid,
      startTime: id.startTime,
      argv: ["x"],
      logPath: "/dev/null",
      signal: "term",
      backend,
    }),
  );
}

const noDocker: DockerProbe = async () => "dead";

describe("resolveMaxStacks", () => {
  test("defaults, env precedence, strict parse", () => {
    expect(resolveMaxStacks().maxStacks).toBe(DEFAULT_MAX_STACKS);

    process.env.HESTIA_MAX_STACKS = "3";
    expect(resolveMaxStacks().maxStacks).toBe(3);

    for (const bad of ["banana", "0", "-2", "2.5"]) {
      process.env.HESTIA_MAX_STACKS = bad;
      const r = resolveMaxStacks();
      expect(r.maxStacks).toBe(DEFAULT_MAX_STACKS); // never deny-all
      expect(r.warnings.length).toBe(1);
    }

    delete process.env.HESTIA_MAX_STACKS;
    writeFileSync(join(home, "config.json"), JSON.stringify({ maxStacks: 2 }));
    expect(resolveMaxStacks().maxStacks).toBe(2);

    writeFileSync(join(home, "config.json"), "{not json");
    const r = resolveMaxStacks();
    expect(r.maxStacks).toBe(DEFAULT_MAX_STACKS);
    expect(r.warnings.length).toBe(1);
  });
});

describe("SlotLedger occupancy", () => {
  test("live proc counts; dead proc and tunnel-backend procs do not", async () => {
    writeMirror("alive", {});
    writeMirrorPidfile("alive", "web", true);
    writeMirror("dead", {});
    writeMirrorPidfile("dead", "web", false);
    writeMirror("tunnels-only", {});
    writeMirrorPidfile("tunnels-only", "tunnel-web", true, "tunnel");

    const occ = await new SlotLedger(noDocker).occupancy();
    expect(occ.live).toEqual(["alive"]);
  });

  test("provisional starting-record occupies while its holder lives", async () => {
    writeMirror("starting-live", { state: "starting", starter: me() });
    writeMirror("starting-dead", { state: "starting", starter: deadHolder });

    const occ = await new SlotLedger(noDocker).occupancy();
    expect(occ.live).toEqual(["starting-live"]);
  });

  test("docker liveness is sticky on probe error, never freeing", async () => {
    writeMirror("composey", {
      services: [{ name: "db", backend: "docker", state: "healthy" }],
    });
    let answer: Awaited<ReturnType<DockerProbe>> = "live";
    const ledger = new SlotLedger(async () => answer);

    expect((await ledger.occupancy()).live).toEqual(["composey"]);
    answer = null; // docker wedged — keep last known
    expect((await ledger.occupancy()).live).toEqual(["composey"]);
    answer = "dead"; // clean answer — free
    expect((await ledger.occupancy()).live).toEqual([]);
    answer = null; // wedged again — stick to dead now
    expect((await ledger.occupancy()).live).toEqual([]);
  });

  test("never-probed project under docker error defaults to LIVE (safe direction)", async () => {
    writeMirror("unknowable", {
      services: [{ name: "db", backend: "docker", state: "healthy" }],
    });
    const occ = await new SlotLedger(async () => null).occupancy();
    expect(occ.live).toEqual(["unknowable"]);
  });

  test("reservations persist as files, dedupe against live, expire with dead holders", async () => {
    const ledger = new SlotLedger(noDocker);
    ledger.reserveFor("fresh", me());
    ledger.reserveFor("doomed", deadHolder);
    writeMirror("recorded", {});
    writeMirrorPidfile("recorded", "web", true);
    ledger.reserveFor("recorded", me()); // record exists → reservation redundant

    const occ = await ledger.occupancy();
    expect(occ.live).toEqual(["recorded"]);
    expect(occ.reserved).toEqual(["fresh"]); // doomed expired, recorded deduped

    // a NEW ledger sees the same reservation — it's on disk, restart-safe
    const occ2 = await new SlotLedger(noDocker).occupancy();
    expect(occ2.reserved).toEqual(["fresh"]);
  });
});

describe("Admission", () => {
  test("grants under cap, fail-fast at cap, no-op re-grant for live project", async () => {
    process.env.HESTIA_MAX_STACKS = "1";
    const adm = new Admission(new SlotLedger(noDocker));

    expect((await adm.acquire("a", me(), 0)).granted).toBe(true);
    const denied = await adm.acquire("b", me(), 0);
    expect(denied.granted).toBe(false);
    expect(denied.live.concat().sort()).toEqual([]); // slot held by reservation, not live yet

    // same project re-acquires as a no-op
    expect((await adm.acquire("a", me(), 0)).granted).toBe(true);
  });

  test("concurrent acquires for different projects cannot both take the last slot", async () => {
    process.env.HESTIA_MAX_STACKS = "1";
    const adm = new Admission(new SlotLedger(noDocker));
    const [a, b] = await Promise.all([
      adm.acquire("left", me(), 0),
      adm.acquire("right", me(), 0),
    ]);
    expect([a.granted, b.granted].filter(Boolean).length).toBe(1);
  });

  test("FIFO wait: release grants the waiter; timeout fails it", async () => {
    process.env.HESTIA_MAX_STACKS = "1";
    const adm = new Admission(new SlotLedger(noDocker));
    expect((await adm.acquire("holder", me(), 0)).granted).toBe(true);

    const waiting = adm.acquire("waiter", me(), 5_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(adm.queuedProjects()).toEqual(["waiter"]);
    await adm.release("holder");
    expect((await waiting).granted).toBe(true);

    // and a waiter that never gets a slot times out as not-granted
    expect((await adm.acquire("timed-out", me(), 100)).granted).toBe(false);
  });

  test("waiter whose project went live by another path is granted out of order", async () => {
    process.env.HESTIA_MAX_STACKS = "1";
    const adm = new Admission(new SlotLedger(noDocker));
    expect((await adm.acquire("holder", me(), 0)).granted).toBe(true);

    const first = adm.acquire("blocked", me(), 3_000); // head of queue, needs a fresh slot
    await new Promise((r) => setTimeout(r, 20));
    const second = adm.acquire("sideways", me(), 3_000);
    await new Promise((r) => setTimeout(r, 20));

    // "sideways" becomes live via --no-daemon/another CLI: mirror appears
    writeMirror("sideways", {});
    writeMirrorPidfile("sideways", "web", true);
    await adm.pump();

    expect((await second).granted).toBe(true); // no-op grant, out of FIFO order
    expect(adm.queuedProjects()).toEqual(["blocked"]); // still waiting — sideways took no fresh slot

    // capacity frees only when a slot-holder actually goes away
    rmSync(join(home, "stacks", "sideways"), { recursive: true, force: true });
    await adm.release("holder");
    expect((await first).granted).toBe(true);
  });
});

describe("launchd plist", () => {
  test("KeepAlive is SuccessfulExit:false and PATH is baked", () => {
    const plist = generatePlist({
      bunPath: "/opt/bun",
      mainPath: "/repo/main.ts",
      path: "/opt/homebrew/bin:/usr/bin",
      logPath: "/h/daemon/launchd.log",
      hestiaHome: "/h",
    });
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).not.toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).toContain("<key>HESTIA_HOME</key><string>/h</string>");
    expect(plist).toContain("<string>/opt/bun</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });
});

describe("adopted.json", () => {
  const uuid = "0000-uuid";

  test("enriched marker round-trips", () => {
    const dir = join(home, "tunnel", uuid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "adopted.json"),
      JSON.stringify({ at: "2026-01-01", uuid, name: "tri", credFile: "/c/uuid.json" }),
    );
    const ref = readAdopted(uuid);
    expect(ref).toEqual({ uuid, name: "tri", credFile: "/c/uuid.json", reconstructed: false });
  });

  test("legacy {at}-only marker reconstructs from conventions + mirrors", () => {
    const dir = join(home, "tunnel", uuid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "adopted.json"), JSON.stringify({ at: "2026-01-01" }));
    writeMirror("stacked", {
      tunnel: { name: "tri", uuid, zone: "modem.codes", credFile: "/x.json", exposures: [] },
    });

    const ref = readAdopted(uuid)!;
    expect(ref.reconstructed).toBe(true);
    expect(ref.name).toBe("tri"); // from the mirror
    expect(ref.credFile.endsWith(`${uuid}.json`)).toBe(true); // ~/.cloudflared convention
  });

  test("legacy marker with no mirrors falls back to uuid as name", () => {
    const dir = join(home, "tunnel", uuid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "adopted.json"), JSON.stringify({ at: "2026-01-01" }));
    const ref = readAdopted(uuid)!;
    expect(ref.reconstructed).toBe(true);
    expect(ref.name).toBe(uuid);
  });
});
