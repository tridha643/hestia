import {
  HestiaError,
  type SharedClaimResult,
  type SharedClaimWaiter,
  type SharedHostnameRecord,
} from "@hestia/core";
import { readMirrorState } from "../state.ts";
import {
  listSharedHostnames,
  readSharedHostname,
  updateSharedHostname,
} from "../tunnel/shared.ts";

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

  constructor(private readonly onChange?: () => void | Promise<void>) {}

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    this.#mutex = next.catch(() => {});
    return next;
  }

  async #notify(): Promise<void> {
    try {
      await this.onChange?.();
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
      if (readMirrorState(head.project) === null) continue; // dead waiter — drop
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
   * Sweep duty: release holders whose stack is no longer occupying a slot
   * (crashed without a down) and prune queue entries with no mirror left.
   * `occupied` = the admission view's live ∪ reserved projects.
   */
  async sweep(occupied: ReadonlySet<string>): Promise<void> {
    let changed = false;
    for (const record of listSharedHostnames()) {
      const holderDead = record.holder !== undefined &&
        !occupied.has(record.holder.project) &&
        readMirrorState(record.holder.project) === null;
      const deadWaiters = (record.queue ?? []).filter(
        (waiter) => readMirrorState(waiter.project) === null,
      );
      if (!holderDead && deadWaiters.length === 0) continue;
      const updated = await this.#locked(() =>
        updateSharedHostname(record.name, (candidate) => {
          const pruned: SharedHostnameRecord = {
            ...candidate,
            queue: (candidate.queue ?? []).filter(
              (waiter) => readMirrorState(waiter.project) !== null,
            ),
          };
          const currentHolderDead = pruned.holder !== undefined &&
            !occupied.has(pruned.holder.project) &&
            readMirrorState(pruned.holder.project) === null;
          return currentHolderDead ? this.#grantNext(pruned) : pruned;
        }),
      );
      if (updated === null) continue;
      changed = true;
      if (updated.holder !== undefined && updated.holder.project !== record.holder?.project) {
        this.#wake(updated.name, updated.holder.project, this.#result(updated, true));
      }
    }
    if (changed) await this.#notify();
  }
}
