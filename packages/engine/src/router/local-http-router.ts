import { execFile } from "node:child_process";
import { Agent, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { slug, type ServiceRecord, type StackRecord } from "@hestia/core";
import { isLive } from "../proc/pidfile.ts";
import { inspectPort } from "../proc/ports.ts";
import { hestiaHome, parseStackRecord } from "../state.ts";
import {
  effectiveLocalRouteServices,
  effectiveLocalRoutes,
  localRouteKey,
  localRouteHostname,
  readHestiaMachineConfig,
  resolveLocalRouteHostnames,
  type HestiaMachineConfig,
} from "./router-config.ts";
import { reconcilePortlessAliases } from "./portless-adapter.ts";

const pexec = promisify(execFile);
const ROUTE_REFRESH_MS = 1_000;
const MAX_MIRROR_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_HEADER_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

interface LocalRouterTarget {
  hostname: string;
  project: string;
  service?: ServiceRecord;
  agent?: Agent;
}

class OriginOwnershipError extends Error {}

export function readRouterStackRecords(): StackRecord[] {
  const stacksDir = join(hestiaHome(), "stacks");
  if (!existsSync(stacksDir)) return [];
  const records: StackRecord[] = [];
  for (const project of readdirSync(stacksDir).sort()) {
    const path = join(stacksDir, project, "stack.json");
    try {
      const source = readFileSync(path);
      if (source.byteLength > MAX_MIRROR_BYTES) continue;
      const record = parseStackRecord(source.toString("utf8"), path);
      if (record.project === project) records.push(record);
    } catch {}
  }
  return records;
}

/** Resolve one route against all mirrored peers so collision hashes stay consistent. */
export function resolvedLocalRouteHostname(
  record: StackRecord,
  service: string,
  config: HestiaMachineConfig = readHestiaMachineConfig().config,
): string {
  const records = readRouterStackRecords().filter((candidate) => candidate.project !== record.project);
  records.push(record);
  return resolveLocalRouteHostnames(records, config).get(localRouteKey(record, service)) ??
    localRouteHostname(record, service, config);
}

function parseRouteAuthority(authority: string | undefined): string | null {
  const match = authority?.trim().match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i);
  if (match === null || match === undefined) return null;
  const hostname = match[1]!.toLowerCase();
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (hostname.includes("..") || hostname.split(".").some((label) => label.length > 63)) return null;
  if (port !== undefined && (port < 1 || port > 65_535)) return null;
  return hostname;
}

function connectionHeaderTokens(value: string | string[] | undefined): Set<string> {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return new Set(values.flatMap((entry) => entry.split(","))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token)));
}

function forwardedHeaders(request: IncomingMessage, originPort: number): IncomingMessage["headers"] {
  const headers = { ...request.headers };
  const connectionNames = connectionHeaderTokens(request.headers.connection);
  for (const name of Object.keys(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || connectionNames.has(name) || name.startsWith("x-forwarded-")) {
      delete headers[name];
    }
  }
  const incomingHost = request.headers.host ?? "";
  // Dev origins commonly reject unknown hosts. Connect and present loopback to the
  // origin while preserving the stable user-facing hostname in X-Forwarded-Host.
  headers.host = `127.0.0.1:${originPort}`;
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["x-forwarded-for"];
  headers["x-forwarded-host"] = incomingHost;
  headers["x-forwarded-proto"] = "https";
  const remote = request.socket.remoteAddress;
  if (remote) headers["x-forwarded-for"] = remote;
  return headers;
}

