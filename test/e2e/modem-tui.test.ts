import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { launchTerminal, type Session } from "tuistory";
import { stripJsonc } from "../../packages/engine/src/index.ts";

const HESTIA_ROOT = join(import.meta.dir, "..", "..");
const CLI = join(HESTIA_ROOT, "packages", "cli", "src", "index.ts");
const MODEM_REPOSITORY = process.env.HESTIA_E2E_MODEM_REPO;
const MODEM_ENV_FILE = process.env.HESTIA_E2E_MODEM_ENV_FILE;
const MODEM_REF = process.env.HESTIA_E2E_MODEM_REF ?? "HEAD";
const enabled = MODEM_REPOSITORY !== undefined;
const suite = enabled ? describe : describe.skip;

if (!enabled) {
  console.warn(
    "[e2e] HESTIA_E2E_MODEM_REPO is unset — skipping the real modem Fleet TUI ship gate",
  );
}

interface StackJson {
  project: string;
  env: Record<string, string>;
  services: Array<{ name: string; backend: string; publishedPort?: number }>;
}

let temporaryRoot = "";
let home = "";
let worktreeA = "";
let worktreeB = "";
let branchA = "";
let branchB = "";
let sourceStatus = "";
let packageManagerVersion = "";
let environment: Record<string, string> = {};
const projects = new Set<string>();

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hestia",
      GIT_AUTHOR_EMAIL: "hestia@test",
      GIT_COMMITTER_NAME: "hestia",
      GIT_COMMITTER_EMAIL: "hestia@test",
    },
  });
}

function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("bun", [CLI, ...args], {
    cwd,
    env: { ...process.env, ...environment, ...extraEnv },
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function redactedProcLogTail(worktree: string, service: string): string {
  const path = join(worktree, ".hestia", "logs", `${service}.log`);
  if (!existsSync(path)) return "(log file missing)";
  return readFileSync(path, "utf8")
    .slice(-32 * 1024)
    .split("\n")
    .slice(-60)
    .join("\n")
    .replace(/:\/\/[^@\s]+@/g, "://<redacted>@")
    .replace(/\b([A-Z][A-Z0-9_]{2,})=\S+/g, "$1=<redacted>")
    .replace(/\b[A-Za-z0-9_+\/-]{24,}={0,2}\b/g, "<redacted>");
}

function runModemWorkers(
  worktree: string,
  databaseUrl: string,
): StackJson {
  try {
    return JSON.parse(runCli(
      worktree,
      ["up", "--workers=ingest,slack", "--json"],
      {
        DATABASE_URL: databaseUrl,
        // Modem's health paths use the Hyperdrive binding connection string.
        // Wrangler's supported local override keeps both worktrees pointed at
        // their own Hestia-assigned Postgres port without editing modem files.
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_DO: databaseUrl,
      },
    )) as StackJson;
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nredacted modem-ingest log tail:\n` +
      redactedProcLogTail(worktree, "modem-ingest"),
    );
  }
}

function installModemDependencies(worktree: string): void {
  execFileSync(
    "corepack",
    [`pnpm@${packageManagerVersion}`, "install", "--frozen-lockfile", "--prefer-offline"],
    {
      cwd: worktree,
      env: { ...process.env, HUSKY: "0", CI: "1" },
      timeout: 15 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function copyModemEnvironment(worktree: string): void {
  if (MODEM_ENV_FILE === undefined || !existsSync(MODEM_ENV_FILE)) {
    throw new Error(
      "HESTIA_E2E_MODEM_ENV_FILE must point to an existing modem env file when the real gate is enabled",
    );
  }
  const destination = join(worktree, ".env");
  copyFileSync(MODEM_ENV_FILE, destination);
  chmodSync(destination, 0o600);
}

/**
 * Current modem refs define Slack Hyperdrive bindings only in deployed
 * environments. Promote the existing binding declarations in the disposable
 * test worktree so local Wrangler can expose env.HYPERDRIVE; the connection
 * itself is still forced to this worktree's ephemeral Postgres by environment.
 */
function prepareLocalSlackHyperdrive(worktree: string): void {
  const configPath = join(worktree, "apps", "slack", "wrangler.jsonc");
  const config = JSON.parse(stripJsonc(readFileSync(configPath, "utf8"))) as {
    hyperdrive?: unknown;
    env?: { staging?: { hyperdrive?: unknown } };
  };
  if (config.hyperdrive === undefined) {
    const deployedBindings = config.env?.staging?.hyperdrive;
    if (deployedBindings === undefined) {
      throw new Error(
        "modem Slack must declare Hyperdrive at top level or in env.staging",
      );
    }
    config.hyperdrive = deployedBindings;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

function servicePort(stack: StackJson, fragment: string): number {
  const service = stack.services.find((candidate) => candidate.name.includes(fragment));
  const port = service?.publishedPort;
  if (!Number.isInteger(port) || port! <= 0) {
    throw new Error(`modem service containing ${fragment} has no published port`);
  }
  return port!;
}

async function waitForHealth(
  worktree: string,
  service: string,
  port: number,
  timeoutMs = 90_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return response;
      lastError = new Error(
        `HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${service} health on port ${port} did not become ready: ${String(lastError)}\n` +
      `redacted ${service} log tail:\n${redactedProcLogTail(worktree, service)}`,
  );
}

async function waitForSnapshot(
  session: Session,
  predicate: (snapshot: string) => boolean,
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await session.text({ immediate: true });
    if (predicate(last)) return last;
    await session.waitIdle({ timeout: 100 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`real modem TUI snapshot timed out. Last frame:\n${last}`);
}

function removeProjectVolumes(project: string): void {
  const output = spawnSync(
    "docker",
    ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`],
    { encoding: "utf8" },
  );
  for (const volume of (output.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)) {
    spawnSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });
  }
}

