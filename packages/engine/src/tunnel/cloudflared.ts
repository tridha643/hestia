import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HestiaError } from "@hestia/core";

const pexec = promisify(execFile);

/**
 * Wrapper around the user's cloudflared binary. Hestia ADOPTS an existing
 * named tunnel — it never runs `tunnel create` or `tunnel delete`, and every
 * mutating call after adoption targets the tunnel's UUID, never its name, so
 * a teammate's same-prefixed tunnel on the shared account can never be hit.
 */

export const BIN = "cloudflared";

/** ~/.cloudflared (cert.pem + per-uuid credential JSONs). Test seam via env. */
export function cloudflaredHome(): string {
  return process.env.HESTIA_CLOUDFLARED_HOME ?? join(homedir(), ".cloudflared");
}

export function certPath(): string {
  return process.env.TUNNEL_ORIGIN_CERT ?? join(cloudflaredHome(), "cert.pem");
}

/** Credentials JSON written by the user's own `cloudflared tunnel create`. */
export function credFilePath(uuid: string): string {
  return process.env.TUNNEL_CRED_FILE ?? join(cloudflaredHome(), `${uuid}.json`);
}

async function run(args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await pexec(BIN, args, { timeout: timeoutMs });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new HestiaError(
        "cloudflared-missing",
        "cloudflared not found on PATH (brew install cloudflared)",
      );
    }
    throw err;
  }
}

export interface TunnelListEntry {
  id: string;
  name: string;
  /**
   * Live EDGE-CONNECTION records, flattened across connectors — one healthy
   * connector holds ~4 of these. Non-empty means someone is running this
   * tunnel; the length is NOT a connector count (use countConnectors).
   */
  connections: Array<{ id?: string; origin_ip?: string; colo_name?: string }>;
}

/** `tunnel list -o json`, parsed tolerantly across cloudflared versions. */
export async function listTunnels(): Promise<TunnelListEntry[]> {
  const out = await run(["tunnel", "list", "-o", "json"]);
  const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
  return parsed.map((t) => ({
    id: String(t.id ?? ""),
    name: String(t.name ?? ""),
    connections: Array.isArray(t.connections)
      ? (t.connections as TunnelListEntry["connections"])
      : [],
  }));
}

/**
 * Count CONNECTORS registered on a tunnel. `tunnel info -o json` nests edge
 * connections under one `conns[]` entry per connector, so its top-level
 * length is the replica count `tunnel list` cannot provide.
 */
export async function countConnectors(uuid: string): Promise<number> {
  const out = await run(["tunnel", "info", "-o", "json", uuid]);
  const parsed = JSON.parse(out) as { conns?: unknown };
  return Array.isArray(parsed.conns) ? parsed.conns.length : 0;
}

/** Resolve an adopted tunnel by name; requires its credentials JSON locally. */
export async function adoptTunnel(
  name: string,
): Promise<{ uuid: string; credFile: string; connections: number }> {
  const entry = (await listTunnels()).find((t) => t.name === name);
  if (entry === undefined) {
    throw new HestiaError(
      "tunnel-not-found",
      `no tunnel named "${name}" on this account — create it once with ` +
        `\`cloudflared tunnel create ${name}\``,
    );
  }
  const credFile = credFilePath(entry.id);
  if (!existsSync(credFile)) {
    throw new HestiaError(
      "tunnel-auth-missing",
      `credentials for tunnel "${name}" not found at ${credFile} — ` +
        `run \`cloudflared tunnel create\` on this machine or copy the JSON`,
    );
  }
  return { uuid: entry.id, credFile, connections: entry.connections.length };
}

/**
 * Route a hostname to the adopted tunnel (CNAME → <uuid>.cfargotunnel.com).
 * Plain by default; `overwrite` re-points an existing record — only pass it
 * when the caller has established the record is hestia's own (ledger hit or
 * explicit --overwrite-dns), never to silently capture a foreign name.
 */
export async function routeDns(
  uuid: string,
  hostname: string,
  overwrite: boolean,
): Promise<void> {
  if (!existsSync(certPath())) {
    throw new HestiaError(
      "tunnel-auth-missing",
      `routing DNS needs ${certPath()} — run \`cloudflared tunnel login\``,
    );
  }
  const args = ["tunnel", "route", "dns"];
  if (overwrite) args.push("--overwrite-dns");
  args.push(uuid, hostname);
  try {
    await run(args);
  } catch (err) {
    if (err instanceof HestiaError) throw err;
    const msg = (err as { stderr?: string; message?: string }).stderr ?? "";
    const text = `${msg} ${(err as Error).message ?? ""}`;
    if (/already exists|existing (DNS )?record/i.test(text)) {
      throw new HestiaError(
        "dns-record-conflict",
        `a DNS record for ${hostname} already exists and hestia has no ` +
          `memory of creating it — if it is from a previous hestia run, ` +
          `re-run with --overwrite-dns; if not, pick another name (records ` +
          `in the shared zone are never overwritten silently)`,
      );
    }
    throw new HestiaError(
      "dns-route-failed",
      `cloudflared tunnel route dns ${hostname} failed: ${(err as Error).message}`,
    );
  }
}
