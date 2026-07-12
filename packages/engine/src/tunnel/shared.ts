import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  HestiaError,
  STATE_SCHEMA_VERSION,
  type SharedClaimWaiter,
  type SharedHolder,
  type SharedHostnameRecord,
} from "@hestia/core";
import { hestiaHome } from "../state.ts";
import { withLock } from "../proc/lock.ts";
import { writeAtomicJsonFile } from "../atomic-json-file.ts";

/**
 * The machine-owned shared-hostname store: one JSON file per stable public
 * hostname under ~/.hestia/shared/. Unlike TunnelExposure hostnames these
 * outlive every stack — the cloudflared rule is static and holder switches
 * are hestiad route-table updates, so the files are the only durable truth.
 *
 * Lock discipline: every mutation serializes on the shared root's own lock
 * (`withSharedLock`), and that lock NEVER nests inside the worktree or global
 * tunnel locks — callers mutate shared state before or after those sections.
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Path prefix chars: pchar-ish, no query/fragment, no whitespace. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/;

export function sharedRoot(): string {
  return join(hestiaHome(), "shared");
}

function sharedPath(name: string): string {
  return join(sharedRoot(), `${name}.json`);
}

export function assertSharedName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new HestiaError(
      "usage",
      `shared hostname handle ${JSON.stringify(name)} must be a DNS label: ` +
        `lowercase alphanumerics and hyphens, at most 63 characters`,
    );
  }
}

/**
 * A shared hostname may be ANY FQDN the user controls (not derived from the
 * handle). Validate it as a lowercased multi-label DNS name so a typo can't
 * mint an ingress rule that shadows a real one.
 */
export function assertSharedHostnameFqdn(hostname: string): void {
  const labels = hostname.split(".");
  const valid =
    hostname.length <= 253 &&
    hostname === hostname.toLowerCase() &&
    labels.length >= 2 &&
    labels.every((label) => LABEL_RE.test(label));
  if (!valid) {
    throw new HestiaError(
      "usage",
      `shared hostname ${JSON.stringify(hostname)} must be a fully-qualified ` +
        `lowercase domain (e.g. slack.acme.com)`,
    );
  }
}

/**
 * Normalize a path prefix to `/seg[/seg…]` (leading slash, no trailing slash)
 * or `undefined` for the whole-hostname route. Rejects query/fragment,
 * whitespace, and `..` traversal. `/` and `""` normalize to `undefined`.
 */
export function normalizeSharedPath(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  // Empty segments (leading/trailing/repeated slashes) collapse like any router;
  // only genuine junk — traversal, query, fragment, whitespace — is rejected.
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !PATH_SEGMENT_RE.test(segment)) {
      throw new HestiaError(
        "usage",
        `shared hostname path ${JSON.stringify(input)} must be a URL path prefix ` +
          `like /webhooks/slack (no query, fragment, or ".." segments)`,
      );
    }
  }
  if (segments.length === 0) return undefined;
  return `/${segments.join("/")}`;
}

/**
 * Longest-prefix path match at segment boundaries: `/slack` matches `/slack`
 * and `/slack/events` but never `/slackbot`. `undefined` (whole-host) matches
 * everything. Used by both the router hot path and the declare uniqueness test.
 */
export function sharedPathMatches(prefix: string | undefined, requestPath: string): boolean {
  if (prefix === undefined) return true;
  return requestPath === prefix || requestPath.startsWith(`${prefix}/`);
}

export function withSharedLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(sharedRoot(), fn);
}

function parseShared(source: string): SharedHostnameRecord | null {
  let value: Partial<SharedHostnameRecord>;
  try {
    value = JSON.parse(source) as Partial<SharedHostnameRecord>;
  } catch {
    return null;
  }
  if (
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof value.name !== "string" || !NAME_RE.test(value.name) ||
    typeof value.hostname !== "string" || value.hostname.length === 0 ||
    typeof value.tunnelUuid !== "string" || value.tunnelUuid.length === 0 ||
    typeof value.zone !== "string" || value.zone.length === 0 ||
    typeof value.service !== "string" || value.service.length === 0 ||
    typeof value.createdAt !== "string"
  ) return null;
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path.startsWith("/"))) {
    return null;
  }
  if (value.holder !== undefined) {
    const holder = value.holder as Partial<SharedHolder>;
    if (
      typeof holder.project !== "string" ||
      typeof holder.worktree !== "string" ||
      typeof holder.service !== "string" ||
      typeof holder.at !== "string"
    ) return null;
  }
  if (value.queue !== undefined) {
    if (!Array.isArray(value.queue)) return null;
    for (const entry of value.queue as Array<Partial<SharedClaimWaiter>>) {
      if (
        typeof entry !== "object" || entry === null ||
        typeof entry.project !== "string" ||
        typeof entry.worktree !== "string" ||
        typeof entry.at !== "string"
      ) return null;
    }
  }
  return value as SharedHostnameRecord;
}

