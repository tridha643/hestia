import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../../packages/engine/src/index.ts";

const available = await dockerAvailable();
const suite = available ? describe : describe.skip;
const cli = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");

suite("Dockerfile workload end-to-end", () => {
  let root: string;
  let home: string;
  let project = "";

  const run = (args: string[]): string => execFileSync("bun", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HESTIA_HOME: home },
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hestia-dockerfile-e2e-"));
    home = join(root, "home");
    writeFileSync(join(root, ".gitignore"), ".hestia/\n");
    writeFileSync(join(root, "Dockerfile"), "FROM nginx:alpine\n");
    writeFileSync(join(root, "hestia.toml"), [
      "version = 1",
      '[workloads."web"]',
      'source = "dockerfile"',
      'dockerfile = "Dockerfile"',
      '[workloads."web".endpoints."dashboard"]',
      'binding = "80/tcp"',
      'kind = "http"',
      "local = false",
      "",
    ].join("\n"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", [
      "-c", "user.name=hestia", "-c", "user.email=hestia@test",
      "commit", "-q", "-m", "fixture",
    ], { cwd: root });
  });

  afterAll(() => {
    try { run(["down", "--destroy"]); } catch {}
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("builds the generated Compose fragment and publishes a configured alias", async () => {
    const record = JSON.parse(run(["up", "--no-daemon", "--json"])) as {
      project: string;
      endpoints: Array<{ name: string; url?: string }>;
    };
    project = record.project;
    const endpoint = record.endpoints.find((candidate) => candidate.name === "dashboard");
    expect(endpoint?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(endpoint!.url!, { signal: AbortSignal.timeout(5_000) });
    expect(response.status).toBe(200);
  }, 180_000);

  test("down --destroy removes the built image", () => {
    expect(project).not.toBe("");
    const builtBefore = execFileSync(
      "docker",
      ["images", "-q", "--filter", `reference=${project}-*`],
      { encoding: "utf8" },
    ).trim();
    expect(builtBefore).not.toBe("");
    run(["down", "--destroy"]);
    const builtAfter = execFileSync(
      "docker",
      ["images", "-q", "--filter", `reference=${project}-*`],
      { encoding: "utf8" },
    ).trim();
    expect(builtAfter).toBe("");
  }, 180_000);
});