suite("real modem Fleet TUI", () => {
  beforeAll(() => {
    if (!MODEM_REPOSITORY || !existsSync(MODEM_REPOSITORY)) {
      throw new Error("HESTIA_E2E_MODEM_REPO must point to an existing modem git checkout");
    }
    for (const command of ["docker", "corepack", "varlock", "bun", "git"]) {
      if (!commandExists(command)) throw new Error(`real modem TUI gate requires ${command} on PATH`);
    }
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    sourceStatus = git(MODEM_REPOSITORY, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const packageJson = JSON.parse(
      git(MODEM_REPOSITORY, ["show", `${MODEM_REF}:package.json`]),
    ) as { packageManager?: string };
    const manager = packageJson.packageManager?.match(/^pnpm@(.+)$/);
    if (!manager) throw new Error("selected modem ref must declare packageManager=pnpm@<version>");
    packageManagerVersion = manager[1]!;

    temporaryRoot = mkdtempSync(join(tmpdir(), "hestia-real-modem-tui-"));
    home = join(temporaryRoot, "home");
    worktreeA = join(temporaryRoot, "modem-a");
    worktreeB = join(temporaryRoot, "modem-b");
    const nonce = `${process.pid}-${Date.now().toString(36)}`;
    branchA = `hestia-tui-e2e-a-${nonce}`;
    branchB = `hestia-tui-e2e-b-${nonce}`;
    git(MODEM_REPOSITORY, ["worktree", "add", "-q", "-b", branchA, worktreeA, MODEM_REF]);
    git(MODEM_REPOSITORY, ["worktree", "add", "-q", "-b", branchB, worktreeB, MODEM_REF]);
    copyModemEnvironment(worktreeA);
    copyModemEnvironment(worktreeB);
    prepareLocalSlackHyperdrive(worktreeA);
    prepareLocalSlackHyperdrive(worktreeB);
    installModemDependencies(worktreeA);
    installModemDependencies(worktreeB);
    environment = {
      HESTIA_HOME: home,
      HESTIA_MAX_STACKS: "2",
      HESTIA_NO_OPEN: "1",
    };
  }, 30 * 60_000);

  afterAll(() => {
    for (const worktree of [worktreeA, worktreeB]) {
      if (worktree && existsSync(worktree)) {
        try { runCli(worktree, ["down", "--destroy"]); } catch {}
      }
    }
    if (temporaryRoot) {
      try { runCli(temporaryRoot, ["daemon", "stop"]); } catch {}
    }
    for (const project of projects) removeProjectVolumes(project);
    if (MODEM_REPOSITORY) {
      for (const worktree of [worktreeA, worktreeB]) {
        if (!worktree) continue;
        try { git(MODEM_REPOSITORY, ["worktree", "remove", "--force", worktree]); } catch {}
      }
      for (const branch of [branchA, branchB]) {
        if (!branch) continue;
        try { git(MODEM_REPOSITORY, ["branch", "-D", branch]); } catch {}
      }
      git(MODEM_REPOSITORY, ["worktree", "prune"]);
      expect(git(MODEM_REPOSITORY, ["status", "--porcelain=v1", "--untracked-files=all"]))
        .toBe(sourceStatus);
    }
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }, 10 * 60_000);

  test("projects two real modem stacks and safely tears one down", async () => {
    const composeA = JSON.parse(runCli(worktreeA, ["up", "--json"])) as StackJson;
    const composeB = JSON.parse(runCli(worktreeB, ["up", "--json"])) as StackJson;
    projects.add(composeA.project);
    projects.add(composeB.project);
    const postgresA = servicePort(composeA, "postgres");
    const postgresB = servicePort(composeB, "postgres");
    expect(postgresA).not.toBe(postgresB);
    const databaseA = `postgresql://postgres:postgres@127.0.0.1:${postgresA}/modem_dev`;
    const databaseB = `postgresql://postgres:postgres@127.0.0.1:${postgresB}/modem_dev`;

    const workersA = runModemWorkers(worktreeA, databaseA);
    const workersB = runModemWorkers(worktreeB, databaseB);
    const ingestA = servicePort(workersA, "ingest");
    const ingestB = servicePort(workersB, "ingest");
    const slackA = servicePort(workersA, "slack");
    const slackB = servicePort(workersB, "slack");
    expect(new Set([ingestA, ingestB, slackA, slackB]).size).toBe(4);
    await Promise.all([
      waitForHealth(worktreeA, "modem-ingest", ingestA),
      waitForHealth(worktreeB, "modem-ingest", ingestB),
      waitForHealth(worktreeA, "modem-slack", slackA),
      waitForHealth(worktreeB, "modem-slack", slackB),
    ]);

    const session = await launchTerminal({
      command: "bun",
      args: [CLI, "tui"],
      cwd: worktreeA,
      cols: 150,
      rows: 32,
      env: { ...process.env, ...environment },
    });
    try {
      await waitForSnapshot(
        session,
        (frame) => frame.includes("hestia-tui-e2e-a") && frame.includes("hestia-tui-e2e-b") && frame.includes("modem-ingest"),
      );

      const ingestUrlA = `http://127.0.0.1:${ingestA}`;
      runCli(worktreeA, [
        "run",
        "--name", "dashboard",
        "--varlock",
        "--env", `DATABASE_URL=${databaseA}`,
        "--env", `INGEST_URL=${ingestUrlA}`,
        "--json",
        "--",
        "corepack", `pnpm@${packageManagerVersion}`,
        "-F", "@modem/dashboard", "exec", "next", "dev", "-p", "{port}",
      ]);
      await waitForSnapshot(session, (frame) => frame.includes("dashboard"));
      for (let index = 0; index < 3; index += 1) await session.press("]");
      await waitForSnapshot(
        session,
        (frame) => frame.includes("Logs — dashboard") && /ready|started server|local:/i.test(frame),
        120_000,
      );

      await session.press("d");
      await session.waitForText("Named volumes are retained", { timeout: 5_000 });
      await session.press("esc");
      await waitForSnapshot(session, (frame) => !frame.includes("Confirm stack down"));
      await session.press("d");
      await session.press("enter");
      await waitForSnapshot(
        session,
        (frame) => !frame.includes(`Services — ${branchA}`) && frame.includes(branchB),
        180_000,
      );

      const retainedVolumes = execFileSync(
        "docker",
        ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${composeA.project}`],
        { encoding: "utf8" },
      ).trim();
      expect(retainedVolumes).not.toBe("");
      await Promise.all([
        waitForHealth(worktreeB, "modem-ingest", ingestB),
        waitForHealth(worktreeB, "modem-slack", slackB),
      ]);
      await session.press("q");
      await session.waitIdle({ timeout: 3_000 });
    } finally {
      session.close();
    }
  }, 30 * 60_000);
});
