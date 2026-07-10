import {
  HestiaError,
  type LogLine,
  type LogsOptions,
  type ServiceRecord,
  type StackRecord,
} from "@hestia/core";
import { composeLogLines } from "./compose.ts";
import { tailFile, type TailEvent } from "./tail.ts";

interface QueueItem {
  line?: LogLine;
  done?: true;
}

class LogMergeQueue {
  readonly #items: QueueItem[] = [];
  readonly #waiters: Array<(item: QueueItem) => void> = [];

  push(item: QueueItem): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(item);
    else this.#items.push(item);
  }

  next(): Promise<QueueItem> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#waiters.push(resolve));
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
      return { project: record.project, service: service.name, source: service.backend, text: event.text };
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
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const queue = new LogMergeQueue();
  let active = services.length;

  const pumps = services.map(async (service) => {
    try {
      if (service.backend === "docker") {
        for await (const event of composeLogLines(record.project, service.name, {
          follow: options.follow,
          tail: options.tail,
          signal: controller.signal,
        })) {
          queue.push({
            line:
              event.kind === "line"
                ? { project: record.project, service: service.name, source: service.backend, text: event.text }
                : metaLine(record, service, event.text),
          });
        }
      } else if (service.logPath === undefined) {
        queue.push({ line: metaLine(record, service, "log path unavailable") });
      } else {
        for await (const event of tailFile(service.logPath, {
          follow: options.follow,
          tail: options.tail,
          signal: controller.signal,
        })) {
          queue.push({ line: mapTailEvent(record, service, event, options.follow ?? false) });
        }
      }
    } catch (error) {
      queue.push({ line: metaLine(record, service, `log source unreadable: ${(error as Error).message}`) });
    } finally {
      active -= 1;
      if (active === 0) queue.push({ done: true });
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
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(pumps);
  }
}
