import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { LABELS, type StackIdentity, type StackRecord } from "@hestia/core";
import { hestiaHome, mirrorProcsDir } from "../state.ts";
import { isLive, listPidfiles } from "../proc/pidfile.ts";
import { writeAtomicJsonFile } from "../atomic-json-file.ts";

/**
 * Admission slots for the machine-wide stack cap. Truth is DERIVED, never
 * owned: occupancy is recomputed from the stack mirrors (live services,
 * provisional starting-records) plus small reservation files that bridge the
 * moment between a grant and the granted CLI's first state write. A daemon
 * crash therefore never corrupts accounting — a restart re-derives everything.
 */

export const DEFAULT_MAX_STACKS = 5;
/** Backstop only — the provisional record takes over within seconds of a grant. */
const RESERVATION_TTL_MS = 60_000;
const DOCKER_PROBE_TIMEOUT_MS = 5_000;

export function daemonDir(): string {
  return join(hestiaHome(), "daemon");
}

function reservationsDir(): string {
  return join(daemonDir(), "reservations");
}

/** Persisted grant bridging daemon admission to the first stack mirror write. */
export interface StackReservation {
  project: string;
  identity?: StackIdentity;
  /** Holder identity — a dead holder frees the reservation before the TTL. */
  pid: number;
  startTime: string;
  at: number;
}

/**
 * Strictly parse the cap. Invalid values (non-integer, zero, negative) fall
 * back to the default WITH a warning — a deny-all daemon caused by a typo'd
 * env var is indistinguishable from a bug.
 */
export function resolveMaxStacks(): { maxStacks: number; warnings: string[] } {
  const warnings: string[] = [];
  const fromEnv = process.env.HESTIA_MAX_STACKS;
  if (fromEnv !== undefined) {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n > 0) return { maxStacks: n, warnings };
    warnings.push(
      `invalid HESTIA_MAX_STACKS=${JSON.stringify(fromEnv)} — using default ${DEFAULT_MAX_STACKS}`,
    );
    return { maxStacks: DEFAULT_MAX_STACKS, warnings };
  }
  const configPath = join(hestiaHome(), "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        maxStacks?: unknown;
      };
      if (cfg.maxStacks !== undefined) {
        if (Number.isInteger(cfg.maxStacks) && (cfg.maxStacks as number) > 0) {
          return { maxStacks: cfg.maxStacks as number, warnings };
        }
        warnings.push(
          `invalid maxStacks in ${configPath} — using default ${DEFAULT_MAX_STACKS}`,
        );
      }
    } catch {
      warnings.push(`unreadable ${configPath} — using default ${DEFAULT_MAX_STACKS}`);
    }
  }
  return { maxStacks: DEFAULT_MAX_STACKS, warnings };
}

/**
 * "live" | "dead" from a clean docker answer; null when docker itself erred
 * or timed out — the caller must treat null as unknown, never as dead
 * (a restarting Docker Desktop must not free slots).
 */
export type DockerProbe = (project: string) => Promise<"live" | "dead" | null>;

export const dockerProbe: DockerProbe = (project) =>
  new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "-q", "--filter", `label=${LABELS.stack}=${project}`],
      { timeout: DOCKER_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout.trim() === "" ? "dead" : "live");
      },
    );
  });

export interface Occupancy {
  /** Projects occupying a slot: live services or a starting-record with a live holder. */
  live: string[];
  /** Reservation files not yet backed by any mirror record. */
  reserved: string[];
  warnings: string[];
}

export class SlotLedger {
  /** Sticky last-known docker liveness per project — survives probe errors. */
  #lastDockerLive = new Map<string, boolean>();

  constructor(private readonly probe: DockerProbe = dockerProbe) {}

