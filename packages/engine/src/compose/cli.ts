import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HestiaError } from "@hestia/core";

const pexec = promisify(execFile);

export interface ComposeCtx {
  project: string;
  baseFile: string;
  overrideFile: string;
  cwd: string;
}

export interface ResolvedComposePort {
  target: number | string;
  published?: string;
  protocol?: string;
  host_ip?: string;
  mode?: string;
}

export interface ResolvedComposeService {
  ports?: ResolvedComposePort[];
  depends_on?: Record<string, unknown>;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean }>;
}

export interface ResolvedComposeModel {
  services: Record<string, ResolvedComposeService>;
  networks?: Record<string, { name?: string; external?: boolean }>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}

/** compose service row from `ps --format json`. */
export interface PsService {
  ID?: string;
  Service: string;
  State: string;
  Health: string;
  Publishers?: Array<{
    URL?: string;
    TargetPort: number;
    PublishedPort: number;
    Protocol?: string;
  }>;
}

function composeArgs(ctx: ComposeCtx, rest: string[]): string[] {
  return [
    "compose",
    "-p",
    ctx.project,
    "-f",
    ctx.baseFile,
    "-f",
    ctx.overrideFile,
    ...rest,
  ];
}

async function docker(
  ctx: ComposeCtx,
  rest: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await pexec("docker", composeArgs(ctx, rest), {
      cwd: ctx.cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new HestiaError(
      "compose-failed",
      `docker compose ${rest.join(" ")} failed: ${
        (e.stderr || e.message || "").trim() || "unknown error"
      }`,
    );
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await pexec("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve interpolation, profiles, dependencies, ports, and resource names before overrides. */
export async function resolveComposeModel(
  project: string,
  baseFile: string,
  cwd: string,
): Promise<ResolvedComposeModel> {
  try {
    const { stdout } = await pexec(
      "docker",
      ["compose", "-p", project, "-f", baseFile, "config", "--format", "json"],
      { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const value = JSON.parse(stdout) as Partial<ResolvedComposeModel>;
    if (typeof value.services !== "object" || value.services === null) {
      throw new Error("resolved model has no services table");
    }
    return value as ResolvedComposeModel;
  } catch (error) {
    if (error instanceof HestiaError) throw error;
    const err = error as { stderr?: string; message?: string };
    throw new HestiaError(
      "compose-failed",
      `docker compose config --format json failed: ${(err.stderr || err.message || "unknown error").trim()}`,
    );
  }
}

/** Validate the merged compose model before creating anything. */
export async function composeConfig(ctx: ComposeCtx): Promise<void> {
  await docker(ctx, ["config", "--quiet"], 30_000);
}

export async function composeUp(ctx: ComposeCtx, services: string[]): Promise<void> {
  await docker(ctx, ["up", "-d", ...services]);
}

export async function composeDown(
  ctx: ComposeCtx,
  destroy: boolean,
): Promise<void> {
  const rest = ["down", "--remove-orphans"];
  if (destroy) rest.push("-v");
  await docker(ctx, rest);
}

/** Parse `ps --format json`, tolerating both a JSON array and NDJSON. */
export async function composePs(ctx: ComposeCtx): Promise<PsService[]> {
  const { stdout } = await docker(ctx, ["ps", "--all", "--format", "json"], 30_000);
  const text = stdout.trim();
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as PsService[];
    return [parsed as PsService];
  } catch {
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as PsService);
  }
}

function serviceReady(row: PsService): boolean {
  if (row.Health === "healthy") return true;
  // no healthcheck -> "ready" once running
  if ((row.Health ?? "") === "" && row.State === "running") return true;
  return false;
}

/** Poll until every required service is ready, or throw on timeout. */
export async function waitReady(
  ctx: ComposeCtx,
  services: string[],
  timeoutMs = 120_000,
): Promise<PsService[]> {
  const deadline = Date.now() + timeoutMs;
  let last: PsService[] = [];
  while (Date.now() < deadline) {
    last = await composePs(ctx);
    const byName = new Map(last.map((r) => [r.Service, r]));
    const allReady = services.every((s) => {
      const row = byName.get(s);
      return row !== undefined && serviceReady(row);
    });
    if (allReady) return last;
    const failed = services.find((s) => byName.get(s)?.State === "exited");
    if (failed) {
      throw new HestiaError(
        "service-exited",
        `service "${failed}" exited before becoming ready`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new HestiaError(
    "ready-timeout",
    `services did not become ready within ${Math.round(
      timeoutMs / 1000,
    )}s: ${services
      .map((s) => {
        const row = last.find((r) => r.Service === s);
        return `${s}=${row ? row.Health || row.State : "missing"}`;
      })
      .join(", ")}`,
  );
}

/**
 * Read back the Docker-assigned host port for a service's container port.
 * With no containerPort, returns the first publisher's port.
 */
export function publishedPortFor(
  row: PsService | undefined,
  containerPort?: number,
  protocol?: "tcp" | "udp",
): number | undefined {
  const pubs = (row?.Publishers ?? []).filter((p) => p.PublishedPort > 0);
  if (pubs.length === 0) return undefined;
  if (containerPort !== undefined) {
    const match = pubs.find((p) =>
      p.TargetPort === containerPort &&
      (protocol === undefined || (p.Protocol ?? "tcp").toLowerCase() === protocol)
    );
    if (match) return match.PublishedPort;
  }
  return pubs[0]!.PublishedPort;
}
