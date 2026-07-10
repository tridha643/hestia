#!/usr/bin/env bun
import {
  type DoctorRow,
  doctor,
  engine,
  ensureDaemon,
  fetchHealth,
  fetchState,
  installLaunchd,
  launchdManagesThisHome,
  plistPath,
  readDaemonJson,
  stopDaemonProcess,
  uninstallLaunchd,
} from "@hestia/engine";
import { execFileSync } from "node:child_process";
import { HestiaError, type ProcSpec, type StackRecord } from "@hestia/core";

interface Flags {
  json: boolean;
  destroy: boolean;
  services?: string[];
  /** true = all discovered wrangler configs; string[] filters. */
  workers?: boolean | string[];
  allowRemote: boolean;
  force: boolean;
  noVarlock: boolean;
  varlock: boolean;
  name?: string;
  cwd?: string;
  env: Record<string, string>;
  noPort: boolean;
  signal?: "term" | "int";
  readyTimeout?: number;
  project?: string;
  tunnel?: string;
  zone?: string;
  keepHostHeader: boolean;
  overwriteDns: boolean;
  /** seconds to queue for a stack slot at the cap (absent = fail fast). */
  wait?: number;
  noDaemon: boolean;
  print: boolean;
  /** everything after `--` (the `run` command argv) */
  rest: string[];
  _: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    json: false,
    destroy: false,
    allowRemote: false,
    force: false,
    noVarlock: false,
    varlock: false,
    noPort: false,
    keepHostHeader: false,
    overwriteDns: false,
    noDaemon: false,
    print: false,
    env: {},
    rest: [],
    _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      f.rest = argv.slice(i + 1);
      break;
    } else if (a === "--json") f.json = true;
    else if (a === "--destroy") f.destroy = true;
    else if (a === "--allow-remote") f.allowRemote = true;
    else if (a === "--force") f.force = true;
    else if (a === "--no-varlock") f.noVarlock = true;
    else if (a === "--varlock") f.varlock = true;
    else if (a === "--no-port") f.noPort = true;
    else if (a === "--services") f.services = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--name") f.name = argv[++i];
    else if (a === "--cwd") f.cwd = argv[++i];
    else if (a === "--signal") f.signal = argv[++i] === "int" ? "int" : "term";
    else if (a === "--ready-timeout") f.readyTimeout = Number(argv[++i]) * 1000;
    else if (a === "--project") f.project = argv[++i];
    else if (a === "--tunnel") f.tunnel = argv[++i];
    else if (a === "--zone") f.zone = argv[++i];
    else if (a === "--keep-host-header") f.keepHostHeader = true;
    else if (a === "--overwrite-dns") f.overwriteDns = true;
    else if (a === "--no-daemon") f.noDaemon = true;
    else if (a === "--print") f.print = true;
    else if (a.startsWith("--wait=")) f.wait = Number(a.slice("--wait=".length));
    else if (a === "--wait") {
      // bare flag = wait a long time; a following number is seconds
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) f.wait = Number(argv[++i]);
      else f.wait = 3600;
    }
    else if (a === "--env") {
      const kv = argv[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) f.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith("--workers=")) {
      f.workers = a.slice("--workers=".length).split(",").filter(Boolean);
    } else if (a === "--workers") {
      // bare flag = all discovered; a following non-flag token is a filter list
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        f.workers = argv[++i]!.split(",").filter(Boolean);
      } else f.workers = true;
    } else f._.push(a);
  }
  if (Array.isArray(f.workers) && f.workers.length === 0) f.workers = true;
  return f;
}

/**
 * Best-effort browser open. Always a no-op-safe side effect — the URL is
 * printed regardless, so a headless/remote agent still hands the human a
 * clickable link. HESTIA_NO_OPEN skips the shell-out (tests, pure-resolve use).
 */
