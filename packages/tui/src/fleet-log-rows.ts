import type { LogLine } from "@hestia/core";
import { wrapFleetText } from "./fleet-text.ts";

export interface FleetLogRow {
  key: string;
  text: string;
  meta: boolean;
  /** Attribution tag for hestia-synthesized lines; continuation rows get padding. */
  tag?: string;
}

const META_TAG = "hestia │ ";

// Ring eviction shifts array indices every append; identity-keyed ids keep
// React row keys stable and let wrapped rows be cached per line object.
let nextLineId = 0;
const lineIds = new WeakMap<LogLine, number>();
const wrapCache = new WeakMap<LogLine, { width: number; wrapped: string[] }>();

function lineId(line: LogLine): number {
  let id = lineIds.get(line);
  if (id === undefined) {
    id = nextLineId++;
    lineIds.set(line, id);
  }
  return id;
}

function wrappedBody(line: LogLine, bodyWidth: number): string[] {
  const cached = wrapCache.get(line);
  if (cached !== undefined && cached.width === bodyWidth) return cached.wrapped;
  const wrapped = wrapFleetText(line.text, bodyWidth, 3);
  wrapCache.set(line, { width: bodyWidth, wrapped });
  return wrapped;
}

/**
 * Flatten the log ring into display rows (wrapped to the pane width) so the
 * host can clamp scroll offsets in the same units the pane renders. Wrapping
 * is cached per line object, so an append only wraps the new lines.
 */
export function buildFleetLogRows(lines: LogLine[], contentWidth: number): FleetLogRow[] {
  const rows: FleetLogRow[] = [];
  for (const line of lines) {
    const meta = line.meta === true;
    const bodyWidth = meta ? Math.max(1, contentWidth - META_TAG.length) : contentWidth;
    const wrapped = wrappedBody(line, bodyWidth);
    const id = lineId(line);
    for (let part = 0; part < wrapped.length; part += 1) {
      rows.push({
        key: `${id}:${part}`,
        text: wrapped[part]!,
        meta,
        tag: !meta ? undefined : part === 0 ? META_TAG : " ".repeat(META_TAG.length),
      });
    }
  }
  return rows;
}
