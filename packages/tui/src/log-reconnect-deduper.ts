import type { LogLine } from "@hestia/core";

function logLineSignature(line: LogLine): string {
  return `${line.project}\0${line.service}\0${line.source}\0${line.meta === true ? "1" : "0"}\0${line.text}`;
}

/** Suppress only the reconnect backfill prefix that overlaps the visible ring tail. */
export class ReconnectLogDeduper {
  readonly #capacity: number;
  #history: Array<{ signature: string; line: LogLine }> = [];
  #reconnectBuffer: Array<{ signature: string; line: LogLine }> | null = null;
  #reconnectCandidates: number[] | null = null;
  #completedOverlap = 0;

  constructor(capacity = 50) {
    this.#capacity = capacity;
  }

  beginReconnect(): void {
    this.#reconnectBuffer = [];
    this.#reconnectCandidates = null;
    this.#completedOverlap = 0;
  }

  push(line: LogLine): LogLine[] {
    const entry = { signature: logLineSignature(line), line };
    if (this.#reconnectBuffer === null || this.#history.length === 0) {
      this.#remember([entry]);
      return [line];
    }
    this.#reconnectBuffer.push(entry);
    const buffered = this.#reconnectBuffer;
    const index = buffered.length - 1;
    const candidates = this.#reconnectCandidates ?? this.#history
      .map((_candidate, start) => start)
      .filter((start) => this.#history[start]!.signature === entry.signature);
    const active = candidates.filter((start) => {
      const historyIndex = start + index;
      if (historyIndex >= this.#history.length) return false;
      if (this.#history[historyIndex]!.signature !== entry.signature) return false;
      if (historyIndex === this.#history.length - 1) {
        this.#completedOverlap = Math.max(this.#completedOverlap, this.#history.length - start);
      }
      return true;
    });
    this.#reconnectCandidates = active;
    if (active.length > 0) return [];
    const fresh = buffered.slice(this.#completedOverlap);
    this.#reconnectBuffer = null;
    this.#reconnectCandidates = null;
    this.#completedOverlap = 0;
    this.#remember(fresh);
    return fresh.map((candidate) => candidate.line);
  }

  #remember(entries: Array<{ signature: string; line: LogLine }>): void {
    this.#history = [...this.#history, ...entries].slice(-this.#capacity);
  }
}