function openUrl(url: string): void {
  if (process.env.HESTIA_NO_OPEN) return;
  const [cmd, ...pre] =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", ""]
        : ["xdg-open"];
  try {
    Bun.spawn([cmd!, ...pre, url], { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // no browser here — the printed URL is the fallback
  }
}

function fail(code: string, message: string, json: boolean): never {
  if (json) {
    process.stdout.write(JSON.stringify({ error: { code, message } }) + "\n");
  } else {
    process.stderr.write(`error [${code}]: ${message}\n`);
  }
  process.exit(1);
}

function printStackHuman(r: StackRecord): void {
  const out: string[] = [];
  out.push(`${r.project}  ${r.state}  (${r.branch} @ ${r.worktree})`);
  for (const s of r.services) {
    const port = s.publishedPort ? `127.0.0.1:${s.publishedPort}` : "-";
    const pub = r.endpoints.find((e) => e.name === s.name)?.publicUrl;
    out.push(
      `  ● ${s.name.padEnd(12)} ${s.backend.padEnd(7)} ${port.padEnd(20)} ${s.state}` +
        (pub !== undefined ? `  ${pub}` : ""),
    );
  }
  process.stdout.write(out.join("\n") + "\n");
}

const HELP = `hestia — per-worktree isolated dev stacks

usage:
  hestia up   [--services a,b] [--workers[=a,b]] [--allow-remote] [--force]
              [--no-varlock] [--wait[=secs]] [--no-daemon] [--json]
        compose stack up; --workers also supervises one \`wrangler dev\` per
        discovered wrangler config (private dev registry per worktree).
        Starting a NEW stack takes a machine-wide slot (cap 5, configurable
        via HESTIA_MAX_STACKS / ~/.hestia/config.json); at the cap it fails
        with stack-limit — --wait[=secs] queues FIFO instead, --no-daemon
        skips the cap entirely
  hestia run --name <name> [--env K=V ...] [--no-port] [--varlock]
             [--signal term|int] [--ready-timeout <s>] [--cwd <rel>]
             [--wait[=secs]] [--no-daemon] [--json] -- <command...>
        supervise a host process in this worktree's stack; {port} in the
        command and $PORT in its env carry the assigned port ({{port}} escapes)
  hestia expose <service...> [--tunnel <name>] [--zone <zone>]
               [--keep-host-header] [--overwrite-dns] [--force]
               [--ready-timeout <s>] [--json]
        publish running stack services through a cloudflare tunnel.
        Without --tunnel (and no prior adoption): one QUICK tunnel per
        service — no account needed, URL rotates per run. With --tunnel:
        adopts your existing named tunnel (sticky) as the machine's SINGLE
        connector serving hostname <tunnel>-<branch>-<svc>.<zone> per
        service alongside your static rules — never run \`cloudflared
        tunnel run\` yourself alongside it (HA replicas cross-wire
        worktrees). URLs land in endpoints[] + HESTIA_<SVC>_URL. These are
        public URLs guarded only by obscurity. Tip: a one-time wildcard
        CNAME  *.<zone> → <tunnel-uuid>.cfargotunnel.com  makes hestia's
        per-branch DNS writes unnecessary.
  hestia open <service> [path] [--json]
        resolve a service's public URL (from \`expose\`) and open it in the
        browser; the URL is always printed too, so a headless agent can hand
        the human a direct-click link. HESTIA_NO_OPEN prints only.
  hestia daemon status|start|stop|install [--print]|uninstall [--json]
        hestiad enforces the stack cap and revives adopted tunnel connectors;
        it auto-starts on up/run. \`install\` writes a launchd agent
        (RunAtLoad + KeepAlive) so the daemon — and your adopted tunnel —
        survive reboots; --print renders the plist without installing.
        \`stop\` pauses supervision; running stacks are untouched
  hestia doctor [--json]
        report-only preflight + state audit: binaries, repo wiring, dead
        procs, exposure port drift, orphan mirrors, connector and daemon
        health. Exit 1 only on error-level rows; never mutates anything
  hestia stop <name> [--json]             stop one supervised proc (idempotent)
  hestia down [--destroy] [--project <name>] [--json]
        tear down procs + containers (--destroy also removes volumes);
        --project works from the mirror after the worktree is deleted
  hestia status [--json]                  show this worktree's stack
  hestia env  [--json]                    print the injected env (export lines)
  hestia endpoint list [--json]           list endpoints
`;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cmd = flags._[0];
  const cwd = process.cwd();

  try {
    switch (cmd) {
      case "up": {
        const r = await engine.up(cwd, {
          services: flags.services,
          workers: flags.workers,
          allowRemote: flags.allowRemote,
          force: flags.force,
          noVarlock: flags.noVarlock,
          wait: flags.wait !== undefined ? flags.wait * 1000 : undefined,
          noDaemon: flags.noDaemon,
        });
        if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        else printStackHuman(r);
        break;
      }
      case "run": {
        if (!flags.name) fail("usage", "run requires --name <name>", flags.json);
        if (flags.rest.length === 0) {
          fail("usage", "run requires a command after --", flags.json);
        }
        const spec: ProcSpec = {
          name: flags.name,
          argv: flags.rest,
          cwd: flags.cwd,
          env: Object.keys(flags.env).length > 0 ? flags.env : undefined,
          port: flags.noPort ? "none" : "auto",
          signal: flags.signal,
          readyTimeoutMs: flags.readyTimeout,
          varlock: flags.varlock,
        };
        const r = await engine.run(cwd, spec, {
          wait: flags.wait !== undefined ? flags.wait * 1000 : undefined,
          noDaemon: flags.noDaemon,
        });
        if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        else printStackHuman(r);
        break;
      }
      case "expose": {
        const services = flags._.slice(1);
        if (services.length === 0) {
          fail("usage", "usage: hestia expose <service...> [--tunnel <name>]", flags.json);
        }
        const r = await engine.expose(cwd, services, {
          tunnel: flags.tunnel,
          zone: flags.zone,
          keepHostHeader: flags.keepHostHeader,
          overwriteDns: flags.overwriteDns,
          force: flags.force,
          readyTimeoutMs: flags.readyTimeout,
        });
        if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        else printStackHuman(r);
        break;
      }
      case "open": {
        const service = flags._[1];
        if (!service) fail("usage", "usage: hestia open <service> [path]", flags.json);
        const r = await engine.status(cwd);
        if (r === null) fail("no-stack", "no stack for this worktree", flags.json);
        const base = r.endpoints.find((e) => e.name === service)?.publicUrl;
        if (base === undefined) {
          fail(
            "service-not-found",
            `"${service}" has no public URL — run \`hestia expose ${service}\` first`,
            flags.json,
          );
        }
        const path = flags._[2];
        const url =
          path === undefined
            ? base
            : base.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
        openUrl(url);
        if (flags.json) process.stdout.write(JSON.stringify({ url }) + "\n");
        else process.stdout.write(`${url}\n`);
        break;
      }
      case "stop": {
        const name = flags._[1];
        if (!name) fail("usage", "usage: hestia stop <name>", flags.json);
        await engine.stopService(cwd, name);
        if (flags.json) process.stdout.write(JSON.stringify({ ok: true }) + "\n");
        else process.stdout.write(`${name} stopped\n`);
        break;
      }
      case "down": {
        if (flags.project !== undefined) {
          await engine.downProject(flags.project, { destroy: flags.destroy });
        } else {
          await engine.down(cwd, { destroy: flags.destroy });
        }
        if (flags.json) process.stdout.write(JSON.stringify({ ok: true }) + "\n");
        else process.stdout.write("stack down\n");
        break;
      }
      case "status": {
        const r = await engine.status(cwd);
        if (flags.json) process.stdout.write(JSON.stringify(r) + "\n");
        else if (r === null) process.stdout.write("no stack for this worktree\n");
        else printStackHuman(r);
        break;
      }
      case "env": {
        const r = await engine.status(cwd);
        if (r === null) fail("no-stack", "no stack for this worktree", flags.json);
        if (flags.json) process.stdout.write(JSON.stringify(r.env) + "\n");
        else {
          for (const [k, v] of Object.entries(r.env)) {
            process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`);
          }
        }
        break;
      }
      case "endpoint": {
        if (flags._[1] !== "list") fail("usage", "usage: hestia endpoint list", flags.json);
        const r = await engine.status(cwd);
        if (r === null) fail("no-stack", "no stack for this worktree", flags.json);
        if (flags.json) process.stdout.write(JSON.stringify(r.endpoints) + "\n");
        else {
          for (const e of r.endpoints) {
            const pub = e.publicUrl !== undefined ? `  ${e.publicUrl}` : "";
            process.stdout.write(`${e.name.padEnd(12)} ${e.host}:${e.port}${pub}  (${e.reservedName})\n`);
          }
        }
        break;
      }
      case "doctor": {
        const rows = await doctor(cwd);
        if (flags.json) {
          process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        } else {
          const mark: Record<DoctorRow["level"], string> = {
            ok: "✓",
            warn: "!",
            error: "✗",
            unknown: "?",
          };
          for (const r of rows) {
            process.stdout.write(`${mark[r.level]} ${r.check.padEnd(28)} ${r.detail}\n`);
          }
        }
        if (rows.some((r) => r.level === "error")) process.exit(1);
        break;
      }
      case "daemon": {
        const sub = flags._[1];
        if (sub === "status") {
          const j = readDaemonJson();
          const health = j !== null ? await fetchHealth(j.port) : null;
          if (health === null) {
            if (flags.json) process.stdout.write(JSON.stringify({ running: false }) + "\n");
            else process.stdout.write("hestiad not running (starts on the next up/run)\n");
            break;
          }
          const state = await fetchState(j!.port);
          if (flags.json) {
            process.stdout.write(JSON.stringify({ running: true, ...health, ...state }) + "\n");
          } else {
            process.stdout.write(
              `hestiad pid ${health.pid} (protocol v${health.protocolVersion}) — ` +
                `${health.live}/${health.maxStacks} stacks` +
                (state !== null && state.live.length > 0 ? `: ${state.live.join(", ")}` : "") +
                (health.queued > 0 ? `, ${health.queued} queued` : "") +
                "\n",
            );
            for (const w of health.warnings) process.stderr.write(`warning: ${w}\n`);
          }
        } else if (sub === "stop") {
          // A launchd-managed daemon must be booted out — SIGTERM alone would
          // just be respawned (or leave launchd thinking it crashed). Only
          // when launchd manages THIS home: a HESTIA_HOME'd CLI must never
          // boot out the machine's real agent.
          if (launchdManagesThisHome()) {
            const uid = process.getuid?.() ?? 501;
            execFileSync("launchctl", ["bootout", `gui/${uid}/dev.hestia.daemon`]);
            process.stderr.write(
              "warning: launchd agent booted out — `hestia daemon install` re-enables reboot revival\n",
            );
          } else {
            await stopDaemonProcess();
          }
          process.stderr.write(
            "warning: stacks keep running; cap + connector supervision paused until the next up/run\n",
          );
          if (flags.json) process.stdout.write(JSON.stringify({ ok: true }) + "\n");
          else process.stdout.write("hestiad stopped\n");
        } else if (sub === "install") {
          const result = installLaunchd({ print: flags.print });
          for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
          if (flags.json) {
            process.stdout.write(JSON.stringify(result) + "\n");
          } else if (result.installedAt !== undefined) {
            process.stdout.write(
              `installed ${result.installedAt} — hestiad (and adopted tunnel connectors) now survive reboots\n`,
            );
          } else {
            process.stdout.write(result.plist);
          }
        } else if (sub === "uninstall") {
          const result = uninstallLaunchd();
          for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
          if (flags.json) process.stdout.write(JSON.stringify(result) + "\n");
          else {
            process.stdout.write(
              result.removed ? `removed ${plistPath()}\n` : "launchd agent was not installed\n",
            );
          }
        } else if (sub === "start") {
          const h = await ensureDaemon();
          if (flags.json) process.stdout.write(JSON.stringify(h.health) + "\n");
          else process.stdout.write(`hestiad running on 127.0.0.1:${h.port} (pid ${h.health.pid})\n`);
        } else {
          fail("usage", "usage: hestia daemon status|start|stop|install [--print]|uninstall", flags.json);
        }
        break;
      }
      case "help":
      case undefined:
        process.stdout.write(HELP);
        break;
      default:
        fail("unknown-command", `unknown command: ${cmd}`, flags.json);
    }
  } catch (err) {
    if (err instanceof HestiaError) fail(err.code, err.message, flags.json);
    fail("internal", (err as Error).message ?? String(err), flags.json);
  }
}

main();
