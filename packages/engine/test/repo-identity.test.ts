import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engine, getRepoInfo, writeAtomicJsonFile } from "../src/index.ts";
import { assertMutableStackRecord, parseStackRecord } from "../src/state.ts";

const scratchRoots: string[] = [];

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
  }).trim();
}

function createRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "fixture"]);
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

describe("repository Fleet identity", () => {
  test("is shared by linked worktrees and distinct across same-name clones", async () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-repo-id-"));
    scratchRoots.push(root);
    const first = join(root, "one", "same-name");
    const second = join(root, "two", "same-name");
    createRepository(first);
    createRepository(second);
    const linked = join(root, "linked");
    git(first, ["worktree", "add", "-q", "-b", "linked", linked]);

    const firstInfo = await getRepoInfo(first);
    const nested = join(first, "nested", "directory");
    mkdirSync(nested, { recursive: true });
    const nestedInfo = await getRepoInfo(nested);
    const linkedInfo = await getRepoInfo(linked);
    const secondInfo = await getRepoInfo(second);
    expect(firstInfo.repoId).toBe(linkedInfo.repoId);
    expect(firstInfo.repoId).toBe(nestedInfo.repoId);
    expect(firstInfo.repoId).not.toBe(secondInfo.repoId);
    expect(firstInfo.repo).toBe(secondInfo.repo);
  });
});

describe("atomic JSON publication", () => {
  test("always leaves complete parseable mode-0600 files", () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-atomic-json-"));
    scratchRoots.push(root);
    const path = join(root, "nested", "state.json");
    for (let sequence = 0; sequence < 100; sequence += 1) {
      writeAtomicJsonFile(path, { sequence, payload: "x".repeat(sequence) });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        sequence,
        payload: "x".repeat(sequence),
      });
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("versioned stack state", () => {
  const baseRecord = {
    project: "repo-branch-0123456789",
    repo: "repo",
    branch: "branch",
    worktree: "/tmp/worktree",
    state: "up",
    services: [],
    env: {},
    endpoints: [],
    createdAt: new Date(0).toISOString(),
  };

  test("rejects malformed and structurally invalid state with its path", () => {
    for (const source of ["{", JSON.stringify({ ...baseRecord, services: null })]) {
      try {
        parseStackRecord(source, "/state/stack.json");
        throw new Error("expected state-corrupt");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("state-corrupt");
        expect((error as Error).message).toContain("/state/stack.json");
      }
    }
  });

  test("legacy state stays readable but is mutation-blocked", () => {
    const legacy = parseStackRecord(JSON.stringify(baseRecord), "/legacy/stack.json");
    expect(legacy.schemaVersion).toBeUndefined();
    try {
      assertMutableStackRecord(legacy, "/legacy/stack.json");
      throw new Error("expected migration-required");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("migration-required");
    }
  });

  test("schema v1 state is mutable", () => {
    const current = parseStackRecord(
      JSON.stringify({ ...baseRecord, schemaVersion: 1 }),
      "/current/stack.json",
    );
    expect(() => assertMutableStackRecord(current, "/current/stack.json")).not.toThrow();
  });

  test("down --project removes a corrupt mirror through label-only recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-corrupt-down-"));
    scratchRoots.push(root);
    const previous = process.env.HESTIA_HOME;
    process.env.HESTIA_HOME = join(root, "home");
    const project = "repo-branch-0123456789";
    const mirror = join(process.env.HESTIA_HOME, "stacks", project);
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, "stack.json"), "{broken");
    try {
      await engine.downProject(project);
      expect(() => readFileSync(join(mirror, "stack.json"))).toThrow();
    } finally {
      if (previous === undefined) delete process.env.HESTIA_HOME;
      else process.env.HESTIA_HOME = previous;
    }
  });
});
