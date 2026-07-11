import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { LABELS, type StackRecord } from "@hestia/core";
import { getRepoInfo } from "./git.ts";
import { tryLoadConfig } from "./config.ts";
import { hestiaDir, hestiaHome, parseStackRecord, readState } from "./state.ts";
import { isLive, listPidfiles, procsDir } from "./proc/pidfile.ts";
import { detectVarlock } from "./proc/resolver.ts";
import { discoverWorkers } from "./wrangler/discover.ts";
import { connectorPidfile, listAdopted, readAdopted } from "./tunnel/registry.ts";
import { listTunnels } from "./tunnel/cloudflared.ts";
import { isReady } from "./tunnel/verify.ts";
import { fetchHealth, readDaemonJson } from "./daemon/client.ts";
import { HESTIAD_PROTOCOL_VERSION } from "./daemon/routes.ts";
import { plistPath } from "./daemon/launchd.ts";
import { readHestiaMachineConfig } from "./router/router-config.ts";
import { readHestiaRouterStatus } from "./router/portless-adapter.ts";
import { readRouterStackRecords } from "./router/local-http-router.ts";

/**
 * `hestia doctor` — report-only, never mutates. Doctor is the tool you reach
 * for when things are broken, so it must not hang on a wedged docker socket
 * or an offline Cloudflare call: every check is individually time-bounded and
 * they all run concurrently. A timed-out check reports `unknown` and never
 * fails the run; only `error` rows set the exit code.
 */

export interface DoctorRow {
  check: string;
  level: "ok" | "warn" | "error" | "unknown";
  detail: string;
}

const CHECK_TIMEOUT_MS = 5_000;

function row(check: string, level: DoctorRow["level"], detail: string): DoctorRow {
  return { check, level, detail };
}

async function bounded(
  check: string,
  fn: () => Promise<DoctorRow[]>,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<DoctorRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DoctorRow[]>((resolve) => {
    timer = setTimeout(() => resolve([row(check, "unknown", "timed out")]), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    return [row(check, "unknown", `check failed: ${(err as Error).message}`)];
  } finally {
    clearTimeout(timer);
  }
}

function exec(
  cmd: string,
  args: string[],
  timeoutMs = CHECK_TIMEOUT_MS - 500,
): Promise<{ ok: boolean; stdout: string; message: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({
        ok: err === null,
        stdout: stdout ?? "",
        message: err !== null ? (stderr || err.message).trim().split("\n")[0]! : "",
      });
    });
  });
}

interface RepoCtx {
  worktreeRoot: string;
  record: StackRecord | null;
  hasCompose: boolean;
}

async function envChecks(ctx: RepoCtx | null): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  if (ctx?.hasCompose) {
    if (Bun.which("docker") === null) {
      rows.push(row("docker", "error", "compose file present but docker is not on PATH"));
    } else {
      const v = await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
      rows.push(
        v.ok
          ? row("docker", "ok", `daemon ${v.stdout.trim()}`)
          : row("docker", "error", `docker daemon unreachable: ${v.message}`),
      );
    }
  }
  if (ctx !== null) {
    const ignored = await exec("git", ["-C", ctx.worktreeRoot, "check-ignore", "-q", ".hestia/"]);
    rows.push(
      ignored.ok
        ? row("state-ignore", "ok", ".hestia/ is ignored")
        : row(
            "state-ignore",
            "error",
            `add the exact line ".hestia/" to ${join(ctx.worktreeRoot, ".gitignore")}`,
          ),
    );
    const schema = existsSync(join(ctx.worktreeRoot, ".env.schema"));
    if (schema) {
      rows.push(
        detectVarlock(ctx.worktreeRoot) !== null
          ? row("varlock", "ok", "local varlock found — worker env composition active")
          : row("varlock", "warn", ".env.schema present but no local varlock (bun install?)"),
      );
    }
    const workers = discoverWorkers(ctx.worktreeRoot);
    if (workers.length > 0) {
      // same resolution as the adapter: nearest node_modules/.bin/wrangler
      // walking up from each config dir (pnpm links per-package, not root)
      const missing = workers.filter((w) => {
        let dir = dirname(w.configPath);
        for (;;) {
          if (existsSync(join(dir, "node_modules", ".bin", "wrangler"))) return false;
          if (dir === ctx.worktreeRoot || dirname(dir) === dir) return true;
          dir = dirname(dir);
        }
      });
      rows.push(
        missing.length === 0
          ? row("wrangler", "ok", `${workers.length} config(s), local binary reachable for all`)
          : row(
              "wrangler",
              "error",
              `${missing.length}/${workers.length} config(s) have no local wrangler binary (install deps)`,
            ),
      );
    }
  }
  if (listAdopted().length > 0 && Bun.which("cloudflared") === null) {
    rows.push(row("cloudflared", "error", "tunnel adopted but cloudflared is not on PATH"));
  }
  return rows;
}

