#!/usr/bin/env bun
import {
  type DoctorRow,
  doctor,
  discoverRepository,
  engine,
  ensureDaemon,
  effectiveLocalRouteServices,
  fetchHealth,
  fetchState,
  installLaunchd,
  installHestiaRouter,
  launchdManagesThisHome,
  resolvedLocalRouteHostname,
  plistPath,
  readDaemonJson,
  readHestiaMachineConfig,
  readHestiaRouterStatus,
  hestiaConfigTomlPath,
  stopDaemonProcess,
  uninstallLaunchd,
  uninstallHestiaRouter,
  initializeRepositoryConfig,
  type EndpointKind,
  type InitRequest,
  type InitScope,
  HESTIAD_PROTOCOL_VERSION,
  resolveEndpointSelection,
  migrateHestiaMachineConfig,
} from "@hestia/engine";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HestiaError,
  STATE_SCHEMA_VERSION,
  type ProcSpec,
  type StackRecord,
} from "@hestia/core";

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
  interactive: boolean;
  direct: boolean;
  local: boolean;
  public: boolean;
  file?: string;
  scope?: InitScope;
  write: boolean;
  follow: boolean;
  tail?: number;
  /** everything after `--` (the `run` command argv) */
  rest: string[];
  _: string[];
  errors: string[];
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
    interactive: false,
    direct: false,
    local: false,
    public: false,
    follow: false,
    write: false,
    env: {},
    rest: [],
    _: [],
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const takeValue = (): string | undefined => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      i += 1;
      return value;
    };
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
    else if (a === "--services") {
      const value = takeValue();
      if (value === undefined || value.startsWith("--")) f.errors.push("--services requires a comma-separated value");
      else f.services = value.split(",").filter(Boolean);
    }
    else if (a === "--name") {
      f.name = takeValue();
      if (!f.name || f.name.startsWith("--")) f.errors.push("--name requires a value");
    }
    else if (a === "--cwd") {
      f.cwd = takeValue();
      if (!f.cwd || f.cwd.startsWith("--")) f.errors.push("--cwd requires a value");
    }
    else if (a === "--signal") {
      const value = takeValue();
      if (value === "int" || value === "term") f.signal = value;
      else f.errors.push("--signal must be term or int");
    }
    else if (a === "--ready-timeout") {
      const value = Number(takeValue());
      if (!Number.isFinite(value) || value < 0) f.errors.push("--ready-timeout requires a non-negative finite number");
      else f.readyTimeout = value * 1000;
    }
    else if (a === "--project") {
      f.project = takeValue();
      if (!f.project || f.project.startsWith("--")) f.errors.push("--project requires a value");
    }
    else if (a === "--tunnel") {
      f.tunnel = takeValue();
      if (!f.tunnel || f.tunnel.startsWith("--")) f.errors.push("--tunnel requires a value");
    }
    else if (a === "--zone") {
      f.zone = takeValue();
      if (!f.zone || f.zone.startsWith("--")) f.errors.push("--zone requires a value");
    }
    else if (a === "--keep-host-header") f.keepHostHeader = true;
    else if (a === "--overwrite-dns") f.overwriteDns = true;
    else if (a === "--no-daemon") f.noDaemon = true;
    else if (a === "--print") f.print = true;
    else if (a === "--interactive") f.interactive = true;
    else if (a === "--direct") f.direct = true;
    else if (a === "--local") f.local = true;
    else if (a === "--public") f.public = true;
    else if (a === "--file") {
      f.file = takeValue();
      if (!f.file || f.file.startsWith("--")) f.errors.push("--file requires a value");
    }
    else if (a === "--scope") {
      const scope = takeValue();
      if (scope === "repository" || scope === "machine") f.scope = scope;
      else f.errors.push("--scope must be repository or machine");
    }
    else if (a === "--write") f.write = true;
    else if (a === "-f" || a === "--follow") f.follow = true;
    else if (a === "--tail") {
      const value = Number(takeValue());
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        f.errors.push("--tail requires a non-negative integer");
      } else f.tail = value;
    }
    else if (a.startsWith("--wait=")) {
      const value = Number(a.slice("--wait=".length));
      if (!Number.isFinite(value) || value < 0) f.errors.push("--wait requires a non-negative finite number");
      else f.wait = value;
    }
    else if (a === "--wait") {
      // bare flag = wait a long time; a following number is seconds
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) f.wait = Number(argv[++i]);
      else f.wait = 3600;
    }
    else if (a === "--env") {
      const kv = takeValue() ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) f.env[kv.slice(0, eq)] = kv.slice(eq + 1);
      else f.errors.push("--env requires K=V");
    } else if (a.startsWith("--workers=")) {
      f.workers = a.slice("--workers=".length).split(",").filter(Boolean);
    } else if (a === "--workers") {
      // bare flag = all discovered; a following non-flag token is a filter list
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        f.workers = argv[++i]!.split(",").filter(Boolean);
      } else f.workers = true;
    } else if (a.startsWith("-")) f.errors.push(`unknown option ${a}`);
    else f._.push(a);
  }
  if (Array.isArray(f.workers) && f.workers.length === 0) f.workers = true;
  return f;
}

