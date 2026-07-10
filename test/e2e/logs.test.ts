import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogLine } from "../../packages/core/src/types.ts";
import { dockerAvailable } from "../../packages/engine/src/index.ts";

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");
const PROC_FIXTURE = join(import.meta.dir, "..", "fixtures", "proc-repo");

interface CliResult {
  code: number;
  stdout: string;
}

function runCli(cwd: string, args: string[]): CliResult {
  try {
    return {
      code: 0,
      stdout: execFileSync("bun", [CLI, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: (failure.stdout ?? "") + (failure.stderr ?? ""),
    };
  }
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
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

function parseNdjson(output: string): LogLine[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogLine);
}

function createLineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async function nextLine(timeoutMs = 10_000): Promise<string> {
    return Promise.race([
      (async () => {
        while (true) {
          const newline = buffered.indexOf("\n");
          if (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            return line;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("log follower ended before the expected line");
          buffered += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for CLI log line")), timeoutMs),
      ),
    ]);
  };
}

let tmpRoot: string;
let repoDir: string;
let worktree: string;
let project: string;

describe("hestia logs proc end-to-end", () => {
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-logs-e2e-"));
    repoDir = join(tmpRoot, "logsrepo");
    cpSync(PROC_FIXTURE, repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    worktree = join(tmpRoot, "logs-worktree");
    git(repoDir, ["worktree", "add", "-q", "-b", "logs-branch", worktree]);
  });

  afterAll(() => {
    if (project) runCli(tmpRoot, ["down", "--project", project]);
    if (worktree && existsSync(worktree)) runCli(worktree, ["down"]);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("backfills, follows across a fresh run, formats human output, and reads a deleted worktree mirror", async () => {
    const initialScript =
      "for (let i=1;i<=6;i++) console.log(`line-${i}`); setInterval(()=>{}, 60000)";
    const started = runCli(worktree, [
      "run", "--name", "chatty", "--no-port", "--no-daemon", "--json", "--",
      "bun", "-e", initialScript,
    ]);
    expect(started.code).toBe(0);
    project = (JSON.parse(started.stdout) as { project: string }).project;

    const backfill = parseNdjson(runCli(worktree, ["logs", "chatty", "--tail", "2", "--json"]).stdout);
    expect(backfill.map((line) => line.text)).toEqual(["line-5", "line-6"]);
    expect(backfill.every((line) => line.service === "chatty" && line.source === "proc")).toBe(true);
    const human = runCli(worktree, ["logs", "chatty", "--tail", "1"]);
    expect(human.stdout).toContain("chatty   │ line-6");

    const follower = Bun.spawn(
      ["bun", CLI, "logs", "chatty", "--tail", "1", "--follow", "--json"],
      { cwd: worktree, stdout: "pipe", stderr: "pipe" },
    );
    const nextLine = createLineReader(follower.stdout);
    expect((JSON.parse(await nextLine()) as LogLine).text).toBe("line-6");

    const replacementScript = "console.log('fresh'); setInterval(()=>{}, 60000)";
    const replaced = runCli(worktree, [
      "run", "--name", "chatty", "--no-port", "--no-daemon", "--json", "--",
      "bun", "-e", replacementScript,
    ]);
    expect(replaced.code).toBe(0);
    const afterRestart: LogLine[] = [];
    while (!afterRestart.some((line) => line.text === "fresh")) {
      afterRestart.push(JSON.parse(await nextLine()) as LogLine);
    }
    expect(afterRestart.some((line) => line.meta && line.text.includes("log reset"))).toBe(true);
    follower.kill("SIGTERM");
    await follower.exited;

    git(repoDir, ["worktree", "remove", "--force", worktree]);
    const mirrored = runCli(tmpRoot, ["logs", "chatty", "--project", project, "--json"]);
    expect(mirrored.code).toBe(0);
    expect(parseNdjson(mirrored.stdout)[0]).toMatchObject({
      service: "chatty",
      meta: true,
      text: "log file unavailable",
    });
  }, 60_000);
});

const hasDocker = await dockerAvailable();
const dockerSuite = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn("[e2e] docker not available — skipping docker log streaming test");

dockerSuite("hestia logs docker end-to-end", () => {
  let dockerRoot: string;
  let dockerProject = "";

  beforeAll(() => {
    dockerRoot = mkdtempSync(join(tmpdir(), "hestia-docker-logs-e2e-"));
    writeFileSync(
      join(dockerRoot, "docker-compose.yml"),
      `services:\n  db:\n    image: postgres:16-alpine\n    command: ["postgres", "-c", "log_statement=all"]\n    environment:\n      POSTGRES_PASSWORD: postgres\n    ports:\n      - "5432"\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 1s\n      timeout: 3s\n      retries: 30\n`,
    );
    git(dockerRoot, ["init", "-q"]);
    git(dockerRoot, ["add", "."]);
    git(dockerRoot, ["commit", "-q", "-m", "fixture"]);
  });

  afterAll(() => {
    if (dockerRoot) runCli(dockerRoot, ["down", "--destroy"]);
    if (dockerProject) runCli(tmpdir(), ["down", "--project", dockerProject, "--destroy"]);
    if (dockerRoot) rmSync(dockerRoot, { recursive: true, force: true });
  });

  test("streams label-only compose backfill and live output", async () => {
    const up = runCli(dockerRoot, ["up", "--no-daemon", "--json"]);
    expect(up.code).toBe(0);
    const stack = JSON.parse(up.stdout) as {
      project: string;
    };
    dockerProject = stack.project;
    const containerId = execFileSync(
      "docker",
      [
        "ps",
        "--filter", `label=com.docker.compose.project=${stack.project}`,
        "--filter", "label=com.docker.compose.service=db",
        "--format", "{{.ID}}",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(containerId).toBeTruthy();
    const backfill = runCli(dockerRoot, ["logs", "db", "--tail", "20", "--json"]);
    expect(backfill.code).toBe(0);
    expect(parseNdjson(backfill.stdout).some((line) => line.source === "docker")).toBe(true);

    const follower = Bun.spawn(
      ["bun", CLI, "logs", "db", "--tail", "0", "--follow", "--json"],
      { cwd: dockerRoot, stdout: "pipe", stderr: "pipe" },
    );
    const nextLine = createLineReader(follower.stdout);
    await Bun.sleep(500);
    execFileSync("docker", ["exec", containerId!, "psql", "-U", "postgres", "-c", "select 42"], {
      stdio: "ignore",
    });
    let live: LogLine;
    do live = JSON.parse(await nextLine()) as LogLine;
    while (!live.text.includes("statement: select 42"));
    expect(live.source).toBe("docker");
    follower.kill("SIGTERM");
    await follower.exited;
  }, 180_000);
});