async function repoChecks(ctx: RepoCtx): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  rows.push(
    ctx.hasCompose
      ? row("compose-file", "ok", tryLoadConfig(ctx.worktreeRoot)!.composeFile)
      : row("compose-file", "warn", "none found — compose backend unavailable (run/workers still work)"),
  );
  const ignored = await exec("git", ["-C", ctx.worktreeRoot, "check-ignore", "-q", ".hestia"]);
  rows.push(
    ignored.ok
      ? row("gitignore", "ok", ".hestia is gitignored")
      : row("gitignore", "warn", ".hestia is NOT gitignored — stack state would be committed"),
  );
  return rows;
}

async function stateChecks(ctx: RepoCtx): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const { record, worktreeRoot } = ctx;
  if (record === null) {
    rows.push(row("stack", "ok", "no stack in this worktree"));
    return rows;
  }
  // proc/wrangler liveness straight from pidfiles; docker via one label query
  const pidfiles = new Map(listPidfiles(procsDir(worktreeRoot)).map((pf) => [pf.name, pf]));
  for (const svc of record.services) {
    if (svc.backend === "docker") continue;
    const pf = pidfiles.get(svc.name);
    const live = pf !== undefined && isLive(pf);
    if (!live && svc.state === "healthy") {
      rows.push(row(`service:${svc.name}`, "warn", "recorded healthy but the process is dead"));
    }
  }
  if (record.services.some((s) => s.backend === "docker") && Bun.which("docker") !== null) {
    const ps = await exec("docker", [
      "ps",
      "--filter",
      `label=${LABELS.stack}=${record.project}`,
      "--format",
      "{{.Names}}",
    ]);
    if (ps.ok && ps.stdout.trim() === "") {
      rows.push(row("containers", "warn", "recorded compose services but no containers running"));
    }
  }
  // exposure port drift = live cross-worktree leak (the OS recycles ports)
  for (const exp of record.tunnel?.exposures ?? []) {
    const svc = record.services.find((s) => s.name === exp.service);
    const binding = svc?.bindings?.find((candidate) =>
      `${candidate.target}/${candidate.protocol}` === exp.binding);
    const publishedPort = binding?.publishedPort ?? svc?.publishedPort;
    if (publishedPort !== undefined && publishedPort !== exp.originPort) {
      rows.push(
        row(
          `exposure:${exp.service}`,
          "error",
          `ingress rule points at port ${exp.originPort} but the service owns ` +
            `${publishedPort} — a recycled port serves ANOTHER worktree; ` +
            `run any hestia command to resync, this should not persist`,
        ),
      );
    }
  }
  const lockPath = join(hestiaDir(worktreeRoot), "lock");
  if (existsSync(lockPath)) {
    try {
      const holder = JSON.parse(readFileSync(lockPath, "utf8")) as {
        pid: number;
        startTime: string;
      };
      if (!isLive(holder)) {
        rows.push(row("lock", "warn", "stale worktree lock (dead holder) — auto-broken on next command"));
      }
    } catch {
      rows.push(row("lock", "warn", "unreadable worktree lock file"));
    }
  }
  const mirror = join(hestiaHome(), "stacks", record.project, "stack.json");
  if (!existsSync(mirror)) {
    rows.push(row("mirror", "warn", "no ~/.hestia mirror — `down --project` would not work after worktree deletion"));
  }
  return rows;
}

