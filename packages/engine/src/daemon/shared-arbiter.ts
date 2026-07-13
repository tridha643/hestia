import {
  HestiaError,
  type StackRecord,
  type SharedClaimResult,
  type SharedHostnameRecord,
} from "@hestia/core";
import { probeProcessIdentity, scanPidfiles } from "../proc/pidfile.ts";
import { mirrorProcsDir, readMirrorStateSafe } from "../state.ts";
import {
  probeSharedHolderOrigin,
  resolveSharedContractOrigin,
  type OriginLiveness,
} from "../router/origin-liveness.ts";
import {
  listSharedHostnames,
  readSharedHostname,
  updateSharedHostname,
} from "../tunnel/shared.ts";

/** Consecutive dead-origin observations required before a shared holder is released. */
export const ORIGIN_DEAD_RELEASE_STRIKES = 3;

/** Machine-observed cause for an automatic shared-hostname release. */
export type SharedSweepReleaseReason = "stack-gone" | "stack-dead" | "origin-dead";

/** Automatic shared-hostname release reported to daemon duties. */
export interface SharedSweepRelease {
  name: string;
  project: string;
  reason: SharedSweepReleaseReason;
}

/** Injectable shared-hostname arbiter effects for daemon wiring and deterministic tests. */
export interface SharedArbiterOptions {
  onChange?: () => void | Promise<void>;
  probeHolderOrigin?: (mirror: StackRecord, contractService: string) => Promise<OriginLiveness>;
}

function probeMirrorProcessOccupancy(mirror: StackRecord): OriginLiveness {
  const identities: Array<{ pid: number; startTime: string }> = [];
  let malformed = false;
  for (const service of [...mirror.services, ...(mirror.auxiliary ?? [])].filter(
    (candidate) => candidate.backend === "proc" || candidate.backend === "wrangler",
  )) {
    if (service.pid === undefined && service.startTime === undefined) continue;
    if (!Number.isSafeInteger(service.pid) || service.pid! <= 0 || typeof service.startTime !== "string") {
      malformed = true;
      continue;
    }
    identities.push({ pid: service.pid!, startTime: service.startTime });
  }
  const pidfileScan = scanPidfiles(mirrorProcsDir(mirror.project));
  malformed ||= pidfileScan.errors.length > 0;
  identities.push(...pidfileScan.pidfiles
    .filter((pidfile) => pidfile.backend !== "tunnel")
    .map((pidfile) => ({ pid: pidfile.pid, startTime: pidfile.startTime })));
  let unknown = false;
  for (const identityRecord of identities) {
    const identity = probeProcessIdentity(identityRecord);
    if (identity === "live") return "live";
    if (identity === "unknown") unknown = true;
  }
  if (unknown) return "unknown";
  if (malformed) throw new Error("Shared holder mirror has an invalid process identity");
  return "dead";
}

/**
 * Consent-based arbitration for shared hostnames. ALL authority lives in the
 * durable records (holder + FIFO queue in ~/.hestia/shared/<name>.json, one
 * atomic write per transition) — this class only serializes transitions and
 * holds the long-poll resolvers that wake a blocked `hestia claim --wait`.
 * A daemon restart therefore loses nothing but the open connections: queue
 * positions survive, and returning CLIs re-attach to their existing entry.
 *
 * Protocol (user-specified): a claim against a held name joins the queue;
 * the HOLDER arbitrates with allow (grant head) or deny (head stays queued);
 * release / down / stack death grants the head. Deny is "not now", never a
 * rejection — only grant, explicit cancel, or a dead stack dequeues.
 */
export class SharedArbiter {
  #mutex: Promise<unknown> = Promise.resolve();
  /** name\0project → resolvers for CLIs long-polling that grant. */
  #polls = new Map<string, Array<{ resolve(result: SharedClaimResult): void; timer: ReturnType<typeof setTimeout> }>>();
  #deadOriginStrikes = new Map<string, { holderKey: string; strikes: number }>();
  readonly #onChange?: () => void | Promise<void>;
  readonly #probeHolderOrigin: SharedArbiterOptions["probeHolderOrigin"];

