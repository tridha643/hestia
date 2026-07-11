import type { LogLine } from "@hestia/core";

function logLineSignature(line: LogLine): string {
  return `${line.project}\0${line.service}\0${line.source}\0${line.meta === true ? "1" : "0"}\0${line.text}`;
}

/** Suppress only the reconnect backfill prefix that overlaps the visible ring tail. */
export class ReconnectLogDeduper {
  readonly #capacity: number;
  #history: Array<{ signature: string; line: LogLine }> = [];
  #reconnectBuffer: Array<{ signature: string; line: LogLine }> | null = null;

  constructor(capacity = 50) {
    this.#capacity = capacity;
  }

  beginReconnect(): void {
    this.#reconnectBuffer = [];
  }

  push(line: LogLine): LogLine[] {
    const entry = { signature: logLineSignature(line), line };
    if (this.#reconnectBuffer === null || this.#history.length === 0) {
      this.#remember([entry]);
      return [line];
    }
    this.#reconnectBuffer.push(entry);
    const buffered = this.#reconnectBuffer;
    const activeOverlapLengths: number[] = [];
    const completedOverlapLengths: number[] = [];
    for (let start = 0; start < this.#history.length; start += 1) {
      const overlapLength = this.#history.length - start;
      const compared = Math.min(buffered.length, overlapLength);
      let matches = true;
      for (let index = 0; index < compared; index += 1) {
        if (buffered[index]!.signature !== this.#history[start + index]!.signature) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      if (buffered.length <= overlapLength) activeOverlapLengths.push(overlapLength);
      if (buffered.length >= overlapLength) completedOverlapLengths.push(overlapLength);
    }
    if (activeOverlapLengths.length > 0) return [];
    const suppressed = Math.max(0, ...completedOverlapLengths);
    const fresh = buffered.slice(suppressed);
    this.#reconnectBuffer = null;
    this.#remember(fresh);
    return fresh.map((candidate) => candidate.line);
  }

  #remember(entries: Array<{ signature: string; line: LogLine }>): void {
    this.#history = [...this.#history, ...entries].slice(-this.#capacity);
  }
}