function validateCommandOptions(argv: string[], command: string | undefined): string | null {
  const allowedByCommand: Record<string, Set<string>> = {
    version: new Set(["--json"]),
    skill: new Set(["--json"]),
    discover: new Set(["--json"]),
    init: new Set(["--json", "--print", "--scope", "--write", "--no-port"]),
    up: new Set(["--json", "--services", "--workers", "--allow-remote", "--force", "--no-varlock", "--wait", "--no-daemon"]),
    run: new Set(["--json", "--name", "--env", "--no-port", "--varlock", "--signal", "--ready-timeout", "--cwd", "--wait", "--no-daemon"]),
    expose: new Set(["--json", "--tunnel", "--zone", "--keep-host-header", "--overwrite-dns", "--force", "--ready-timeout"]),
    route: new Set(["--json"]),
    router: new Set(["--json", "--interactive"]),
    config: new Set(["--json", "--file"]),
    open: new Set(["--json", "--direct", "--local", "--public"]),
    stop: new Set(["--json"]),
    down: new Set(["--json", "--destroy", "--project"]),
    status: new Set(["--json"]),
    env: new Set(["--json"]),
    endpoint: new Set(["--json"]),
    logs: new Set(["--json", "--follow", "-f", "--tail", "--project"]),
    doctor: new Set(["--json"]),
    tui: new Set<string>(),
    daemon: new Set(["--json", "--print"]),
    help: new Set<string>(),
  };
  const allowed = allowedByCommand[command ?? "help"];
  if (allowed === undefined) return null;
  const optionArguments = new Set([
    "--services", "--name", "--env", "--signal", "--ready-timeout", "--cwd",
    "--project", "--tunnel", "--zone", "--file", "--scope", "--tail",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (raw === "--") break;
    if (!raw.startsWith("-")) continue;
    const option = raw.startsWith("--") && raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    if (!allowed.has(option)) return `${option} is not valid for hestia ${command ?? "help"}`;
    if (!raw.includes("=") && optionArguments.has(option)) index += 1;
  }
  return null;
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

function fail(
  code: string,
  message: string,
  json: boolean,
  details?: Record<string, unknown>,
): never {
  if (json) {
    process.stdout.write(JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }) + "\n");
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
  hestia version [--json]
        print CLI version, state schema, and daemon protocol
  hestia skill path [--json]
        print the packaged Hestia agent skill path
  hestia discover [--json]
        read-only discovery of workloads, bindings, endpoint configuration,
        unresolved decisions, conflicts, and exact setup suggestions
  hestia init --print
  hestia init dockerfile <name> [Dockerfile] --scope repository|machine [--write]
  hestia init proc <name> --scope repository|machine [--no-port] [--write] -- <command...>
  hestia init wrangler <name> [config] --scope repository|machine [--write]
  hestia init endpoint <alias> <workload> <binding> <http|tcp|udp>
              --scope repository|machine [--write]
        proposal-first setup. Without --write the complete proposed TOML is
        printed; explicit --scope ... --write atomically updates that layer.
        Hestia never commits repository configuration
  hestia up   [--services a,b] [--workers[=a,b]] [--allow-remote] [--force]
              [--no-varlock] [--wait[=secs]] [--no-daemon] [--json]
        compose stack up; --workers also supervises one \`wrangler dev\` per
        discovered wrangler config (private dev registry per worktree).
        Starting a NEW stack takes a machine-wide slot (cap 5, configurable
        via HESTIA_MAX_STACKS / ~/.hestia/config.toml / legacy config.json);
        at the cap it fails
        with stack-limit — --wait[=secs] queues FIFO instead, --no-daemon
        skips the cap entirely
  hestia run --name <name> [--env K=V ...] [--no-port] [--varlock]
             [--signal term|int] [--ready-timeout <s>] [--cwd <rel>]
             [--wait[=secs]] [--no-daemon] [--json] -- <command...>
        supervise a host process in this worktree's stack; {port} in the
        command and $PORT in its env carry the assigned port ({{port}} escapes)
  hestia expose <endpoint...> [--tunnel <name>] [--zone <zone>]
               [--keep-host-header] [--force]
               [--ready-timeout <s>] [--json]
        publish running stack services through a cloudflare tunnel.
        Without --tunnel (and no prior adoption): one QUICK tunnel per
        service — no account needed, URL rotates per run. With --tunnel:
        adopts your existing named tunnel (sticky) as the machine's SINGLE
        connector serving hostname <tunnel>-<branch>-<svc>.<zone> per
        service alongside your static rules — never run \`cloudflared
        tunnel run\` yourself alongside it (HA replicas cross-wire
        worktrees). URLs land in endpoints[] + HESTIA_<SVC>_URL. These are
        fail-closed but unauthenticated public URLs. Named v1 performs no DNS
        writes and requires wildcard CNAME *.<zone> → <uuid>.cfargotunnel.com.
  hestia open <service> [path] [--json]
        resolve a service's public URL (from \`expose\`) and open it in the
        browser; the URL is always printed too, so a headless agent can hand
        the human a direct-click link. HESTIA_NO_OPEN prints only.
  hestia route add|disable|reset <endpoint...> [--json] | route list [--json]
        manage sticky per-worktree stable local HTTPS routes. Agents select
        services; hestia resolves and verifies their current direct ports
  hestia router status|install|uninstall [--interactive] [--json]
        manage Hestia's isolated Portless HTTPS service. Commands are
        non-interactive by default; --interactive is the only sudo prompt path
  hestia config path|show|validate|migrate [--file <path>] [--json]
        discover and validate machine-local ~/.hestia/config.toml
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
  hestia endpoint list [--json] | endpoint get <alias|selector> [--json]
        resolve aliases, canonical workload:target/protocol selectors, or a
        uniquely-bound workload; ambiguous workloads fail explicitly
  hestia logs [service...] [-f|--follow] [--tail N] [--project <name>] [--json]
        stream docker and supervised-process logs (default: all services,
        last 50 lines). --json emits one LogLine JSON object per line;
        --project reads the mirror and works after worktree deletion
  hestia tui
        open the interactive, repo-scoped Fleet cockpit. Shows only stacks
        currently managed by hestia; the only mutation is confirmed down,
        which always retains named volumes
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  if (flags.errors.length > 0) fail("usage", flags.errors.join("; "), flags.json);
  const cmd = flags._[0];
  const invalidOption = validateCommandOptions(argv, cmd);
  if (invalidOption !== null) fail("usage", invalidOption, flags.json);
  const cwd = process.cwd();

  try {
    switch (cmd) {
      case "version": {
        const version = {
          cliVersion: "1.0.0",
          stateSchema: STATE_SCHEMA_VERSION,
          daemonProtocol: HESTIAD_PROTOCOL_VERSION,
          runtime: "bun",
        };
        if (flags.json) process.stdout.write(JSON.stringify(version) + "\n");
        else process.stdout.write(
          `hestia ${version.cliVersion} (state v${version.stateSchema}, daemon v${version.daemonProtocol}, Bun)\n`,
        );
        break;
      }
      case "skill": {
        if (flags._[1] !== "path") fail("usage", "usage: hestia skill path", flags.json);
        const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
        const candidates = [
          join(packageRoot, "skills", "hestia", "SKILL.md"),
          join(process.cwd(), "skills", "hestia", "SKILL.md"),
        ];
        const path = candidates.find(existsSync);
        if (path === undefined) fail("config-missing", "packaged Hestia skill was not found", flags.json);
        if (flags.json) process.stdout.write(JSON.stringify({ path }) + "\n");
        else process.stdout.write(`${path}\n`);
        break;
      }
      case "discover": {
        const report = await discoverRepository(cwd);
        if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else {
          process.stdout.write(
            `${report.repository.repo} · ${report.repository.branch}\n${report.repository.worktree}\n`,
          );
          for (const workload of report.runnableWorkloads) {
            process.stdout.write(
              `  runnable  ${workload.name.padEnd(18)} ${workload.source.padEnd(10)} ${workload.decisionSource}\n`,
            );
          }
          for (const workload of report.candidateWorkloads) {
            process.stdout.write(
              `  candidate ${workload.name.padEnd(18)} ${workload.source.padEnd(10)} ${workload.notes.join("; ")}\n`,
            );
          }
          for (const conflict of report.conflicts) process.stderr.write(`conflict: ${conflict}\n`);
          for (const suggestion of report.suggestions) process.stdout.write(`suggest: ${suggestion}\n`);
        }
        if (report.conflicts.length > 0) process.exitCode = 1;
        break;
      }
      case "init": {
        const kind = flags._[1];
        if (kind === undefined && flags.print) {
          const report = await discoverRepository(cwd);
          if (flags.json) process.stdout.write(JSON.stringify({ suggestions: report.suggestions }, null, 2) + "\n");
          else process.stdout.write(report.suggestions.map((line) => `${line}\n`).join(""));
          break;
        }
        if (flags.scope === undefined) {
          fail("usage", "init requires --scope repository or --scope machine", flags.json);
        }
        let request: InitRequest;
        if (kind === "dockerfile") {
          const name = flags._[2];
          if (!name) fail("usage", "init dockerfile requires <name>", flags.json);
          request = { kind, name, file: flags._[3] };
        } else if (kind === "proc") {
          const name = flags._[2];
          if (!name || flags.rest.length === 0) {
            fail("usage", "init proc requires <name> and a command after --", flags.json);
          }
          request = { kind, name, command: flags.rest, port: flags.noPort ? "none" : "auto" };
        } else if (kind === "wrangler") {
          const name = flags._[2];
          if (!name) fail("usage", "init wrangler requires <name>", flags.json);
          request = { kind, name, file: flags._[3] };
        } else if (kind === "endpoint") {
          const [alias, workload, binding, endpointKind] = flags._.slice(2);
          if (!alias || !workload || !binding || !(["http", "tcp", "udp"] as string[]).includes(endpointKind ?? "")) {
            fail(
              "usage",
              "init endpoint requires <alias> <workload> <binding> <http|tcp|udp>",
              flags.json,
            );
          }
          request = {
            kind,
            alias,
            workload,
            binding,
            endpointKind: endpointKind as EndpointKind,
          };
        } else {
          fail("usage", "usage: hestia init --print | init dockerfile|proc|wrangler|endpoint ...", flags.json);
        }
        const result = await initializeRepositoryConfig(cwd, request, flags.scope, flags.write);
        if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        else if (result.written) {
          process.stdout.write(`wrote ${result.path}\nrepository ${result.runnable ? "is runnable" : "still needs setup"}\n`);
        } else {
          process.stdout.write(`# proposed ${result.path}\n${result.proposed}`);
        }
        break;
      }
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
        if (flags.overwriteDns) {
          fail("usage", "--overwrite-dns was removed; named v1 requires user-managed wildcard DNS", flags.json);
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
      case "route": {
        const action = flags._[1];
        const services = flags._.slice(2);
        if (action === "add") {
          const record = await engine.addLocalRoutes(cwd, services);
          if (flags.json) process.stdout.write(JSON.stringify(record, null, 2) + "\n");
          else printStackHuman(record);
        } else if (action === "disable") {
          const record = await engine.disableLocalRoutes(cwd, services);
          if (flags.json) process.stdout.write(JSON.stringify(record, null, 2) + "\n");
          else printStackHuman(record);
        } else if (action === "reset" || action === "remove") {
          const record = await engine.resetLocalRoutes(cwd, services);
          if (flags.json) process.stdout.write(JSON.stringify(record, null, 2) + "\n");
          else printStackHuman(record);
        } else if (action === "list") {
          const record = await engine.status(cwd);
          if (record === null) fail("no-stack", "Route list: no stack for this worktree", flags.json);
          const routes = effectiveLocalRouteServices(record).map((service) => {
            const endpoint = record.endpoints.find((candidate) => candidate.name === service);
            return {
              service,
              directUrl: endpoint?.url,
              localUrl: endpoint?.localUrl ?? `https://${resolvedLocalRouteHostname(record, service)}`,
              available: endpoint?.url !== undefined,
              explicit: record.localRoutes?.some((route) => route.service === service) ?? false,
            };
          });
          if (flags.json) process.stdout.write(JSON.stringify(routes, null, 2) + "\n");
          else for (const route of routes) process.stdout.write(`${route.service.padEnd(16)} ${route.localUrl}\n`);
        } else {
          fail("usage", "usage: hestia route add|disable|reset <endpoint...> | route list", flags.json);
        }
        break;
      }
      case "router": {
        const action = flags._[1];
        const result = action === "status"
          ? await readHestiaRouterStatus()
          : action === "install"
            ? await installHestiaRouter(flags.interactive)
            : action === "uninstall"
              ? await uninstallHestiaRouter(flags.interactive)
              : null;
        if (result === null) {
          fail("usage", "usage: hestia router status|install|uninstall [--interactive]", flags.json);
        }
        if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        else {
          process.stdout.write(
            `router ${result.running ? "running" : result.installed ? "installed" : "not installed"} ` +
              `(Portless ${result.version}, port ${result.port}, ${result.stateDir})\n`,
          );
        }
        break;
      }
      case "config": {
        const action = flags._[1];
        const path = flags.file ?? hestiaConfigTomlPath();
        if (action === "migrate") {
          const result = migrateHestiaMachineConfig();
          if (flags.json) process.stdout.write(JSON.stringify(result) + "\n");
          else process.stdout.write(result.migrated ? `migrated ${result.from} -> ${result.to}\n` : `${result.to} already exists\n`);
        } else if (action === "path") {
          if (flags.json) process.stdout.write(JSON.stringify({ path }) + "\n");
          else process.stdout.write(`${path}\n`);
        } else if (action === "show" || action === "validate") {
          const result = readHestiaMachineConfig(path);
          if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          else if (action === "show") {
            process.stdout.write(`${result.path}\n${JSON.stringify(result.config, null, 2)}\n`);
            for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
          }
          else {
            process.stdout.write(`${result.valid ? "valid" : "invalid"} ${result.path}\n`);
            for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
          }
          if (!result.valid) process.exitCode = 1;
        } else {
          fail("usage", "usage: hestia config path|show|validate|migrate [--file <path>]", flags.json);
        }
        break;
      }
      case "open": {
        const service = flags._[1];
        if (!service) fail("usage", "usage: hestia open <service> [path]", flags.json);
        const r = await engine.status(cwd);
        if (r === null) fail("no-stack", "no stack for this worktree", flags.json);
        const endpoint = resolveEndpointSelection(r, service).endpoint;
        const selectedModes = [flags.direct, flags.local, flags.public].filter(Boolean).length;
        if (selectedModes > 1) fail("usage", "open accepts only one of --direct, --local, or --public", flags.json);
        const localIsCandidate = endpoint?.localUrl !== undefined && (flags.local || selectedModes === 0);
        const router = localIsCandidate ? await readHestiaRouterStatus() : undefined;
        const daemon = localIsCandidate ? readDaemonJson() : null;
        let daemonHealth: Awaited<ReturnType<typeof fetchHealth>> | null = null;
        if (daemon !== null) {
          try {
            daemonHealth = await fetchHealth(daemon.port);
          } catch {}
        }
        const localUsable = router?.installed === true && router.running && router.trusted &&
          daemonHealth?.routerPort === daemon?.routerPort;
        if (flags.local && endpoint?.localUrl !== undefined && !localUsable) {
          fail("router-unreachable", "the requested local HTTPS router is not installed, running, and trusted", flags.json);
        }
        const base = flags.direct
          ? endpoint?.url
          : flags.local
            ? endpoint?.localUrl
            : flags.public
              ? endpoint?.publicUrl
              : localUsable ? endpoint?.localUrl : endpoint?.publicUrl ?? endpoint?.url;
        if (base === undefined) {
          fail(
            "service-not-found",
            `"${service}" has no requested URL surface`,
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
        const action = flags._[1];
        const r = await engine.status(cwd);
        if (r === null) fail("no-stack", "no stack for this worktree", flags.json);
        if (action === "get") {
          const input = flags._[2];
          if (!input) fail("usage", "usage: hestia endpoint get <alias|selector>", flags.json);
          const resolved = resolveEndpointSelection(r, input);
          if (flags.json) process.stdout.write(JSON.stringify(resolved) + "\n");
          else process.stdout.write(
            `${resolved.endpoint.name}  ${resolved.workload}:${resolved.binding}  ` +
            `${resolved.endpoint.kind ?? "tcp"}  ${resolved.endpoint.host}:${resolved.endpoint.port}\n`,
          );
        } else if (action === "list") {
          if (flags.json) process.stdout.write(JSON.stringify(r.endpoints) + "\n");
          else {
          for (const e of r.endpoints) {
            process.stdout.write(`${e.name.padEnd(12)} ${e.host}:${e.port}\n`);
            if (e.url) process.stdout.write(`  direct  ${e.url}\n`);
            if (e.localUrl) process.stdout.write(`  local   ${e.localUrl}\n`);
            if (e.publicUrl) process.stdout.write(`  public  ${e.publicUrl}\n`);
          }
          }
        } else {
          fail("usage", "usage: hestia endpoint list | endpoint get <alias|selector>", flags.json);
        }
        break;
      }
      case "logs": {
        if (flags.tail !== undefined && (!Number.isInteger(flags.tail) || flags.tail < 0)) {
          fail("usage", "--tail requires a non-negative integer", flags.json);
        }
        const services = flags._.slice(1);
        const stream = flags.project !== undefined
          ? engine.logsProject(flags.project, {
              services,
              follow: flags.follow,
              tail: flags.tail,
            })
          : engine.logs(cwd, {
              services,
              follow: flags.follow,
              tail: flags.tail,
            });
        const nameWidth = Math.max(8, ...services.map((name) => name.length));
        for await (const line of stream) {
          if (flags.json) {
            process.stdout.write(JSON.stringify(line) + "\n");
          } else {
            const text = line.meta ? `[hestia] ${line.text}` : line.text;
            process.stdout.write(`${line.service.padEnd(nameWidth)} │ ${text}\n`);
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
      case "tui": {
        if (flags.json) fail("usage", "hestia tui does not support --json", true);
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          fail("usage", "hestia tui requires interactive stdin and stdout", false);
        }
        const { runFleetTui } = await import("@hestia/tui");
        await runFleetTui(cwd);
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
    if (err instanceof HestiaError) fail(err.code, err.message, flags.json, err.details);
    fail("internal", (err as Error).message ?? String(err), flags.json);
  }
}

main();
