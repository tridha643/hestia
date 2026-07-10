import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { connect } from "node:net";
import { HestiaError, type ProcSpec } from "@hestia/core";
import { allocatePort } from "../proc/ports.ts";
import { discoverWorkers, filterWorkers, type WorkerConfig } from "./discover.ts";

/** Per-worktree private dev registry — the isolation mechanism itself. */
export function privateRegistryDir(worktreeRoot: string): string {
  return join(worktreeRoot, ".hestia", "wrangler-registry");
}

/** Where an unwrapped wrangler/miniflare would register (and read bindings). */
export function globalRegistryDir(): string {
  return (
    process.env.WRANGLER_REGISTRY_PATH ??
    join(homedir(), ".wrangler", "config", "registry")
  );
}

const HEARTBEAT_FRESH_MS = 60_000;

function tcpConnectable(address: string, timeoutMs = 500): Promise<boolean> {
  const [host, portStr] = address.split(":");
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    const dead = () => {
      sock.destroy();
      resolve(false);
    };
    sock.once("error", dead);
    sock.once("timeout", dead);
  });
}

/**
 * Refuse to start a worker whose name is already live in the GLOBAL registry —
 * that's a manual `pnpm dev` (or another tool) in some worktree of this repo,
 * and running both means fighting over `.wrangler/state` (SQLITE_BUSY).
 * Registry entries carry no pid; liveness = heartbeat-fresh mtime, else a
 * connectable debug address.
 */
export async function preflightForeignSessions(
  workers: WorkerConfig[],
): Promise<void> {
  const dir = globalRegistryDir();
  if (!existsSync(dir)) return;
  for (const w of workers) {
    if (w.name === null) continue;
    const entryPath = join(dir, w.name);
    if (!existsSync(entryPath)) continue;
    const freshMs = Date.now() - statSync(entryPath).mtimeMs;
    let live = freshMs < HEARTBEAT_FRESH_MS;
    if (!live) {
      try {
        const entry = JSON.parse(readFileSync(entryPath, "utf8")) as {
          debugPortAddress?: string;
        };
        live = entry.debugPortAddress
          ? await tcpConnectable(entry.debugPortAddress)
          : false;
      } catch {
        live = false;
      }
    }
    if (live) {
      throw new HestiaError(
        "worktree-busy",
        `worker "${w.name}" is already registered in the global dev registry ` +
          `(${entryPath}) by a live non-hestia session — stop it or pass --force`,
      );
    }
  }
}

export interface WorkerPlan {
  specs: ProcSpec[];
  warnings: string[];
}

export interface WorkerPlanOptions {
  filter: string[];
  allowRemote: boolean;
  force: boolean;
  varlock: boolean;
}

/** Discover, gate, and turn wrangler configs into supervised ProcSpecs. */
export async function planWorkers(
  worktreeRoot: string,
  opts: WorkerPlanOptions,
): Promise<WorkerPlan> {
  const all = discoverWorkers(worktreeRoot);
  const matched = filterWorkers(all, worktreeRoot, opts.filter);
  if (matched.length === 0) {
    throw new HestiaError(
      "no-workers-found",
      opts.filter.length > 0
        ? `no wrangler configs match --workers=${opts.filter.join(",")}`
        : `no wrangler.{jsonc,json,toml} found in ${worktreeRoot}`,
    );
  }

  const bin = join(worktreeRoot, "node_modules", ".bin", "wrangler");
  if (!existsSync(bin)) {
    throw new HestiaError(
      "wrangler-missing",
      `no local wrangler at ${bin} — hestia never uses a global install`,
    );
  }

  const warnings: string[] = [];
  const named: WorkerConfig[] = [];
  for (const w of matched) {
    const rel = relative(worktreeRoot, w.configPath);
    if (w.name === null) {
      warnings.push(`skipping ${rel}: no top-level "name" in config`);
      continue;
    }
    if (w.hasRemote && !opts.allowRemote) {
      throw new HestiaError(
        "remote-binding-blocked",
        `${rel} declares remote bindings (talks to real Cloudflare resources) — ` +
          `pass --allow-remote to permit`,
      );
    }
    named.push(w);
  }
  if (named.length === 0) {
    throw new HestiaError(
      "no-workers-found",
      `all matched wrangler configs were skipped (no top-level name)`,
    );
  }

  if (!opts.force) await preflightForeignSessions(named);

  const registry = privateRegistryDir(worktreeRoot);
  const specs: ProcSpec[] = [];
  for (const w of named) {
    const inspectorPort = await allocatePort();
    specs.push({
      name: w.name!,
      // wrangler binary invoked directly — modem's package dev scripts use
      // `env -i` and pin inspector ports, so they must be bypassed.
      argv: [
        bin,
        "dev",
        "-c",
        w.configPath,
        "--port",
        "{port}",
        "--inspector-port",
        String(inspectorPort),
      ],
      env: {
        // both: wrangler reads WRANGLER_REGISTRY_PATH, the vite-plugin path
        // reads MINIFLARE_REGISTRY_PATH
        WRANGLER_REGISTRY_PATH: registry,
        MINIFLARE_REGISTRY_PATH: registry,
      },
      port: "auto",
      signal: "int",
      varlock: opts.varlock,
      backend: "wrangler",
      inspectorPort,
      configPath: w.configPath,
    });
  }
  return { specs, warnings };
}
