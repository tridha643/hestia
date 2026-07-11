import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer, type Server as NetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION, type RepoId, type StackRecord } from "@hestia/core";
import { startTimeOf } from "../src/proc/pidfile.ts";
import { ensureDir, mirrorDir, writeState } from "../src/state.ts";
import {
  effectiveLocalRouteServices,
  localRouteHostname,
  readHestiaMachineConfig,
  resolveLocalRouteHostnames,
} from "../src/router/router-config.ts";
import {
  HestiaLocalHttpRouter,
  internalEndpointAuthority,
  resolvedLocalRouteHostname,
} from "../src/router/local-http-router.ts";

const homes: string[] = [];

function useTemporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hestia-router-test-"));
  homes.push(home);
  process.env.HESTIA_HOME = home;
  return home;
}

function sampleRecord(worktree: string, port: number): StackRecord {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    project: "modem-salem",
    repoId: "repo-0123456789abcdef" as RepoId,
    repo: "modem",
    branch: "feat/router",
    worktree,
    state: "up",
    services: [{
      name: "dashboard",
      backend: "proc",
      state: "healthy",
      publishedPort: port,
      pid: process.pid,
      startTime: startTimeOf(process.pid)!,
    }],
    env: { HESTIA_DASHBOARD_PORT: String(port) },
    endpoints: [{ name: "dashboard", host: "127.0.0.1", port }],
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  delete process.env.HESTIA_HOME;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("machine-local router TOML", () => {
  test("parses repository defaults and renders collision-safe hostnames", () => {
    const home = useTemporaryHome();
    writeFileSync(join(home, "config.toml"), `
version = 1
max_stacks = 7
[router]
hostname_template = "{service}.{branch}.{repo}.localhost"
[router.repositories."repo-0123456789abcdef"]
name = "modem"
services = ["dashboard", "modem-ingest"]
`);
    const result = readHestiaMachineConfig();
    expect(result.valid).toBe(true);
    expect(result.config.maxStacks).toBe(7);
    const record = sampleRecord("/tmp/modem-salem", 40123);
    record.repo = "checkout-folder-name";
    expect(effectiveLocalRouteServices(record, result.config)).toEqual(["dashboard", "modem-ingest"]);
    expect(localRouteHostname(record, "dashboard", result.config)).toMatch(
      /^dashboard\.feat-router-[a-f0-9]{6}\.modem\.localhost$/,
    );
    expect(localRouteHostname(record, "api_v1", result.config)).not.toBe(
      localRouteHostname(record, "api-v1", result.config),
    );
  });

  test("invalid router config disables defaults with an actionable warning", () => {
    const home = useTemporaryHome();
    writeFileSync(join(home, "config.toml"), `version = 1\nmax_stacks = 9\n[router]\nhostname_template = "{service}.localhost"\n`);
    const result = readHestiaMachineConfig();
    expect(result.valid).toBe(false);
    expect(result.config.maxStacks).toBe(9);
    expect(result.config.router.repositories).toEqual({});
    expect(result.warnings[0]).toContain("must contain {branch}");
  });

  test("rejects unknown keys instead of silently accepting configuration typos", () => {
    const home = useTemporaryHome();
    writeFileSync(join(home, "config.toml"), `version = 1\nmax_stack = 9\n`);
    const result = readHestiaMachineConfig();
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain('unknown key "max_stack"');
  });

  test("slugs and bounds labels after expanding a combined template", () => {
    const home = useTemporaryHome();
    writeFileSync(join(home, "config.toml"), `
version = 1
[router]
hostname_template = "{service}-{branch}.{repo}.localhost"
`);
    const record = sampleRecord("/tmp/modem-salem", 40123);
    record.branch = `Feature/${"Long Branch ".repeat(8)}`;
    const hostname = localRouteHostname(record, "Dashboard API", readHestiaMachineConfig().config);
    expect(hostname.endsWith(".modem.localhost")).toBe(true);
    expect(hostname.split(".").every((label) => label.length <= 63)).toBe(true);
    expect(hostname).toMatch(/^[a-z0-9.-]+$/);
  });

  test("adds stable identity hashes so future collisions cannot rename routes", () => {
    useTemporaryHome();
    const first = sampleRecord("/tmp/clone-a", 40123);
    const second = sampleRecord("/tmp/clone-b", 40124);
    first.localRoutes = [{ service: "dashboard" }];
    second.localRoutes = [{ service: "dashboard" }];
    second.project = "modem-salem-clone";
    second.repoId = "repo-fedcba9876543210" as RepoId;
    const hostnames = [...resolveLocalRouteHostnames([first, second]).values()];
    expect(hostnames[0]).not.toBe(hostnames[1]);
    expect(hostnames.every((hostname) => /^dashboard-[a-f0-9]{6}\./.test(hostname))).toBe(true);
    expect(resolveLocalRouteHostnames([first]).get(`${first.project}\0dashboard`)).toBe(hostnames[0]);
  });
});

describe("hestiad local HTTP router", () => {
  test("routes configured services, rewrites Host, and rejects unknown names", async () => {
    const home = useTemporaryHome();
    const origin = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          host: request.headers.host,
          path: request.url,
          body: body.length < 1_000 ? body : undefined,
          bodyBytes: Buffer.byteLength(body),
          forwardedHost: request.headers["x-forwarded-host"],
          forwardedProto: request.headers["x-forwarded-proto"],
          forwardedFor: request.headers["x-forwarded-for"],
          forwardedUser: request.headers["x-forwarded-user"],
          internalAuth: request.headers["x-internal-auth"],
        }));
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const address = origin.address();
    const originPort = typeof address === "object" && address ? address.port : 0;
    const worktree = join(home, "worktree");
    const record = sampleRecord(worktree, originPort);
    record.localRoutes = [{ service: "dashboard" }];
    ensureDir(worktree);
    writeState(worktree, record);
    expect(mirrorDir(record.project)).toContain(home);

    const router = new HestiaLocalHttpRouter();
    const routerPort = await router.start();
    let websocketOrigin: NetServer | undefined;
    try {
      const hostname = resolvedLocalRouteHostname(record, "dashboard");
      const portlessRoutes = JSON.parse(readFileSync(
        join(home, "router", "portless", "aliases.json"),
        "utf8",
      )) as Array<{ hostname: string; port: number; pid: number; startTime?: string }>;
      expect(portlessRoutes).toContainEqual({
        hostname,
        pid: process.pid,
        startTime: startTimeOf(process.pid),
        port: routerPort,
      });
      const response = await fetch(`http://127.0.0.1:${routerPort}/health?q=1`, {
        method: "POST",
        headers: {
          host: hostname,
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-user": "attacker@example.test",
          connection: "X-Internal-Auth",
          "x-internal-auth": "attacker",
        },
        body: "streamed-body",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        host: `127.0.0.1:${originPort}`,
        path: "/health?q=1",
        body: "streamed-body",
        bodyBytes: 13,
        forwardedHost: hostname,
        forwardedProto: "https",
        forwardedFor: "127.0.0.1",
        forwardedUser: undefined,
        internalAuth: undefined,
      });

      const malformedHost = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: "127.0.0.1", port: routerPort });
        let received = "";
        client.once("connect", () => client.write(
          `GET / HTTP/1.1\r\nHost: ${hostname}:443:attacker\r\nConnection: close\r\n\r\n`,
        ));
        client.on("data", (chunk) => { received += chunk.toString("utf8"); });
        client.once("end", () => resolve(received));
        client.once("error", reject);
      });
      expect(malformedHost).toContain("400 Bad Request");

      const largeBody = "x".repeat(256 * 1024);
      const streamed = await fetch(`http://127.0.0.1:${routerPort}/stream`, {
        method: "POST",
        headers: { host: hostname },
        body: largeBody,
      });
      expect(await streamed.json()).toMatchObject({ bodyBytes: largeBody.length });

      let upgradeRequest = "";
      websocketOrigin = createNetServer((originSocket) => {
        originSocket.once("data", (chunk) => {
          upgradeRequest = chunk.toString("utf8");
          originSocket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        });
      });
      await new Promise<void>((resolve) => websocketOrigin!.listen(0, "127.0.0.1", resolve));
      const websocketAddress = websocketOrigin.address();
      const websocketPort = typeof websocketAddress === "object" && websocketAddress ? websocketAddress.port : 0;
      record.services[0]!.publishedPort = websocketPort;
      record.endpoints[0]!.port = websocketPort;
      writeState(worktree, record);
      await router.refreshRoutes();

      const upgradeResponse = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: "127.0.0.1", port: routerPort });
        let received = "";
        client.setTimeout(1_000, () => reject(new Error("routed WebSocket response timed out")));
        client.once("connect", () => client.write(
          `GET /socket HTTP/1.1\r\nHost: ${hostname}\r\n` +
          "Connection: Upgrade, X-Internal-Auth\r\nUpgrade: websocket\r\n" +
          "X-Internal-Auth: attacker\r\n" +
          "X-Forwarded-User: attacker@example.test\r\n" +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ));
        client.on("data", (chunk) => { received += chunk.toString("utf8"); });
        client.once("end", () => resolve(received));
        client.once("error", reject);
      });
      expect(upgradeRequest.toLowerCase()).toContain(`host: 127.0.0.1:${websocketPort}`);
      expect(upgradeRequest.toLowerCase()).not.toContain("x-forwarded-user");
      expect(upgradeRequest.toLowerCase()).not.toContain("x-internal-auth");
      expect(upgradeResponse).toContain("101 Switching Protocols");

      const missing = await fetch(`http://127.0.0.1:${routerPort}/`, {
        headers: { host: "missing.salem.modem.localhost" },
      });
      expect(missing.status).toBe(404);
    } finally {
      router.stop();
      websocketOrigin?.close();
      origin.close();
    }
  });

  test("Unix gateway returns 503 before a recycled foreign port receives bytes", async () => {
    const home = useTemporaryHome();
    let foreignBytes = 0;
    const foreign = createNetServer((socket) => {
      socket.on("data", (chunk) => { foreignBytes += chunk.byteLength; });
    });
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const address = foreign.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const worktree = join(home, "worktree");
    const record = sampleRecord(worktree, port);
    // This is the post-crash state: the recorded origin identity is dead but
    // another process has already recycled its old port.
    record.services[0]!.pid = 999_999;
    record.services[0]!.startTime = "dead origin";
    ensureDir(worktree);
    writeState(worktree, record);

    const router = new HestiaLocalHttpRouter();
    await router.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          socketPath: router.socketPath,
          path: "/",
          headers: { host: internalEndpointAuthority(record.project, "dashboard") },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.setTimeout(2_000, () => request.destroy(new Error("gateway request timed out")));
        request.once("error", reject);
        request.end();
      });
      expect(status).toBe(503);
      expect(foreignBytes).toBe(0);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
      router.stop();
    }
  }, 15_000);
});
