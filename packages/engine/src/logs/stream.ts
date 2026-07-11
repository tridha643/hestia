import {
  HestiaError,
  type LogLine,
  type LogsOptions,
  type ServiceRecord,
  type StackRecord,
} from "@hestia/core";
import { composeLogLines } from "./compose.ts";
import { tailFile, type TailEvent } from "./tail.ts";

export interface LogMergeQueueItem {
  line?: LogLine;
  done?: true;
}

/** Bounded arrival-order queue whose blocked log producers wake on abort or close. */
export class BoundedLogMergeQueue {
  readonly #items: LogMergeQueueItem[] = [];
  readonly #waiters: Array<(item: LogMergeQueueItem) => void> = [];
  readonly #capacityWaiters: Array<() => void> = [];
  #closed = false;

  constructor(readonly capacity = 256) {}

  async push(item: LogMergeQueueItem, signal?: AbortSignal): Promise<boolean> {
    while (!this.#closed && !signal?.aborted && this.#items.length >= this.capacity) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.#capacityWaiters.push(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    if (this.#closed || signal?.aborted) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.#items.push(item);
    return true;
  }

  next(): Promise<LogMergeQueueItem> {
    const item = this.#items.shift();
    if (item !== undefined) {
      this.#capacityWaiters.shift()?.();
      return Promise.resolve(item);
    }
    if (this.#closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const wake of this.#capacityWaiters.splice(0)) wake();
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true });
  }
}

function metaLine(record: StackRecord, service: ServiceRecord, text: string): LogLine {
  return { project: record.project, service: service.name, source: service.backend, text, meta: true };
}

function mapTailEvent(
  record: StackRecord,
  service: ServiceRecord,
  event: TailEvent,
  follow: boolean,
): LogLine {
  switch (event.kind) {
    case "line":
      return {
        project: record.project,
        service: service.name,
        source: service.backend,
        text: event.text,
        truncated: event.truncated,
      };
    case "reset":
      return metaLine(record, service, "log reset — proc restarted");
    case "gone":
      return metaLine(record, service, "log file removed (worktree deleted?)");
    case "absent":
      return metaLine(record, service, follow ? "waiting for log file" : "log file unavailable");
  }
}

function selectLogServices(record: StackRecord, requested?: string[]): ServiceRecord[] {
  if (requested === undefined || requested.length === 0) return record.services;
  const selected: ServiceRecord[] = [];
  for (const name of requested) {
    const service = record.services.find((candidate) => candidate.name === name);
    if (service === undefined) {
      throw new HestiaError("service-not-found", `service "${name}" is not in stack "${record.project}"`);
    }
    if (!selected.includes(service)) selected.push(service);
  }
  return selected;
}

/** Merge every selected stack source by arrival order and tear all sources down on return. */
export async function* streamStackLogs(
  record: StackRecord,
  options: LogsOptions = {},
): AsyncGenerator<LogLine> {
  const services = selectLogServices(record, options.services);
  if (services.length === 0 || options.signal?.aborted) return;
  const controller = new AbortController();
  const queue = new BoundedLogMergeQueue();
  const abort = () => {
    controller.abort();
    queue.close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let active = services.length;

  const pumps = services.map(async (service) => {
    try {
      if (service.backend === "docker") {
        for await (const event of composeLogLines(record.project, service.name, {
          follow: options.follow,
          tail: options.tail,
          signal: controller.signal,
        })) {
          await queue.push({
            line:
              event.kind === "line"
                ? {
                    project: record.project,
                    service: service.name,
                    source: service.backend,
                    text: event.text,
                    truncated: event.truncated,
                  }
                : metaLine(record, service, event.text),
          }, controller.signal);
        }
      } else if (service.logPath === undefined) {
        await queue.push({ line: metaLine(record, service, "log path unavailable") }, controller.signal);
      } else {
        for await (const event of tailFile(service.logPath, {
          follow: options.follow,
          tail: options.tail,
          signal: controller.signal,
        })) {
          await queue.push(
            { line: mapTailEvent(record, service, event, options.follow ?? false) },
            controller.signal,
          );
        }
      }
    } catch (error) {
      await queue.push(
        { line: metaLine(record, service, `log source unreadable: ${(error as Error).message}`) },
        controller.signal,
      );
    } finally {
      active -= 1;
      if (active === 0) await queue.push({ done: true }, controller.signal);
    }
  });

  try {
    while (true) {
      const item = await queue.next();
      if (item.done) break;
      if (item.line !== undefined) yield item.line;
    }
  } finally {
    controller.abort();
    queue.close();
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(pumps);
  }
}
