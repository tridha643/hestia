#!/usr/bin/env bun
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const MAX_LOG_BYTES = 25 * 1024 * 1024;
const ARCHIVE_COUNT = 3;
const RELAY_SPEC_ENV = "HESTIA_PROC_RELAY_SPEC";

interface RelaySpec {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logPath: string;
}

function relaySpec(): RelaySpec {
  const encoded = process.env[RELAY_SPEC_ENV];
  delete process.env[RELAY_SPEC_ENV];
  if (encoded === undefined) throw new Error(`${RELAY_SPEC_ENV} is missing`);
  const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as RelaySpec;
  if (!Array.isArray(value.argv) || value.argv.length === 0 ||
    typeof value.cwd !== "string" || typeof value.logPath !== "string") {
    throw new Error("invalid proc relay spec");
  }
  return value;
}

export class RotatingLogWriter {
  #fd: number;
  #bytes: number;

  constructor(
    readonly path: string,
    readonly maxLogBytes = MAX_LOG_BYTES,
    readonly archiveCount = ARCHIVE_COUNT,
  ) {
    this.#fd = openSync(path, "a", 0o600);
    chmodSync(path, 0o600);
    this.#bytes = statSync(path).size;
  }

  write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#bytes >= this.maxLogBytes) this.rotate();
      const length = Math.min(chunk.byteLength - offset, this.maxLogBytes - this.#bytes);
      writeSync(this.#fd, chunk, offset, length);
      offset += length;
      this.#bytes += length;
    }
  }

  close(): void {
    closeSync(this.#fd);
  }

  private rotate(): void {
    closeSync(this.#fd);
    rmSync(`${this.path}.${this.archiveCount}`, { force: true });
    for (let index = this.archiveCount - 1; index >= 1; index -= 1) {
      const source = `${this.path}.${index}`;
      if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    this.#fd = openSync(this.path, "a", 0o600);
    chmodSync(this.path, 0o600);
    this.#bytes = 0;
  }
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {}
}

async function main(): Promise<void> {
  const spec = relaySpec();
  const writer = new RotatingLogWriter(spec.logPath);
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => writer.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => writer.write(chunk));
  process.on("SIGTERM", () => forwardSignal(child, "SIGTERM"));
  process.on("SIGINT", () => forwardSignal(child, "SIGINT"));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      writer.write(Buffer.from(`hestia proc relay: ${error.message}\n`));
      resolve({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  writer.close();
  if (result.signal !== null) process.exit(1);
  process.exit(result.code ?? 1);
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`hestia proc relay failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
