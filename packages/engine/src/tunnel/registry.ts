import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HestiaError, type StackRecord, type TunnelRef } from "@hestia/core";
import { hestiaHome } from "../state.ts";
import { withLock } from "../proc/lock.ts";
import { credFilePath } from "./cloudflared.ts";
import { startProc } from "../proc/supervisor.ts";
import { isLive, readPidfile, removePidfile } from "../proc/pidfile.ts";
import { stopProcTree } from "../proc/shutdown.ts";
import {
  type DynamicRule,
  generateMergedConfig,
  importBaseRules,
} from "./ingress.ts";
import { pollReady } from "./verify.ts";

/**
 * The machine-global unified-tunnel singleton: ONE connector process per
 * adopted tunnel, serving a merged ingress (the user's static rules + every
 * worktree's exposures). One connector is the whole point — multiple
 * connectors on one tunnel are HA replicas that Cloudflare load-balances
 * nondeterministically across worktrees.
 *
 * The tunnel dir doubles as a "worktree root" for the shipped proc machinery
 * (startProc/pidfile/lock all key off `<root>/.hestia/...`), so the connector
 * gets tree supervision, lstart identity, and crash-safe pidfiles for free.
 */

export const CONNECTOR = "connector";
const READY_TIMEOUT_MS = 30_000;

export function tunnelDir(uuid: string): string {
  return join(hestiaHome(), "tunnel", uuid);
}

function configPath(uuid: string): string {
  return join(tunnelDir(uuid), "config.yml");
}

/** Marker that hestia has successfully run this tunnel's connector before. */
function adoptedMarker(uuid: string): string {
  return join(tunnelDir(uuid), "adopted.json");
}

/**
 * Whether hestia has ever run this tunnel's connector. Gates the takeover
 * preflight: once adopted, live connections on the tunnel are (presumed)
 * hestia's own connector, not a foreign replica.
 */
export function isAdopted(uuid: string): boolean {
  return existsSync(adoptedMarker(uuid));
}

export interface AdoptedRef {
  uuid: string;
  name: string;
  credFile: string;
  /** True when a legacy `{at}`-only marker was rebuilt from conventions/mirrors. */
  reconstructed: boolean;
}

/**
 * Read the adopted-tunnel ref for connector revival with no live CLI context.
 * Markers written before the ref was persisted (legacy `{at}`-only) are
 * reconstructed: uuid = the dir name, credFile by ~/.cloudflared convention,
 * name from any stack mirror pinned to this uuid (falls back to the uuid —
 * base-rule import matches by uuid too, so only name-keyed user configs
 * degrade, and callers can warn via `reconstructed`). The marker heals itself:
 * every successful reconcile rewrites it enriched.
 */
export function readAdopted(uuid: string): AdoptedRef | null {
  const p = adoptedMarker(uuid);
  if (!existsSync(p)) return null;
  let marker: { name?: string; credFile?: string };
  try {
    marker = JSON.parse(readFileSync(p, "utf8")) as typeof marker;
  } catch {
    marker = {};
  }
  if (typeof marker.name === "string" && typeof marker.credFile === "string") {
    return { uuid, name: marker.name, credFile: marker.credFile, reconstructed: false };
  }
  let name: string | undefined;
  const stacksDir = join(hestiaHome(), "stacks");
  if (existsSync(stacksDir)) {
    for (const project of readdirSync(stacksDir)) {
      const sp = join(stacksDir, project, "stack.json");
      if (!existsSync(sp)) continue;
      try {
        const record = JSON.parse(readFileSync(sp, "utf8")) as StackRecord;
        if (record.tunnel?.uuid === uuid) {
          name = record.tunnel.name;
          break;
        }
      } catch {
        // unreadable mirror — keep scanning
      }
    }
  }
  return {
    uuid,
    name: name ?? uuid,
    credFile: marker.credFile ?? credFilePath(uuid),
    reconstructed: true,
  };
}

/** Every tunnel uuid this machine has adopted (daemon supervision set). */
export function listAdopted(): string[] {
  const root = join(hestiaHome(), "tunnel");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((uuid) => isAdopted(uuid));
}

/** Hostnames hestia has route-dns'ed — the ledger that makes re-routing a no-op. */
function ledgerPath(uuid: string): string {
  return join(tunnelDir(uuid), "hostnames.json");
}

export function ledgerHas(uuid: string, hostname: string): boolean {
  const p = ledgerPath(uuid);
  if (!existsSync(p)) return false;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as string[]).includes(hostname);
  } catch {
    return false;
  }
}

export function ledgerAdd(uuid: string, hostname: string): void {
  mkdirSync(tunnelDir(uuid), { recursive: true });
  const p = ledgerPath(uuid);
  const cur = existsSync(p)
    ? (JSON.parse(readFileSync(p, "utf8")) as string[])
    : [];
  if (!cur.includes(hostname)) {
    writeFileSync(p, JSON.stringify([...cur, hostname], null, 2));
  }
}

/**
 * Every worktree's exposures for this tunnel, read from the stack mirrors —
 * the same mirrors `down --project` uses, so rules follow stack lifecycle
 * even after a worktree directory is deleted. Exposures whose service no
 * longer exists in the stack are dropped (the hostname 404s at the catch-all
 * instead of pointing at a recycled port).
 */