async function verifyDockerRouteTarget(target: LocalRouterTarget, port: number): Promise<boolean> {
  try {
    const service = target.service!;
    const args = [
      "ps", "--no-trunc", "--format", "{{.ID}}\t{{.Ports}}",
      "--filter", `label=dev.hestia.stack=${target.project}`,
      "--filter", `label=com.docker.compose.service=${service.name}`,
    ];
    const { stdout } = await pexec("docker", args, { timeout: 2_000 });
    return stdout.split("\n").some((line) => {
      const [id, ports = ""] = line.split("\t");
      const identityMatches = service.containerId === undefined || id?.startsWith(service.containerId);
      return identityMatches && new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}->`).test(ports);
    });
  } catch {
    return false;
  }
}

async function verifyLocalRouterTarget(target: LocalRouterTarget): Promise<number | null> {
  const service = target.service;
  const port = service?.publishedPort;
  if (service === undefined || port === undefined || service.backend === "tunnel") return null;
  if (service.backend === "docker") {
    return await verifyDockerRouteTarget(target, port) ? port : null;
  }
  if (service.pid === undefined || service.startTime === undefined) return null;
  if (!isLive({ pid: service.pid, startTime: service.startTime })) return null;
  try {
    return (await inspectPort(service.pid, port)).ownerIsMember ? port : null;
  } catch {
    return null;
  }
}

/** Verify one persisted service still owns its direct loopback origin. */
export async function verifyStackServiceOrigin(
  record: StackRecord,
  service: ServiceRecord,
  publishedPort = service.publishedPort,
): Promise<boolean> {
  return await verifyLocalRouterTarget({
    hostname: "",
    project: record.project,
    service: { ...service, publishedPort },
  }) !== null;
}

function targetIdentity(target: LocalRouterTarget): string {
  const service = target.service;
  return [target.project, service?.name, service?.backend, service?.publishedPort,
    service?.pid, service?.startTime, service?.containerId].join("\0");
}

function verifiedOriginAgent(target: LocalRouterTarget, port: number): Agent {
  if (target.agent !== undefined) return target.agent;
  const agent = new Agent({ keepAlive: true, maxSockets: 32 });
  agent.createConnection = ((
    _options: unknown,
    callback: (error: Error | null, socket?: Socket) => void,
  ) => {
    let settled = false;
    const finish = (error: Error | null, socket?: Socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      // No request bytes are written until the Agent receives this callback.
      // Verify after connect so a recycled listener cannot win the gap between
      // ownership inspection and socket establishment.
      void verifyLocalRouterTarget(target).then((verifiedPort) => {
        if (verifiedPort !== port) {
          socket.destroy();
          finish(new OriginOwnershipError("route origin ownership changed"));
          return;
        }
        finish(null, socket);
      }).catch((error) => {
        socket.destroy();
        finish(error as Error);
      });
    });
    socket.once("error", (error) => finish(error));
    return undefined;
  }) as typeof agent.createConnection;
  target.agent = agent;
  return agent;
}

export function internalEndpointAuthority(project: string, service: string): string {
  const serviceLabel = slug(service).slice(0, 32);
  const hash = createHash("sha256").update(`${project}\0${service}`).digest("hex").slice(0, 10);
  return `${serviceLabel}-${hash}.hestia.internal`;
}

export function publicGatewaySocketPath(): string {
  const uid = process.getuid?.() ?? 501;
  const homeHash = createHash("sha256").update(hestiaHome()).digest("hex").slice(0, 12);
  return join(tmpdir(), `hestia-${uid}`, homeHash, "origin.sock");
}

function prepareGatewaySocket(path: string): void {
  const uid = process.getuid?.();
  const directories = [join(tmpdir(), `hestia-${uid ?? 501}`), join(tmpdir(), `hestia-${uid ?? 501}`, createHash("sha256").update(hestiaHome()).digest("hex").slice(0, 12))];
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error(`unsafe Hestia gateway runtime directory ${directory}`);
    }
    chmodSync(directory, 0o700);
  }
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isSocket() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`refusing unsafe existing Hestia gateway socket ${path}`);
  }
  rmSync(path);
}

function sendRouterResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-hestia-router": "1" });
  response.end(`${message}\n`);
}

/** Hestiad-owned loopback HTTP and WebSocket router for stable local URLs. */
export class HestiaLocalHttpRouter {
  readonly #server = createServer((request, response) => void this.#proxyHttp(request, response));
  readonly #frontServer = createNetServer((socket) => this.#acceptFrontSocket(socket));
  readonly #unixServer = createNetServer((socket) => this.#acceptFrontSocket(socket));
  #targets = new Map<string, LocalRouterTarget>();
  #timer?: ReturnType<typeof setInterval>;

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    prepareGatewaySocket(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.#unixServer.once("error", reject);
      this.#unixServer.listen(this.socketPath, () => {
        this.#unixServer.off("error", reject);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#frontServer.once("error", reject);
      this.#frontServer.listen(0, "127.0.0.1", () => {
        this.#frontServer.off("error", reject);
        resolve();
      });
    });
    await this.refreshRoutes();
    this.#timer = setInterval(() => void this.refreshRoutes().catch((error) => {
      console.error(`router: periodic route refresh failed: ${(error as Error).message}`);
    }), ROUTE_REFRESH_MS);
    this.#timer.unref?.();
    return this.port;
  }

  get port(): number {
    const address = this.#frontServer.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  get socketPath(): string {
    return publicGatewaySocketPath();
  }

  /** Rebuild route targets from mirrors plus machine TOML and reconcile Portless aliases. */
  async refreshRoutes(): Promise<void> {
    const configResult = readHestiaMachineConfig();
    const targets = new Map<string, LocalRouterTarget>();
    const records = readRouterStackRecords();
    const hostnames = resolveLocalRouteHostnames(records, configResult.config);
    for (const record of records) {
      for (const route of effectiveLocalRoutes(record, configResult.config)) {
        const hostname = hostnames.get(localRouteKey(record, route.name));
        if (hostname === undefined) continue;
        const originalService = record.services.find((service) => service.name === route.service);
        const selectedBinding = route.selector === undefined
          ? undefined
          : originalService?.bindings?.find(
              (binding) => `${binding.target}/${binding.protocol}` === route.selector,
            );
        const candidate: LocalRouterTarget = {
          hostname,
          project: record.project,
          service: originalService === undefined
            ? undefined
            : { ...originalService, publishedPort: selectedBinding?.publishedPort ?? originalService.publishedPort },
        };
        const previous = this.#targets.get(hostname);
        targets.set(hostname, previous !== undefined && targetIdentity(previous) === targetIdentity(candidate)
          ? previous
          : candidate);
      }
      for (const endpoint of record.endpoints) {
        const service = record.services.find((candidate) =>
          candidate.name === (endpoint.workload ?? endpoint.name));
        const binding = service?.bindings?.find((candidate) =>
          `${candidate.target}/${candidate.protocol}` === endpoint.binding);
        const publishedPort = binding?.publishedPort ?? service?.publishedPort;
        if (service === undefined || service.backend === "tunnel" || publishedPort === undefined) continue;
        const authority = internalEndpointAuthority(record.project, endpoint.alias ?? endpoint.name);
        targets.set(authority, {
          hostname: authority,
          project: record.project,
          service: { ...service, publishedPort },
        });
      }
      for (const exposure of record.tunnel?.exposures ?? []) {
        const hostname = exposure.keepHostHeader
          ? exposure.hostname
          : internalEndpointAuthority(record.project, exposure.alias ?? exposure.service);
        const originalService = record.services.find((service) => service.name === exposure.service);
        const selectedBinding = originalService?.bindings?.find((binding) =>
          `${binding.target}/${binding.protocol}` === exposure.binding);
        targets.set(hostname, {
          hostname,
          project: record.project,
          service: originalService === undefined ? undefined : {
            ...originalService,
            publishedPort: selectedBinding?.publishedPort ?? originalService.publishedPort,
          },
        });
      }
    }
    reconcilePortlessAliases([...targets.keys()], this.port);
    for (const [hostname, target] of this.#targets) {
      if (targets.get(hostname) !== target) target.agent?.destroy();
    }
    this.#targets = targets;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    try {
      reconcilePortlessAliases([], this.port);
    } catch (error) {
      console.error(`router: alias cleanup failed: ${(error as Error).message}`);
    }
    for (const target of this.#targets.values()) target.agent?.destroy();
    this.#frontServer.close();
    this.#unixServer.close();
    rmSync(this.socketPath, { force: true });
    this.#server.close();
  }

  #acceptFrontSocket(socket: Socket): void {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_REQUEST_HEADER_BYTES) {
        socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
        return;
      }
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.pause();
      socket.off("data", onData);
      const header = buffered.subarray(0, boundary + 4).toString("latin1");
      if (/\r\nupgrade:\s*websocket\s*\r\n/i.test(header)) {
        void this.#proxyWebSocket(socket, header, buffered.subarray(boundary + 4));
      } else {
        this.#proxyFrontHttp(socket, buffered);
      }
    };
    socket.on("data", onData);
  }

  #proxyFrontHttp(socket: Socket, buffered: Buffer): void {
    const address = this.#server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const internal = createConnection({ host: "127.0.0.1", port });
    internal.once("connect", () => {
      internal.write(buffered);
      socket.pipe(internal).pipe(socket);
      socket.resume();
    });
    internal.once("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
    socket.once("error", () => internal.destroy());
  }

  async #proxyHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const hostname = parseRouteAuthority(request.headers.host);
    if (hostname === null) return sendRouterResponse(response, 400, "Malformed Host authority");
    const target = this.#targets.get(hostname);
    if (target === undefined) return sendRouterResponse(response, 404, "Hestia route not found");
    const port = target.service?.publishedPort;
    if (port === undefined) return sendRouterResponse(response, 503, "Hestia route origin unavailable");
    if (await verifyLocalRouterTarget(target) !== port) {
      return sendRouterResponse(response, 503, "Hestia route origin unavailable");
    }
    const proxy = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request, port),
      agent: verifiedOriginAgent(target, port),
    }, (origin) => {
      const headers = { ...origin.headers };
      for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
      response.writeHead(origin.statusCode ?? 502, headers);
      origin.on("error", () => response.destroy());
      origin.on("aborted", () => response.destroy());
      response.on("error", () => origin.destroy());
      origin.pipe(response);
    });
    proxy.on("error", (error) => {
      if (!response.headersSent) {
        const ownershipFailure = error instanceof OriginOwnershipError;
        sendRouterResponse(
          response,
          ownershipFailure ? 503 : 502,
          ownershipFailure ? "Hestia route origin unavailable" : "Hestia route origin failed",
        );
      }
      else response.destroy();
    });
    request.pipe(proxy);
  }

  async #proxyWebSocket(socket: Socket, header: string, head: Buffer): Promise<void> {
    const hostHeaders = [...header.matchAll(/\r\nhost:\s*([^\r\n]+)/gi)];
    const incomingHost = hostHeaders.length === 1 ? hostHeaders[0]![1]!.trim() : undefined;
    const host = parseRouteAuthority(incomingHost);
    if (host === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = this.#targets.get(host);
    const port = target?.service?.publishedPort;
    if (target === undefined || port === undefined) {
      socket.end(`HTTP/1.1 ${target === undefined ? "404 Not Found" : "503 Service Unavailable"}\r\n\r\n`);
      return;
    }
    const rawHeaderLines = header.slice(0, -4).split("\r\n");
    const connectionValues = rawHeaderLines.slice(1)
      .filter((line) => /^connection:/i.test(line))
      .map((line) => line.slice(line.indexOf(":") + 1));
    const connectionNames = connectionHeaderTokens(connectionValues);
    const retainedHeaders = rawHeaderLines.slice(1).filter((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) return false;
      const name = line.slice(0, separator).trim().toLowerCase();
      return name !== "host" && !HOP_BY_HOP_HEADERS.has(name) &&
        !connectionNames.has(name) && !name.startsWith("x-forwarded-");
    });
    const rewrittenHeader = [
      rawHeaderLines[0]!,
      ...retainedHeaders,
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `X-Forwarded-Host: ${incomingHost}`,
      "X-Forwarded-Proto: https",
      `X-Forwarded-For: ${socket.remoteAddress ?? "127.0.0.1"}`,
      "",
      "",
    ].join("\r\n");
    const originSocket = createConnection({ host: "127.0.0.1", port });
    originSocket.once("connect", async () => {
      const verifiedPort = await verifyLocalRouterTarget(target);
      if (verifiedPort !== port) {
        originSocket.destroy();
        socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        return;
      }
      socket.pipe(originSocket).pipe(socket);
      originSocket.write(rewrittenHeader, "latin1");
      if (head.length) originSocket.write(head);
      socket.resume();
    });
    originSocket.once("error", () => {
      if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    socket.once("error", () => originSocket.destroy());
  }
}