  /** Record the acquiring CLI's identity so its crash frees the reservation early. */
  reserveFor(
    identity: StackIdentity | string,
    holder: { pid: number; startTime: string },
  ): void {
    const project = typeof identity === "string" ? identity : identity.project;
    const reservation: StackReservation = {
      project,
      identity: typeof identity === "string" ? undefined : identity,
      ...holder,
      at: Date.now(),
    };
    mkdirSync(reservationsDir(), { recursive: true, mode: 0o700 });
    chmodSync(reservationsDir(), 0o700);
    writeAtomicJsonFile(join(reservationsDir(), project), reservation, { pretty: false });
  }

  release(project: string): void {
    rmSync(join(reservationsDir(), project), { force: true });
  }

  /** Read current reservation identities without probing Docker or taking admission locks. */
  reservationSnapshot(): StackReservation[] {
    const dir = reservationsDir();
    if (!existsSync(dir)) return [];
    const out: StackReservation[] = [];
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".tmp")) {
        rmSync(join(dir, f), { force: true });
        continue;
      }
      try {
        const reservation = JSON.parse(readFileSync(join(dir, f), "utf8")) as StackReservation;
        if (reservation.project !== f) throw new Error("reservation filename mismatch");
        out.push(reservation);
      } catch {
        rmSync(join(dir, f), { force: true });
      }
    }
    return out.sort((left, right) => left.at - right.at || left.project.localeCompare(right.project));
  }

  /**
   * Drop reservations that are no longer bridging anything: the project has a
   * mirror record now (the record carries occupancy from here), the holder
   * died, or the TTL backstop expired.
   */
  expireStale(hasRecord: (project: string) => boolean): void {
    for (const r of this.reservationSnapshot()) {
      const holderDead = r.startTime !== "" && !isLive({ pid: r.pid, startTime: r.startTime });
      const expired = Date.now() - r.at > RESERVATION_TTL_MS;
      if (hasRecord(r.project) || holderDead || expired) this.release(r.project);
    }
  }

  /**
   * One project's slot occupancy from its mirror. Quick-tunnel procs never
   * count — they outlive their origins and hold no real dev-stack resources.
   */
  async projectOccupies(project: string, record: StackRecord): Promise<boolean> {
    // Live services first — a partially-started stack (crashed mid-`up`, still
    // marked "starting") with running workers holds real resources regardless
    // of its starter's fate.
    const procLive = listPidfiles(mirrorProcsDir(project)).some(
      (pf) => pf.backend !== "tunnel" && isLive(pf),
    );
    if (procLive) return true;
    // Provisional grant: occupies while the CLI holding it is alive. A dead
    // starter still falls through to the docker probe — containers may have
    // come up before the crash.
    if (
      record.state === "starting" &&
      record.starter !== undefined &&
      isLive(record.starter)
    ) {
      return true;
    }
    if (!record.services.some((s) => s.backend === "docker")) return false;
    const probed = await this.probe(project);
    if (probed === null) {
      // Docker erred/timed out — sticky: keep the last clean answer, default
      // to LIVE for never-probed projects (holding a slot too long is safe;
      // freeing one that's actually running is a cap breach).
      return this.#lastDockerLive.get(project) ?? true;
    }
    const live = probed === "live";
    this.#lastDockerLive.set(project, live);
    return live;
  }

  async occupancy(): Promise<Occupancy> {
    const warnings: string[] = [];
    const live: string[] = [];
    const stacksDir = join(hestiaHome(), "stacks");
    const recorded = new Set<string>();
    if (existsSync(stacksDir)) {
      for (const project of readdirSync(stacksDir)) {
        const p = join(stacksDir, project, "stack.json");
        if (!existsSync(p)) continue;
        let record: StackRecord;
        try {
          record = JSON.parse(readFileSync(p, "utf8")) as StackRecord;
        } catch {
          warnings.push(`unreadable mirror for ${project}`);
          continue;
        }
        recorded.add(project);
        if (await this.projectOccupies(project, record)) live.push(project);
      }
    }
    this.expireStale((project) => recorded.has(project));
    const reserved = this.reservationSnapshot()
      .map((r) => r.project)
      .filter((p) => !live.includes(p));
    return { live, reserved, warnings };
  }
}