/** Machine-wide checks: orphan mirrors + labeled containers with no mirror. */
async function machineChecks(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const stacksDir = join(hestiaHome(), "stacks");
  const mirrored = new Set<string>();
  if (existsSync(stacksDir)) {
    for (const project of readdirSync(stacksDir)) {
      const p = join(stacksDir, project, "stack.json");
      if (!existsSync(p)) continue;
      mirrored.add(project);
      try {
        const rec = parseStackRecord(readFileSync(p, "utf8"), p);
        if (!existsSync(rec.worktree)) {
          rows.push(
            row(
              `orphan-mirror:${project}`,
              "warn",
              `worktree ${rec.worktree} is gone — \`hestia down --project ${project}\` to clean up`,
            ),
          );
        }
      } catch {
        rows.push(row(`mirror:${project}`, "warn", "unreadable mirror stack.json"));
      }
    }
  }
  if (Bun.which("docker") !== null) {
    const ps = await exec("docker", [
      "ps",
      "--format",
      `{{.Label "${LABELS.stack}"}}`,
    ]);
    if (ps.ok) {
      const labeled = new Set(ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
      for (const project of labeled) {
        if (!mirrored.has(project)) {
          rows.push(
            row(
              `unmirrored-containers:${project}`,
              "error",
              `hestia-labeled containers with no mirror (crash before state write?) — ` +
                `\`hestia down --project ${project}\` to reclaim`,
            ),
          );
        }
      }
    }
  }
  return rows;
}

async function tunnelChecks(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const adopted = listAdopted();
  if (adopted.length === 0) return rows;
  let tunnels: Awaited<ReturnType<typeof listTunnels>> | null = null;
  try {
    tunnels = await listTunnels();
  } catch {
    tunnels = null; // offline / no cert — degrade below
  }
  for (const uuid of adopted) {
    const ref = readAdopted(uuid);
    const label = `tunnel:${ref?.name ?? uuid}`;
    const pf = connectorPidfile(uuid);
    const live = pf !== null && isLive(pf);
    if (!live) {
      rows.push(row(label, "warn", "connector not running — the daemon (or the next hestia command) revives it"));
    } else if (pf.port !== undefined) {
      rows.push(
        (await isReady(pf.port))
          ? row(label, "ok", "connector live with an edge connection")
          : row(label, "warn", "connector running but no edge connection yet"),
      );
    }
    if (tunnels === null) {
      rows.push(row(`${label}:connectors`, "unknown", "cloudflare unreachable — cannot count connectors"));
    } else {
      const info = tunnels.find((t) => t.id === uuid);
      const conns = info?.connections?.length ?? 0;
      const expected = live ? 1 : 0;
      if (conns > expected) {
        rows.push(
          row(
            `${label}:connectors`,
            "error",
            `${conns} connector(s) registered but hestia runs ${expected} — a foreign ` +
              `replica cross-wires worktrees; stop the other cloudflared`,
          ),
        );
      }
    }
  }
  return rows;
}

async function daemonChecks(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const j = readDaemonJson();
  const health = j !== null ? await fetchHealth(j.port) : null;
  if (health === null) {
    rows.push(row("daemon", "warn", "hestiad not running — starts on the next up/run (cap + supervision paused)"));
  } else if (health.protocolVersion !== HESTIAD_PROTOCOL_VERSION) {
    rows.push(
      row(
        "daemon",
        "warn",
        `protocol v${health.protocolVersion} != CLI v${HESTIAD_PROTOCOL_VERSION} — restarts on next up/run`,
      ),
    );
  } else {
    rows.push(
      row("daemon", "ok", `pid ${health.pid}, ${health.live}/${health.maxStacks} stacks, ${health.queued} queued`),
    );
    for (const w of health.warnings) rows.push(row("daemon-config", "warn", w));
  }
  const plist = plistPath();
  if (existsSync(plist)) {
    const content = readFileSync(plist, "utf8");
    const args = [...content.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]!);
    const paths = args.filter((a) => a.startsWith("/") && !a.includes(":"));
    const missing = paths.filter((p) => !existsSync(p));
    rows.push(
      missing.length === 0
        ? row("launchd", "ok", `installed (${plist})`)
        : row("launchd", "error", `plist references missing paths: ${missing.join(", ")} — re-run \`hestia daemon install\``),
    );
  }
  return rows;
}

async function localRouterChecks(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const config = readHestiaMachineConfig();
  rows.push(
    config.valid
      ? row("config-toml", "ok", config.path)
      : row("config-toml", "warn", config.warnings.join("; ")),
  );
  const configuredRoutes = Object.values(config.config.router.repositories)
    .reduce((count, repository) => count + (repository?.services.length ?? 0), 0) +
    readRouterStackRecords().reduce((count, record) => count + (record.localRoutes?.length ?? 0), 0);
  const router = await readHestiaRouterStatus();
  if (!router.installed) {
    rows.push(row(
      "local-router",
      configuredRoutes > 0 ? "warn" : "ok",
      configuredRoutes > 0
        ? "configured routes exist but the HTTPS router is not installed — run `hestia router install --interactive`"
        : "not installed (optional; direct ports remain available)",
    ));
  } else {
    const usable = router.running && router.trusted;
    rows.push(row(
      "local-router",
      usable ? "ok" : "warn",
      usable
        ? `Portless ${router.version} serving on port ${router.port}`
        : router.running
          ? `Portless ${router.version} is running but its CA is not trusted — run \`hestia router install --interactive\``
          : `Portless ${router.version} installed but not reachable on port ${router.port}`,
    ));
  }
  return rows;
}

export async function doctor(cwd: string): Promise<DoctorRow[]> {
  let ctx: RepoCtx | null = null;
  let repoRow: DoctorRow;
  try {
    const { worktreeRoot } = await getRepoInfo(cwd);
    ctx = {
      worktreeRoot,
      record: readState(worktreeRoot),
      hasCompose: tryLoadConfig(worktreeRoot) !== null,
    };
    repoRow = row("worktree", "ok", worktreeRoot);
  } catch (err) {
    repoRow = row("worktree", "warn", `not a git worktree (${(err as Error).message}) — repo/state checks skipped`);
  }

  const sections = await Promise.all([
    bounded("env", () => envChecks(ctx)),
    ctx !== null ? bounded("repo", () => repoChecks(ctx)) : Promise.resolve([]),
    ctx !== null ? bounded("state", () => stateChecks(ctx)) : Promise.resolve([]),
    bounded("machine", () => machineChecks()),
    bounded("tunnel", () => tunnelChecks()),
    bounded("daemon", () => daemonChecks()),
    bounded("local-router", () => localRouterChecks()),
  ]);
  return [repoRow, ...sections.flat()];
}
