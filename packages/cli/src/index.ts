#!/usr/bin/env bun
import { engine } from "@hestia/engine";
import { HestiaError, type StackRecord } from "@hestia/core";

interface Flags {
  json: boolean;
  destroy: boolean;
  services?: string[];
  _: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { json: false, destroy: false, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") f.json = true;
    else if (a === "--destroy") f.destroy = true;
    else if (a === "--services") f.services = (argv[++i] ?? "").split(",").filter(Boolean);
    else f._.push(a);
  }
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

const HELP = `hestia — per-worktree isolated dev stacks (MVP)

usage:
  hestia up   [--services a,b] [--json]   bring up this worktree's compose stack
  hestia down [--destroy] [--json]        tear down (--destroy also removes volumes)
  hestia status [--json]                  show this worktree's stack
  hestia env  [--json]                    print the injected env (export lines by default)
  hestia endpoint list [--json]           list endpoints
`;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cmd = flags._[0];
  const cwd = process.cwd();

  try {
    switch (cmd) {
      case "up": {
        const r = await engine.up(cwd, flags.services ? { services: flags.services } : undefined);
        if (flags.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        else printStackHuman(r);
        break;
      }
      case "down": {
        await engine.down(cwd, { destroy: flags.destroy });
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
