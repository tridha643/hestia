import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProc } from "../src/proc/supervisor.ts";
import { stopProcTree } from "../src/proc/shutdown.ts";

const roots: string[] = [];
const running: Array<Awaited<ReturnType<typeof startProc>>["pidfile"]> = [];

afterEach(async () => {
  for (const pidfile of running.splice(0)) await stopProcTree(pidfile);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("HTTP readiness", () => {
  test("waits beyond port ownership until the configured path returns 2xx", async () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-http-ready-"));
    roots.push(root);
    writeFileSync(join(root, "server.ts"), [
      "const started = Date.now();",
      "Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch(request) {",
      "  const healthy = Date.now() - started > 900;",
      "  return new Response(healthy ? 'ok' : 'warming', { status: healthy ? 200 : 503 });",
      "} });",
      "setTimeout(() => {}, 30000);",
    ].join("\n"));
    const started = Date.now();
    const result = await startProc(root, {
      name: "health-server",
      argv: ["bun", "server.ts", "{port}"],
      healthPath: "/health",
      readyTimeoutMs: 10_000,
    }, {});
    running.push(result.pidfile);

    expect(result.error).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  });

  test("substitutes the assigned port into configured environment values", async () => {
    const root = mkdtempSync(join(tmpdir(), "hestia-env-port-"));
    roots.push(root);
    writeFileSync(join(root, "server.ts"), [
      "await Bun.write('self-url.txt', process.env.SELF_URL ?? 'missing');",
      "Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch: () => new Response('ok') });",
      "setTimeout(() => {}, 30000);",
    ].join("\n"));
    const result = await startProc(root, {
      name: "self-url-server",
      argv: ["bun", "server.ts", "{port}"],
      env: { SELF_URL: "http://127.0.0.1:{port}" },
      readyTimeoutMs: 10_000,
    }, {});
    running.push(result.pidfile);

    expect(readFileSync(join(root, "self-url.txt"), "utf8"))
      .toBe(`http://127.0.0.1:${result.record.publishedPort}`);
  });
});