export function readSharedHostname(name: string): SharedHostnameRecord | null {
  const p = sharedPath(name);
  if (!existsSync(p)) return null;
  try {
    return parseShared(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Tolerant read-all — an unreadable record disables itself, never the set. */
export function listSharedHostnames(): SharedHostnameRecord[] {
  const root = sharedRoot();
  if (!existsSync(root)) return [];
  const records: SharedHostnameRecord[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (!entry.endsWith(".json")) continue;
    const record = readSharedHostname(entry.slice(0, -".json".length));
    if (record !== null && `${record.name}.json` === entry) records.push(record);
  }
  return records;
}

/**
 * Declare (or re-declare) one shared hostname. Idempotent when the existing
 * record already points at the same hostname and tunnel; a mismatch is a
 * conflict — silently re-pointing a stable URL is exactly the misdelivery
 * shared hostnames exist to prevent.
 */
export async function declareSharedHostname(
  record: Omit<SharedHostnameRecord, "schemaVersion" | "createdAt" | "holder">,
): Promise<SharedHostnameRecord> {
  assertSharedName(record.name);
  assertSharedHostnameFqdn(record.hostname);
  const path = normalizeSharedPath(record.path);
  return withSharedLock(async () => {
    // (hostname, path) must be unique across handles: two handles may share a
    // hostname only when their paths differ (that IS path-based routing), but
    // an identical (hostname, path) pair is the ambiguous first-match the
    // router could never resolve deterministically.
    const collision = listSharedHostnames().find(
      (candidate) =>
        candidate.name !== record.name &&
        candidate.hostname === record.hostname &&
        (candidate.path ?? undefined) === (path ?? undefined),
    );
    if (collision !== undefined) {
      throw new HestiaError(
        "shared-conflict",
        `${record.hostname}${path ?? ""} is already declared as shared hostname ` +
          `"${collision.name}" — pick a distinct path or handle`,
      );
    }
    const existing = readSharedHostname(record.name);
    if (existing !== null) {
      if (
        existing.hostname !== record.hostname ||
        existing.tunnelUuid !== record.tunnelUuid ||
        (existing.path ?? undefined) !== (path ?? undefined)
      ) {
        throw new HestiaError(
          "shared-conflict",
          `shared hostname "${record.name}" already declared as ${existing.hostname}` +
            `${existing.path ?? ""} on tunnel ${existing.tunnelUuid} — release and remove it before re-pointing`,
        );
      }
      // Re-declare refreshes the service contract but never the holder.
      const merged: SharedHostnameRecord = { ...existing, service: record.service, zone: record.zone };
      writeAtomicJsonFile(sharedPath(record.name), merged);
      return merged;
    }
    const fresh: SharedHostnameRecord = {
      schemaVersion: STATE_SCHEMA_VERSION,
      ...record,
      createdAt: new Date().toISOString(),
    };
    // Persist the NORMALIZED path (or omit it) — never the caller's raw input.
    if (path === undefined) delete fresh.path;
    else fresh.path = path;
    writeAtomicJsonFile(sharedPath(record.name), fresh);
    return fresh;
  });
}

/**
 * Read-modify-write one record atomically under the shared lock. `mutate`
 * returns the next record (holder AND durable queue live in the same file, so
 * grant-and-dequeue is one atomic write). Returns null for an unknown name.
 */
export async function updateSharedHostname(
  name: string,
  mutate: (record: SharedHostnameRecord) => SharedHostnameRecord,
): Promise<SharedHostnameRecord | null> {
  return withSharedLock(async () => {
    const existing = readSharedHostname(name);
    if (existing === null) return null;
    const next = mutate(structuredClone(existing));
    if (next.queue !== undefined && next.queue.length === 0) delete next.queue;
    if (next.holder === undefined) delete next.holder;
    writeAtomicJsonFile(sharedPath(name), next);
    return next;
  });
}

/** Set or clear the holder. Returns the updated record (null: unknown name). */
export async function setSharedHolder(
  name: string,
  holder: SharedHolder | undefined,
): Promise<SharedHostnameRecord | null> {
  return updateSharedHostname(name, (record) => ({ ...record, holder }));
}

/** Remove a shared hostname declaration entirely (unclaimed only). */
export async function removeSharedHostname(name: string): Promise<void> {
  await withSharedLock(async () => {
    const existing = readSharedHostname(name);
    if (existing === null) return;
    if (existing.holder !== undefined) {
      throw new HestiaError(
        "shared-held",
        `shared hostname "${name}" is held by ${existing.holder.project} — release it first`,
      );
    }
    rmSync(sharedPath(name), { force: true });
  });
}
