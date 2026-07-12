import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { HestiaError, slug, type TunnelExposure } from "@hestia/core";
import { cloudflaredHome } from "./cloudflared.ts";
import {
  internalEndpointAuthority,
  publicGatewaySocketPath,
} from "../router/local-http-router.ts";

/**
 * Pure ingress logic for the unified tunnel: hostname derivation, import of
 * the user's static rules, and merged-config generation. The merged config is
 * DERIVED state — base rules re-read from the user's file and dynamic rules
 * re-read from stack mirrors on every regen — never hand-maintained.
 */

export interface IngressRule {
  hostname?: string;
  path?: string;
  service: string;
  originRequest?: Record<string, unknown>;
}

/** Max DNS label length; longer derived names get a stable hash suffix. */
const LABEL_MAX = 63;
const HASH_LEN = 6;

/**
 * `<tunnel>-<branch>-<svc>` as one DNS label under the zone (single-label:
 * universal SSL only covers one level). Deterministic; over-budget labels are
 * truncated with a hash of the full form so two long names can't collide.
 */
export function hostnameFor(
  tunnelName: string,
  branch: string,
  service: string,
  zone: string,
): string {
  const label = `${slug(tunnelName)}-${slug(branch)}-${slug(service)}`;
  if (label.length <= LABEL_MAX) return `${label}.${zone}`;
  const hash = createHash("sha256").update(label).digest("hex").slice(0, HASH_LEN);
  const keep = label.slice(0, LABEL_MAX - HASH_LEN - 1).replace(/-+$/, "");
  return `${keep}-${hash}.${zone}`;
}

/** The zone is the hostname minus its first label. */
export function zoneOf(hostname: string): string | undefined {
  const dot = hostname.indexOf(".");
  return dot > 0 ? hostname.slice(dot + 1) : undefined;
}

/** Infer the zone from imported base rules (their common suffix), if any. */
export function inferZone(baseRules: IngressRule[]): string | undefined {
  const zones = new Set(
    baseRules
      .map((r) => (r.hostname !== undefined ? zoneOf(r.hostname) : undefined))
      .filter((z): z is string => z !== undefined),
  );
  return zones.size === 1 ? [...zones][0] : undefined;
}

/**
 * Import the user's static ingress rules for the adopted tunnel from
 * ~/.cloudflared/config.yml (verbatim, minus the catch-all — we append our
 * own). The user's file is read-only to hestia. Returns [] when the file is
 * absent or describes a different tunnel.
 */
export function importBaseRules(uuid: string, name: string): IngressRule[] {
  const p = join(cloudflaredHome(), "config.yml");
  if (!existsSync(p)) return [];
  let parsed: { tunnel?: unknown; ingress?: unknown };
  try {
    parsed = parseYaml(readFileSync(p, "utf8")) as typeof parsed;
  } catch {
    return [];
  }
  const declared = String(parsed.tunnel ?? "");
  if (declared !== uuid && declared !== name) return [];
  if (!Array.isArray(parsed.ingress)) return [];
  return (parsed.ingress as IngressRule[]).filter(
    (r) => r.hostname !== undefined || r.path !== undefined,
  );
}

export interface DynamicRule extends TunnelExposure {
  project: string;
}

/** One machine-owned stable hostname whose per-request routing hestiad decides. */
export interface SharedRule {
  name: string;
  hostname: string;
}

/**
 * Base rules first (the user's primary worktree), then machine-owned shared
 * hostnames, then per-worktree dynamic rules, then the mandatory catch-all.
 * Dynamic rules rewrite Host to the project's internal authority by default —
 * vite/next dev servers reject foreign Hosts (allowedHosts / allowedDevOrigins)
 * — unless the exposure opted out. Shared rules NEVER rewrite: the public
 * hostname must reach the gateway verbatim because the hestiad route table —
 * not this config — picks the claiming worktree, which is why holder switches
 * need no connector restart (cloudflared origin_proxy.go only sets Host when
 * httpHostHeader is configured).
 */
export function generateMergedConfig(opts: {
  uuid: string;
  credFile: string;
  baseRules: IngressRule[];
  dynamicRules: DynamicRule[];
  sharedRules?: SharedRule[];
}): string {
  assertDisjoint(opts.baseRules, opts.dynamicRules, opts.sharedRules ?? []);
  // One ingress rule per UNIQUE shared hostname: multiple path-scoped handles
  // on the same hostname all route the whole hostname to the gateway, where
  // the hestiad router splits by path. So declaring a second path on an
  // existing shared hostname needs no connector restart (the rule already
  // exists) — the same invariant as holder switches.
  const sharedHostnames = [...new Set((opts.sharedRules ?? []).map((s) => s.hostname))];
  const shared: IngressRule[] = sharedHostnames.map((hostname) => ({
    hostname,
    service: `unix:${publicGatewaySocketPath()}`,
  }));
  const dynamic: IngressRule[] = opts.dynamicRules.map((d) => ({
    hostname: d.hostname,
    service: `unix:${publicGatewaySocketPath()}`,
    ...(d.keepHostHeader
      ? {}
      : { originRequest: { httpHostHeader: internalEndpointAuthority(d.project, d.alias ?? d.service) } }),
  }));
  return stringifyYaml({
    tunnel: opts.uuid,
    "credentials-file": opts.credFile,
    ingress: [
      ...opts.baseRules,
      ...shared,
      ...dynamic,
      { service: "http_status:404" },
    ],
  });
}

/**
 * Every hostname must map to exactly one rule — cloudflared ingress is
 * first-match-wins, so a duplicate silently serves the wrong worktree (the
 * exact misdelivery hestia exists to kill).
 */
function assertDisjoint(base: IngressRule[], dynamic: DynamicRule[], shared: SharedRule[]): void {
  const seen = new Map<string, string>();
  for (const r of base) {
    if (r.hostname !== undefined) seen.set(r.hostname, "the user's static rules");
  }
  // Shared handles may legitimately repeat a hostname (path-based routing), so
  // conflict-check each unique shared hostname once, against base only — the
  // (hostname, path) uniqueness that keeps sibling handles distinct is enforced
  // by the store at declare time, not here.
  const sharedByHost = new Map<string, string>();
  for (const s of shared) {
    if (!sharedByHost.has(s.hostname)) sharedByHost.set(s.hostname, s.name);
  }
  for (const [hostname, name] of sharedByHost) {
    const holder = seen.get(hostname);
    if (holder !== undefined) {
      throw new HestiaError(
        "hostname-conflict",
        `shared hostname ${hostname} ("${name}") is already claimed by ${holder}`,
      );
    }
    seen.set(hostname, `shared hostname "${name}"`);
  }
  for (const d of dynamic) {
    const holder = seen.get(d.hostname);
    if (holder !== undefined) {
      throw new HestiaError(
        "hostname-conflict",
        `hostname ${d.hostname} (service "${d.service}" of ${d.project}) ` +
          `is already claimed by ${holder}`,
      );
    }
    seen.set(d.hostname, `project ${d.project}`);
  }
}
