import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTerminal, type Session } from "tuistory";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "packages", "cli", "src", "index.ts");
const FIXTURE = join(ROOT, "test", "fixtures", "proc-repo");

let temporaryRoot: string;
let repository: string;
let worktreeA: string;
let worktreeB: string;
let environment: Record<string, string>;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hestia",
      GIT_AUTHOR_EMAIL: "hestia@test",
      GIT_COMMITTER_NAME: "hestia",
      GIT_COMMITTER_EMAIL: "hestia@test",
    },
  });
}

function runCli(cwd: string, args: string[]): string {
  return execFileSync("bun", [CLI, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startChatty(worktree: string, name: string, marker: string): void {
  const script = [
    `console.log(${JSON.stringify(marker + " ready")});`,
    "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch(){console.log('" +
      marker +
      " live request');return new Response('ok')}});",
  ].join("");
  runCli(worktree, ["run", "--name", name, "--json", "--", "bun", "-e", script]);
}

async function waitForSnapshot(
  session: Session,
  predicate: (snapshot: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await session.text({ immediate: true });
    if (predicate(last)) return last;
    await session.waitIdle({ timeout: 50 });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fleet PTY snapshot timed out. Last frame:\n${last}`);
}

describe("hestia tui PTY", () => {
  beforeAll(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "hestia-fleet-pty-"));
    repository = join(temporaryRoot, "repo");
    cpSync(FIXTURE, repository, { recursive: true });
    git(repository, ["init", "-q"]);
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "fixture"]);
    worktreeA = join(temporaryRoot, "worktree-a");
    worktreeB = join(temporaryRoot, "worktree-b");
    git(repository, ["worktree", "add", "-q", "-b", "pty-a", worktreeA]);
    git(repository, ["worktree", "add", "-q", "-b", "pty-b", worktreeB]);
    environment = {
      HESTIA_HOME: join(temporaryRoot, "home"),
      HESTIA_MAX_STACKS: "5",
      HESTIA_NO_OPEN: "1",
    };
    startChatty(worktreeA, "chatty", "worktree-a");
    startChatty(worktreeB, "chatty", "worktree-b");
  });

  afterAll(() => {
    for (const worktree of [worktreeA, worktreeB]) {
      if (worktree && existsSync(worktree)) {
        try { runCli(worktree, ["down", "--destroy"]); } catch {}
      }
    }
    if (temporaryRoot) {
      try { runCli(temporaryRoot, ["daemon", "stop"]); } catch {}
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("renders, resizes, reconnects, streams logs, and confirms safe down", async () => {
    const session = await launchTerminal({
      command: "bun",
      args: [CLI, "tui"],
      cwd: worktreeA,
      cols: 130,
      rows: 28,
      env: { ...process.env, ...environment },
    });
    try {
      let frame = await waitForSnapshot(
        session,
        (snapshot) => snapshot.includes("pty-a") && snapshot.includes("pty-b") && snapshot.includes("worktree-a ready"),
      );
      expect(frame).toContain("chatty");

      session.resize({ cols: 88, rows: 28 });
      frame = await waitForSnapshot(session, (snapshot) => snapshot.includes("pty-a") && snapshot.includes("Logs"));
      expect(frame).toContain("worktree-a ready");

      const discovery = JSON.parse(
        readFileSync(join(environment.HESTIA_HOME, "daemon", "daemon.json"), "utf8"),
      ) as { pid: number };
      process.kill(discovery.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 250));
      startChatty(worktreeB, "web2", "worktree-b-web2");
      await session.press("down");
      await waitForSnapshot(session, (snapshot) => snapshot.includes("web2"), 15_000);
      await session.press("up");
      await waitForSnapshot(session, (snapshot) => snapshot.includes("Workloads — pty-a"));

      await session.press("d");
      await session.waitForText("Named volumes are retained", { timeout: 3_000 });
      await session.press("esc");
      frame = await waitForSnapshot(session, (snapshot) => !snapshot.includes("Confirm stack down"));
      expect(frame).toContain("pty-a");

      await session.press("d");
      await session.press("enter");
      frame = await waitForSnapshot(
        session,
        (snapshot) => !snapshot.includes("Workloads — pty-a") && snapshot.includes("Workloads — pty-b"),
        15_000,
      );
      expect(frame).toContain("named volumes retained");

      await session.press("q");
      await session.waitIdle({ timeout: 2_000 });
    } finally {
      session.close();
    }
  }, 60_000);

  test("q and Ctrl-C restore the primary terminal before the shell continues", async () => {
    for (const exitKey of ["q", ["ctrl", "c"]] as const) {
      const shellCommand = `bun '${CLI.replaceAll("'", "'\\''")}' tui; printf '\\n__HESTIA_PRIMARY_SCREEN__\\n'`;
      const session = await launchTerminal({
        command: "/bin/sh",
        args: ["-c", shellCommand],
        cwd: worktreeB,
        cols: 100,
        rows: 24,
        env: { ...process.env, ...environment },
      });
      try {
        await session.waitForText("Hestia Fleet", { timeout: 10_000 });
        await session.press(exitKey as "q" | ["ctrl", "c"]);
        const restored = await session.waitForText("__HESTIA_PRIMARY_SCREEN__", { timeout: 5_000 });
        expect(restored).not.toContain("Hestia Fleet");
      } finally {
        session.close();
      }
    }
  }, 30_000);

  test("non-TTY launch fails before emitting alternate-screen bytes", () => {
    const result = spawnSync("bun", [CLI, "tui"], {
      cwd: worktreeB,
      env: { ...process.env, ...environment },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires interactive stdin and stdout");
    expect(`${result.stdout}${result.stderr}`).not.toContain("\x1b[?1049h");
  });
});