  constructor(onChangeOrOptions?: (() => void | Promise<void>) | SharedArbiterOptions) {
    const options = typeof onChangeOrOptions === "function"
      ? { onChange: onChangeOrOptions }
      : onChangeOrOptions;
    this.#onChange = options?.onChange;
    this.#probeHolderOrigin = options?.probeHolderOrigin ?? probeSharedHolderOrigin;
  }

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    this.#mutex = next.catch(() => {});
    return next;
  }

  async #notify(): Promise<void> {
    try {
      await this.#onChange?.();
    } catch {
      // The 1s route refresh is the safety net; a failed push is not fatal.
    }
  }

  #result(record: SharedHostnameRecord, granted: boolean): SharedClaimResult {
    return { granted, holder: record.holder, queued: [...(record.queue ?? [])] };
  }

  #wake(name: string, project: string, result: SharedClaimResult): void {
    const key = `${name}\0${project}`;
    for (const poll of this.#polls.get(key) ?? []) {
      clearTimeout(poll.timer);
      poll.resolve(result);
    }
    this.#polls.delete(key);
  }

  /**
   * Grant the queue head, skipping waiters whose stack mirror has vanished
   * (downed while waiting). Clears the holder when the queue drains empty.
   */
  #grantNext(record: SharedHostnameRecord): SharedHostnameRecord {
    const queue = [...(record.queue ?? [])];
    for (;;) {
      const head = queue.shift();
      if (head === undefined) {
        const next = { ...record, queue: [] };
        delete next.holder;
        return next;
      }
      const mirror = readMirrorStateSafe(head.project);
      // A corrupt mirror is preserved for repair; only a cleanly absent mirror
      // proves the waiter is dead. A granted-but-not-exposed claimant is valid.
      if (mirror.status === "ok" && mirror.record === null) continue;
      return {
        ...record,
        holder: {
          project: head.project,
          worktree: head.worktree,
          service: record.service,
          at: new Date().toISOString(),
        },
        queue,
      };
    }
  }

  /** Claim request. Grants immediately when unclaimed or already the holder. */
  async request(
    name: string,
    requester: { project: string; worktree: string },
    waitMs: number,
  ): Promise<SharedClaimResult> {
    const outcome = await this.#locked(async () => {
      let granted = false;
      const updated = await updateSharedHostname(name, (record) => {
        if (record.holder?.project === requester.project) {
          granted = true;
          return {
            ...record,
            holder: { ...record.holder, worktree: requester.worktree },
            queue: (record.queue ?? []).filter((waiter) => waiter.project !== requester.project),
          };
        }
        if (record.holder === undefined) {
          granted = true;
          return {
            ...record,
            holder: {
              project: requester.project,
              worktree: requester.worktree,
              service: record.service,
              at: new Date().toISOString(),
            },
            queue: (record.queue ?? []).filter((waiter) => waiter.project !== requester.project),
          };
        }
        const queue = [...(record.queue ?? [])];
        const existing = queue.find((waiter) => waiter.project === requester.project);
        if (existing !== undefined) existing.worktree = requester.worktree; // re-attach, keep position
        else queue.push({ project: requester.project, worktree: requester.worktree, at: new Date().toISOString() });
        return { ...record, queue };
      });
      if (updated === null) {
        throw new HestiaError("shared-not-found", `no shared hostname "${name}" is declared`);
      }
      return { granted, record: updated };
    });
    if (outcome.granted) {
      await this.#notify();
      return this.#result(outcome.record, true);
    }
    if (waitMs <= 0) return this.#result(outcome.record, false);
    // Durable position + volatile long-poll: expiry answers the CLI but the
    // queue entry REMAINS — re-running `hestia claim` re-attaches to it.
    return new Promise<SharedClaimResult>((resolve) => {
      const key = `${name}\0${requester.project}`;
      const polls = this.#polls.get(key) ?? [];
      const poll = {
        resolve,
        timer: setTimeout(() => {
          const remaining = (this.#polls.get(key) ?? []).filter((candidate) => candidate !== poll);
          if (remaining.length === 0) this.#polls.delete(key);
          else this.#polls.set(key, remaining);
          const record = readSharedHostname(name);
          resolve(record === null
            ? { granted: false, queued: [] }
            : this.#result(record, record.holder?.project === requester.project));
        }, waitMs),
      };
      polls.push(poll);
      this.#polls.set(key, polls);
    });
  }

  /** Drop the requester's durable queue entry (never touches the holder). */
  async cancel(name: string, project: string): Promise<SharedClaimResult> {
    const record = await this.#locked(() =>
      updateSharedHostname(name, (current) => ({
        ...current,
        queue: (current.queue ?? []).filter((waiter) => waiter.project !== project),
      })),
    );
    if (record === null) throw new HestiaError("shared-not-found", `no shared hostname "${name}" is declared`);
    this.#wake(name, project, this.#result(record, false));
    return this.#result(record, false);
  }

  #assertHolder(record: SharedHostnameRecord, project: string, verb: string): void {
    if (record.holder?.project !== project) {
      throw new HestiaError(
        "shared-not-holder",
        record.holder === undefined
          ? `cannot ${verb} "${record.name}" — it is unclaimed`
          : `cannot ${verb} "${record.name}" — it is held by ${record.holder.project}, not ${project}`,
      );
    }
  }

  /** Holder consents: hand the hostname to the queue head (empty queue = release). */
  async allow(name: string, callerProject: string): Promise<SharedClaimResult> {
    const record = await this.#transfer(name, callerProject, "allow");
    return this.#result(record, false);
  }

  /** Holder declines the head request; the waiter stays durably queued. */
  async deny(name: string, callerProject: string): Promise<SharedClaimResult> {
    const record = await this.#locked(async () => {
      const current = readSharedHostname(name);
      if (current === null) throw new HestiaError("shared-not-found", `no shared hostname "${name}" is declared`);
      this.#assertHolder(current, callerProject, "deny");
      const updated = await updateSharedHostname(name, (candidate) => {
        const queue = [...(candidate.queue ?? [])];
        if (queue.length > 0) queue[0] = { ...queue[0]!, denied: true };
        return { ...candidate, queue };
      });
      return updated!;
    });
    return this.#result(record, false);
  }

  /** Holder (or a force-path caller) releases; the queue head is granted. */
  async release(name: string, callerProject: string): Promise<SharedClaimResult> {
    const record = await this.#transfer(name, callerProject, "release");
    return this.#result(record, false);
  }

  async #transfer(name: string, callerProject: string, verb: string): Promise<SharedHostnameRecord> {
    const record = await this.#locked(async () => {
      const current = readSharedHostname(name);
      if (current === null) throw new HestiaError("shared-not-found", `no shared hostname "${name}" is declared`);
      this.#assertHolder(current, callerProject, verb);
      return (await updateSharedHostname(name, (candidate) => this.#grantNext(candidate)))!;
    });
    if (record.holder !== undefined) {
      this.#wake(record.name, record.holder.project, this.#result(record, true));
    }
    await this.#notify();
    return record;
  }

  /**
   * Auto-release every shared hostname this project holds (down/stop hooks,
   * dead-stack sweep). `service` limits release to names whose contract alias
   * matches — `hestia stop web` must not release a hostname served by `api`.
   */
  async releaseProject(project: string, service?: string): Promise<void> {
    const held = listSharedHostnames().filter((record) =>
      record.holder?.project === project &&
      (service === undefined || record.service === service));
    let changed = false;
    for (const record of held) {
      const updated = await this.#locked(async () => {
        const current = readSharedHostname(record.name);
        if (current?.holder?.project !== project) return null;
        return await updateSharedHostname(record.name, (candidate) => this.#grantNext(candidate));
      });
      if (updated === null || updated === undefined) continue;
      changed = true;
      if (updated.holder !== undefined) {
        this.#wake(updated.name, updated.holder.project, this.#result(updated, true));
      }
    }
    if (changed) await this.#notify();
  }

  /**
   * Sweep duty: debounce-release holders whose stack or exposed origin died,
   * immediately release cleanly removed stacks, and prune mirrorless waiters.
   * `occupied` = the admission view's live ∪ reserved projects.
   */
  async sweep(occupied: ReadonlySet<string>): Promise<SharedSweepRelease[]> {
    let changed = false;
    const releases: SharedSweepRelease[] = [];
    for (const record of listSharedHostnames()) {
      const holder = record.holder;
      const holderMirror = holder === undefined ? undefined : readMirrorStateSafe(holder.project);
      const deadWaiterProjects = new Set((record.queue ?? []).flatMap((waiter) => {
        const mirror = readMirrorStateSafe(waiter.project);
        return mirror.status === "ok" && mirror.record === null ? [waiter.project] : [];
      }));
      const deadWaiters = (record.queue ?? []).filter(
        (waiter) => deadWaiterProjects.has(waiter.project),
      );
      let releaseReason: SharedSweepReleaseReason | undefined;
      if (holder !== undefined && holderMirror !== undefined) {
        const holderKey = `${holder.project}\0${holder.at}`;
        const holderOccupied = occupied.has(holder.project);
        if (holderMirror.status === "error") {
          // Deliberate recovery policy: a persistently corrupt holder mirror
          // cannot resolve or verify its contract origin, so three sweeps
          // release it. Transient Docker/lsof probe failures remain unknown.
          if (this.#recordDeadStrike(record.name, holderKey)) releaseReason = "stack-dead";
        } else {
          try {
            const mirror = holderMirror.record;
            if (mirror === null) {
              if (!holderOccupied) releaseReason = "stack-gone";
              else this.#deadOriginStrikes.delete(record.name);
            } else {
              const protectedState = mirror.state === "starting" || mirror.state === "queued";
              if (!protectedState && mirror.starter !== undefined && (
                typeof mirror.starter !== "object" || mirror.starter === null ||
                !Number.isSafeInteger(mirror.starter.pid) || mirror.starter.pid <= 0 ||
                typeof mirror.starter.startTime !== "string"
              )) {
                throw new Error("Shared holder mirror has an invalid starter identity");
              }
              const starterLiveness = protectedState || mirror.starter === undefined
                ? "dead"
                : probeProcessIdentity(mirror.starter);
              const protectedStartup = protectedState || starterLiveness === "live";
              if (protectedStartup) {
                this.#deadOriginStrikes.delete(record.name);
              } else if (starterLiveness === "unknown") {
                this.#retainStrikeForHolder(record.name, holderKey);
              } else if (!holderOccupied) {
                const contractOrigin = resolveSharedContractOrigin(mirror, holder.service);
                if (contractOrigin === undefined) {
                  const processOccupancy = probeMirrorProcessOccupancy(mirror);
                  if (processOccupancy === "live") {
                    this.#deadOriginStrikes.delete(record.name);
                  } else if (processOccupancy === "unknown") {
                    this.#retainStrikeForHolder(record.name, holderKey);
                  } else if (this.#recordDeadStrike(record.name, holderKey)) {
                    releaseReason = "stack-dead";
                  }
                } else {
                  const origin = await this.#probeHolderOrigin!(mirror, holder.service);
                  if (origin === "live") {
                    this.#deadOriginStrikes.delete(record.name);
                  } else if (origin === "dead") {
                    if (this.#recordDeadStrike(record.name, holderKey)) releaseReason = "stack-dead";
                  } else {
                    this.#retainStrikeForHolder(record.name, holderKey);
                  }
                }
              } else {
                const origin = await this.#probeHolderOrigin!(mirror, holder.service);
                if (origin === "live") {
                  this.#deadOriginStrikes.delete(record.name);
                } else if (origin === "dead") {
                  if (this.#recordDeadStrike(record.name, holderKey)) releaseReason = "origin-dead";
                } else {
                  this.#retainStrikeForHolder(record.name, holderKey);
                }
              }
            }
          } catch {
            // parseStackRecord is intentionally shallow for compatibility;
            // malformed nested starter/service/endpoint fields are contained
            // per holder and follow the corrupt-mirror debounce policy.
            if (this.#recordDeadStrike(record.name, holderKey)) releaseReason = "stack-dead";
          }
        }
      } else {
        this.#deadOriginStrikes.delete(record.name);
      }
      if (releaseReason === undefined && deadWaiters.length === 0) continue;
      let released = false;
      const updated = await this.#locked(() =>
        updateSharedHostname(record.name, (candidate) => {
          const pruned: SharedHostnameRecord = {
            ...candidate,
            queue: (candidate.queue ?? []).filter(
              (waiter) => {
                if (!deadWaiterProjects.has(waiter.project)) return true;
                const freshMirror = readMirrorStateSafe(waiter.project);
                return freshMirror.status === "error" || freshMirror.record !== null;
              },
            ),
          };
          const holderMatches = releaseReason !== undefined &&
            pruned.holder?.project === holder?.project &&
            pruned.holder?.at === holder?.at;
          if (!holderMatches) return pruned;
          released = true;
          return this.#grantNext(pruned);
        }),
      );
      if (updated === null) continue;
      changed ||= released || deadWaiters.length > 0;
      if (released && holder !== undefined && releaseReason !== undefined) {
        releases.push({ name: record.name, project: holder.project, reason: releaseReason });
        this.#deadOriginStrikes.delete(record.name);
      }
      if (updated.holder !== undefined && updated.holder.project !== record.holder?.project) {
        this.#wake(updated.name, updated.holder.project, this.#result(updated, true));
      }
    }
    if (changed) await this.#notify();
    return releases;
  }

  #recordDeadStrike(name: string, holderKey: string): boolean {
    const previous = this.#deadOriginStrikes.get(name);
    const strikes = previous?.holderKey === holderKey ? previous.strikes + 1 : 1;
    this.#deadOriginStrikes.set(name, { holderKey, strikes });
    return strikes >= ORIGIN_DEAD_RELEASE_STRIKES;
  }

  #retainStrikeForHolder(name: string, holderKey: string): void {
    const previous = this.#deadOriginStrikes.get(name);
    if (previous?.holderKey !== holderKey) {
      this.#deadOriginStrikes.set(name, { holderKey, strikes: 0 });
    }
  }
}
