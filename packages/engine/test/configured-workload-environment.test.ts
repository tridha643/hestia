import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackRecord } from "@hestia/core";
import {
  resolveConfiguredEnvironment,
  resolveEndpointTemplate,
} from "../src/configured-workload-environment.ts";
import { parseRepositoryWorkloadConfig, renderRepositoryWorkloadConfig } from "../src/repository-config.ts";

const roots: string[] = [];

function stackRecord(root: string): StackRecord {
  return {
    schemaVersion: 1,
    project: "repo-branch-0123456789",
    repo: "repo",
    branch: "branch",
    worktree: root,
    state: "up",
    services: [],
    env: {},
    endpoints: [{ name: "database", host: "127.0.0.1", port: 54321 }],
    createdAt: new Date(0).toISOString(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("configured workload environment", () => {
  test("renders and parses endpoint templates plus ignored file inputs", () => {
    const parsed = parseRepositoryWorkloadConfig([
      "version = 1",
      '[workloads."web"]',
      'source = "proc"',
      'command = ["bun", "run", "dev"]',
      'cwd = "apps/web"',
      "varlock = true",
      'health_path = "/health"',
      'env.DATABASE_URL = "postgresql://dev@${endpoint:database.host}:${endpoint:database.port}/app"',
      'env.READONLY_KEY = { file = ".hestia/keys/readonly.jwk" }',
    ].join("\n"), "/repo/hestia.toml");

    expect(parsed.workloads.web).toMatchObject({
      cwd: "apps/web",
      varlock: true,
      healthPath: "/health",
      env: {
        DATABASE_URL: "postgresql://dev@${endpoint:database.host}:${endpoint:database.port}/app",
        READONLY_KEY: { file: ".hestia/keys/readonly.jwk" },
      },
    });
    expect(parseRepositoryWorkloadConfig(renderRepositoryWorkloadConfig(parsed), "roundtrip")).toEqual(parsed);
  });

  test("resolves endpoint fields and reads only ignored worktree files", () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-config-env-"));
    roots.push(root);
    mkdirSync(join(root, ".hestia", "keys"), { recursive: true });
    writeFileSync(join(root, ".hestia", "keys", "readonly.jwk"), "secret-json\n");
    const record = stackRecord(root);

    expect(resolveConfiguredEnvironment(root, {
      DATABASE_URL: "postgresql://dev@${endpoint:database.host}:${endpoint:database.port}/app",
      READONLY_KEY: { file: ".hestia/keys/readonly.jwk" },
    }, record)).toEqual({
      DATABASE_URL: "postgresql://dev@127.0.0.1:54321/app",
      READONLY_KEY: "secret-json",
    });
    expect(() => resolveEndpointTemplate("${endpoint:missing.url}", record))
      .toThrow(/before that endpoint is available/);
    expect(() => resolveEndpointTemplate("${endpoint:database}", record))
      .toThrow(/malformed endpoint template/);
  });

  test("rejects file inputs outside .hestia", () => {
    expect(() => parseRepositoryWorkloadConfig([
      "version = 1",
      '[workloads."web"]',
      'source = "proc"',
      'command = ["true"]',
      'env.SECRET = { file = "../secret" }',
    ].join("\n"), "/repo/hestia.toml")).toThrow(/below \.hestia/);
  });
});
