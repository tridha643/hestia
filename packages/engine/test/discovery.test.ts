import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepository } from "../src/discovery.ts";
import { initializeRepositoryConfig } from "../src/init-config.ts";
import { parseRepositoryWorkloadConfig } from "../src/repository-config.ts";
import { applyConfiguredEndpoints, engine } from "../src/index.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hestia-discovery-"));
  roots.push(root);
  process.env.HESTIA_HOME = join(root, "home");
  writeFileSync(
    join(root, "compose.yml"),
    [
      "services:",
      "  web:",
      "    image: nginx",
      "    ports:",
      "      - '3000'",
      "  db:",
      "    image: postgres",
      "    ports:",
      "      - '5432'",
      "",
    ].join("\n"),
  );
  mkdirSync(join(root, "test", "fixtures", "worker"), { recursive: true });
  writeFileSync(
    join(root, "test", "fixtures", "worker", "wrangler.toml"),
    'name = "not-a-real-workload"\n',
  );
  return root;
}

afterEach(() => {
  delete process.env.HESTIA_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository discovery", () => {
  test("finds Compose through the resolved model and excludes fixture workers", async () => {
    const root = fixture();
    const report = await discoverRepository(root);
    expect(report.runnableWorkloads.map((workload) => workload.name)).toEqual(["db", "web"]);
    expect(report.runnableWorkloads.find((workload) => workload.name === "web")?.bindings)
      .toContainEqual({ target: "3000", protocol: "tcp", configuredEndpoints: [] });
    expect(report.runnableWorkloads.some((workload) => workload.name === "not-a-real-workload"))
      .toBe(false);
  });

  test("init proposes without writing, then atomically writes explicit repository scope", async () => {
    const root = fixture();
    const path = join(root, "hestia.toml");
    const proposed = await initializeRepositoryConfig(
      root,
      { kind: "endpoint", alias: "dashboard", workload: "web", binding: "3000/tcp", endpointKind: "http" },
      "repository",
      false,
    );
    expect(proposed.written).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(proposed.proposed).toContain('[workloads."web".endpoints."dashboard"]');

    const written = await initializeRepositoryConfig(
      root,
      { kind: "endpoint", alias: "dashboard", workload: "web", binding: "3000/tcp", endpointKind: "http" },
      "repository",
      true,
    );
    expect(written.written).toBe(true);
    const parsed = parseRepositoryWorkloadConfig(readFileSync(path, "utf8"), path);
    expect(parsed.workloads.web?.source).toBe("compose");
    expect(parsed.workloads.web?.endpoints.dashboard).toEqual({
      binding: "3000/tcp",
      kind: "http",
      local: true,
    });
    const report = await discoverRepository(root);
    expect(report.runnableWorkloads.find((workload) => workload.name === "web")?.endpoints[0]?.source)
      .toBe("repository");
  });

  test("invalid and conflicting endpoint declarations fail explicitly", () => {
    expect(() => parseRepositoryWorkloadConfig([
      "version = 1",
      '[workloads."web"]',
      'source = "compose"',
      'compose_service = "web"',
      '[workloads."web".endpoints."dns"]',
      'binding = "53/udp"',
      'kind = "http"',
    ].join("\n"), "/repo/hestia.toml")).toThrow(/HTTP endpoints require a TCP binding/);
    expect(() => parseRepositoryWorkloadConfig([
      "version = 1",
      '[workloads."db"]',
      'source = "compose"',
      'compose_service = "db"',
      '[workloads."db".endpoints."database"]',
      'binding = "5432/tcp"',
      'kind = "tcp"',
      'local = true',
    ].join("\n"), "/repo/hestia.toml")).toThrow(/local routes require an HTTP endpoint/);
  });

  test("configured aliases retain the actual Compose service as owner", () => {
    const record = {
      schemaVersion: 1 as const,
      project: "repo-branch-0123456789",
      repo: "repo",
      branch: "branch",
      worktree: "/tmp/repo",
      state: "up" as const,
      services: [{
        name: "web",
        backend: "docker" as const,
        state: "healthy" as const,
        bindings: [{ id: "web:3000/tcp", target: "3000", protocol: "tcp" as const, publishedPort: 50001 }],
      }],
      env: {},
      endpoints: [],
      createdAt: new Date(0).toISOString(),
    };
    applyConfiguredEndpoints(record, {
      frontend: {
        source: "compose",
        composeService: "web",
        endpoints: { dashboard: { binding: "3000/tcp", kind: "http" } },
      },
    });
    expect(record.endpoints[0]?.workload).toBe("web");
    expect(record.endpoints[0]?.name).toBe("dashboard");
  });

  test("up runs an explicitly configured proc workload without Compose", async () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-configured-proc-"));
    roots.push(root);
    process.env.HESTIA_HOME = join(root, "home");
    await initializeRepositoryConfig(
      root,
      {
        kind: "proc",
        name: "consumer",
        command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
        port: "none",
      },
      "repository",
      true,
    );
    const record = await engine.up(root, { noDaemon: true });
    expect(record.services.find((service) => service.name === "consumer")?.state).toBe("healthy");
    await engine.down(root);
  });

  test("rejects normalized workload env-key collisions before startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-env-collision-"));
    roots.push(root);
    process.env.HESTIA_HOME = join(root, "home");
    writeFileSync(join(root, "hestia.toml"), [
      "version = 1",
      '[workloads."foo-bar"]',
      'source = "proc"',
      'command = ["true"]',
      'port = "none"',
      '[workloads."foo_bar"]',
      'source = "proc"',
      'command = ["true"]',
      'port = "none"',
    ].join("\n"));
    try {
      await engine.up(root, { noDaemon: true });
      throw new Error("expected env-key-conflict");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("env-key-conflict");
    }
  });
});
