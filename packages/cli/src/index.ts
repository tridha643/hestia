#!/usr/bin/env bun
import { engine } from "@hestia/engine";
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
    out.push(`  ● ${s.name.padEnd(12)} ${s.backend.padEnd(7)} ${port.padEnd(20)} ${s.state}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

const HELP = `hestia — per-worktree isolated dev stacks

usage:
  hestia up   [--services a,b] [--workers[=a,b]] [--allow-remote] [--force]
              [--no-varlock] [--json]
        compose stack up; --workers also supervises one \`wrangler dev\` per
        discovered wrangler config (private dev registry per worktree)
  hestia run --name <name> [--env K=V ...] [--no-port] [--varlock]
             [--signal term|int] [--ready-timeout <s>] [--cwd <rel>] [--json]
             -- <command...>
        supervise a host process in this worktree's stack; {port} in the
        command and $PORT in its env carry the assigned port ({{port}} escapes)
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
        const r = await engine.run(cwd, spec);
        if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        else printStackHuman(r);
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
            process.stdout.write(`${e.name.padEnd(12)} ${e.host}:${e.port}  (${e.reservedName})\n`);
          }
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
