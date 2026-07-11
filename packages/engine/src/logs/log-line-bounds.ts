export const MAX_LOG_LINE_BYTES = 64 * 1024;
export const LOG_LINE_TRUNCATION_MARKER = "… [hestia: line truncated]";

export interface BoundedLogText {
  text: string;
  truncated?: true;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const source = Buffer.from(text);
  if (source.byteLength <= maxBytes) return text;
  let bounded = source.subarray(0, maxBytes).toString("utf8");
  if (bounded.endsWith("�")) bounded = bounded.slice(0, -1);
  return bounded;
}

/** Bound one complete application log line to the daemon-safe byte ceiling. */
export function boundLogLine(text: string): BoundedLogText {
  if (Buffer.byteLength(text) <= MAX_LOG_LINE_BYTES) return { text };
  const payloadBytes = MAX_LOG_LINE_BYTES - Buffer.byteLength(LOG_LINE_TRUNCATION_MARKER);
  return {
    text: utf8Prefix(text, payloadBytes) + LOG_LINE_TRUNCATION_MARKER,
    truncated: true,
  };
}

/** Incrementally split log chunks without retaining an unbounded unterminated line. */
export class BoundedLogLineAccumulator {
  #pending = "";
  #truncated = false;

  push(chunk: string): BoundedLogText[] {
    const parts = chunk.split("\n");
    const complete: BoundedLogText[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      this.#append(parts[index]!);
      if (index < parts.length - 1) complete.push(this.#finish());
    }
    return complete;
  }

  flush(): BoundedLogText | null {
    if (this.#pending === "" && !this.#truncated) return null;
    return this.#finish();
  }

  /** Restore an unterminated backfill line before following appended bytes. */
  seed(line: BoundedLogText): void {
    this.#pending = line.truncated
      ? line.text.slice(0, -LOG_LINE_TRUNCATION_MARKER.length)
      : line.text;
    this.#truncated = line.truncated === true;
  }

  reset(): void {
    this.#pending = "";
    this.#truncated = false;
  }

  #append(text: string): void {
    if (this.#truncated) return;
    const combined = this.#pending + text;
    if (Buffer.byteLength(combined) <= MAX_LOG_LINE_BYTES) {
      this.#pending = combined;
      return;
    }
    const payloadBytes = MAX_LOG_LINE_BYTES - Buffer.byteLength(LOG_LINE_TRUNCATION_MARKER);
    this.#pending = utf8Prefix(combined, payloadBytes);
    this.#truncated = true;
  }

  #finish(): BoundedLogText {
    const result: BoundedLogText = this.#truncated
      ? { text: this.#pending + LOG_LINE_TRUNCATION_MARKER, truncated: true }
      : { text: this.#pending };
    this.reset();
    return result;
  }
}
