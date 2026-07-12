import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { hestiaHome } from "../state.ts";
import type { Pidfile } from "../proc/pidfile.ts";

/**
 * Local process groups that Hestia itself spawned for an adopted tunnel, but
 * that are no longer tracked by the connector pidfile. This happens when a
 * revival/reconcile loses the pidfile (dead worktree daemon binary, locale
 * liveness false-negative, crash mid-restart) and the 15s daemon sweep starts
 * another connector without killing the previous one — Cloudflare then
 * load-balances across the replicas and doctor fails with N connectors.
 *
 * Ownership is proven by the hestia config path in argv
 * (`~/.hestia/tunnel/<uuid>/…`). Token-based or hand-run cloudflareds without
 * that path are left alone — those are truly foreign.
 */

export interface LocalConnectorProcess {
  pid: number;
  pgid: number;
  command: string;
}

/** Path marker every hestia-supervised connector argv contains. */
export function hestiaTunnelMarker(uuid: string): string {
  return join(hestiaHome(), "tunnel", uuid);
}

/**
 * Parse `ps -Ao pid=,pgid=,command=` output for hestia-owned connectors of
 * one tunnel. Exported for unit tests — production callers use
 * {@link listLocalHestiaConnectors}.
 */
export function parseLocalHestiaConnectors(
  psOutput: string,
  marker: string,
): LocalConnectorProcess[] {
  const rows: LocalConnectorProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m === null) continue;
    const command = m[3]!;
    if (!command.includes(marker)) continue;
    // Only cloudflared itself — not an editor/tail holding the path open.
    if (!/(^|[\/\s])cloudflared(\s|$)/.test(command)) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), command });
  }
  return rows;
}

/** Live local cloudflared processes Hestia started for this tunnel uuid. */
export function listLocalHestiaConnectors(uuid: string): LocalConnectorProcess[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-Ao", "pid=,pgid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch {
    return [];
  }
  return parseLocalHestiaConnectors(out, hestiaTunnelMarker(uuid));
}

const REAP_GRACE_MS = 5_000;
const REAP_POLL_MS = 100;

/**
 * Signal every hestia-owned connector process group for `uuid` except the
 * currently-tracked live one (`keep`). Returns how many groups were signaled.
 * Idempotent: already-dead groups are a successful no-op.
 */
export async function reapOrphanConnectors(
  uuid: string,
  keep?: Pick<Pidfile, "pid" | "pgid">,
): Promise<{ reapedGroups: number; pids: number[] }> {
  const procs = listLocalHestiaConnectors(uuid).filter((p) => {
    if (keep === undefined) return true;
    return p.pgid !== keep.pgid && p.pid !== keep.pid;
  });
  if (procs.length === 0) return { reapedGroups: 0, pids: [] };

  const groups = new Set(procs.map((p) => p.pgid));
  const pids = procs.map((p) => p.pid);
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // group already gone
    }
  }

  const deadline = Date.now() + REAP_GRACE_MS;
  while (Date.now() < deadline) {
    const still = listLocalHestiaConnectors(uuid).filter((p) => {
      if (keep === undefined) return true;
      return p.pgid !== keep.pgid && p.pid !== keep.pid;
    });
    if (still.length === 0) return { reapedGroups: groups.size, pids };
    await new Promise((r) => setTimeout(r, REAP_POLL_MS));
  }

  for (const p of listLocalHestiaConnectors(uuid)) {
    if (keep !== undefined && (p.pgid === keep.pgid || p.pid === keep.pid)) continue;
    try {
      process.kill(-p.pgid, "SIGKILL");
    } catch {}
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  }
  return { reapedGroups: groups.size, pids };
}