export function collectDynamicRules(uuid: string): {
  rules: DynamicRule[];
  dropped: Array<{ project: string; service: string; hostname: string }>;
} {
  const stacksDir = join(hestiaHome(), "stacks");
  const rules: DynamicRule[] = [];
  const dropped: Array<{ project: string; service: string; hostname: string }> = [];
  if (!existsSync(stacksDir)) return { rules, dropped };
  for (const project of readdirSync(stacksDir)) {
    const p = join(stacksDir, project, "stack.json");
    if (!existsSync(p)) continue;
    let record: StackRecord;
    try {
      record = JSON.parse(readFileSync(p, "utf8")) as StackRecord;
    } catch {
      continue;
    }
    if (record.tunnel?.uuid !== uuid) continue;
    for (const exp of record.tunnel.exposures) {
      const svc = record.services.find((s) => s.name === exp.service);
      if (svc === undefined || svc.publishedPort === undefined) {
        dropped.push({ project, service: exp.service, hostname: exp.hostname });
        continue;
      }
      // The stack's own regen hooks keep originPort current; the live record
      // is still authoritative in case this regen races a restart.
      rules.push({ ...exp, originPort: svc.publishedPort, project });
    }
  }
  return { rules, dropped };
}

export interface ReconcileOutcome {
  /** Connector was (re)started this call — the "blip". */
  restarted: boolean;
  /** Metrics port of the live connector, when one is running. */
  metricsPort?: number;
  ready: boolean;
  warnings: string[];
  error?: HestiaError;
}

/**
 * Converge the connector on the merged ingress derived from disk. Idempotent:
 * unchanged config + live connector = no-op. Serialized machine-wide by the
 * tunnel dir's lock; callers must NOT hold it (lock order: worktree → global).
 */
export async function reconcileTunnel(
  ref: Pick<TunnelRef, "uuid" | "name" | "credFile">,
  opts?: { force?: boolean; readyTimeoutMs?: number },
): Promise<ReconcileOutcome> {
  const dir = tunnelDir(ref.uuid);
  mkdirSync(dir, { recursive: true });

  return withLock(dir, async () => {
    const warnings: string[] = [];
    const baseRules = importBaseRules(ref.uuid, ref.name);
    const { rules, dropped } = collectDynamicRules(ref.uuid);
    for (const d of dropped) {
      warnings.push(
        `exposure ${d.hostname} dropped — service "${d.service}" of ` +
          `${d.project} is not running (hostname now 404s)`,
      );
    }

    const cfgPath = configPath(ref.uuid);
    const nextConfig = generateMergedConfig({
      uuid: ref.uuid,
      credFile: ref.credFile,
      baseRules,
      dynamicRules: rules,
    });

    const pf = readPidfile(dir, CONNECTOR);
    const live = pf !== null && isLive(pf);
    const currentConfig = existsSync(cfgPath)
      ? readFileSync(cfgPath, "utf8")
      : null;

    if (live && currentConfig === nextConfig) {
      return { restarted: false, metricsPort: pf.port, ready: true, warnings };
    }

    // Nothing to serve and nothing imported: stop rather than run a 404-only
    // connector (first adoption with no exposures never gets here — expose
    // writes its records before reconciling).
    if (baseRules.length === 0 && rules.length === 0) {
      if (pf !== null) {
        await stopProcTree(pf);
        removePidfile(dir, CONNECTOR);
      }
      return { restarted: false, ready: false, warnings };
    }

    if (pf !== null) {
      await stopProcTree(pf);
      removePidfile(dir, CONNECTOR);
    }
    writeFileSync(cfgPath, nextConfig);

    const result = await startProc(
      dir,
      {
        name: CONNECTOR,
        argv: [
          "cloudflared",
          "tunnel",
          "--config",
          cfgPath,
          "--metrics",
          "127.0.0.1:{port}",
          "--grace-period",
          "5s",
          "--no-autoupdate",
          "run",
          ref.uuid,
        ],
        port: "auto",
        backend: "tunnel",
        readyTimeoutMs: opts?.readyTimeoutMs ?? READY_TIMEOUT_MS,
      },
      {},
    );
    if (result.error !== undefined) {
      // metrics port never bound — connector is misbehaving; surface as
      // tunnel-ready-timeout but leave it running for inspection.
      return {
        restarted: true,
        metricsPort: result.record.publishedPort,
        ready: false,
        warnings,
        error: new HestiaError(
          "tunnel-ready-timeout",
          `connector did not bind its metrics port — logs: ${result.record.logPath}`,
        ),
      };
    }

    // Enriched so revival (daemon duties) can rebuild the ref with zero live
    // stacks; also heals legacy `{at}`-only markers on their first reconcile.
    writeFileSync(
      adoptedMarker(ref.uuid),
      JSON.stringify({
        at: new Date().toISOString(),
        uuid: ref.uuid,
        name: ref.name,
        credFile: ref.credFile,
      }),
    );

    const metricsPort = result.record.publishedPort!;
    const ready = await pollReady(
      metricsPort,
      opts?.readyTimeoutMs ?? READY_TIMEOUT_MS,
    );
    return {
      restarted: true,
      metricsPort,
      ready,
      warnings,
      error: ready
        ? undefined
        : new HestiaError(
            "tunnel-ready-timeout",
            `connector is running but reported no edge connection in time ` +
              `(offline?) — left running, it will keep retrying; logs: ` +
              `${result.record.logPath}`,
          ),
    };
  });
}

/** Live connector view for `status`: pidfile identity + one-shot /ready. */
export function connectorPidfile(uuid: string) {
  return readPidfile(tunnelDir(uuid), CONNECTOR);
}
