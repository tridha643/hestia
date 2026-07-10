import { describe, expect, test } from "bun:test";
import {
  brokerWireParsers,
  parseSessionRegistrationEnvelope,
  parseSessionSnapshotEnvelope,
} from "@hunk/session-broker-core";
import { SessionBroker, createSessionBrokerDaemon } from "@hunk/session-broker";
import { serveSessionBrokerDaemon } from "@hunk/session-broker-bun";

/**
 * Pins the vendored session-broker behaviors hestiad's design depends on
 * (see packages/VENDORED.md). If an upstream re-sync changes any of these,
 * this file fails loudly instead of hestiad silently self-terminating or
 * 404-ing its own routes.
 */

interface Info {
  title: string;
}
interface State {
  n: number;
}

function createBroker() {
  return new SessionBroker<Info, State>({
    parseRegistration: (value) =>
      parseSessionRegistrationEnvelope(value, (v) => {
        const r = brokerWireParsers.asRecord(v);
        const title = r ? brokerWireParsers.parseRequiredString(r.title) : null;
        return title === null ? null : { title };
      }),
    parseSnapshot: (value) =>
      parseSessionSnapshotEnvelope(value, (v) => {
        const r = brokerWireParsers.asRecord(v);
        const n = r ? brokerWireParsers.parseNonNegativeInt(r.n) : null;
        return n === null ? null : { n };
      }),
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("vendored session-broker behavior pins", () => {
  test("idleTimeoutMs: 0 disables idle shutdown (and a positive value does not)", async () => {
    // Positive control first: a tiny idle timeout with zero sessions shuts down.
    const timed = createSessionBrokerDaemon({ broker: createBroker(), idleTimeoutMs: 20 });
    const timedStopped = await Promise.race([
      timed.stopped.then(() => true),
      settle(500).then(() => false),
    ]);
    expect(timedStopped).toBe(true);

    // 0 must mean DISABLED, not instant: the daemon outlives the same window.
    const forever = createSessionBrokerDaemon({ broker: createBroker(), idleTimeoutMs: 0 });
    const foreverStopped = await Promise.race([
      forever.stopped.then(() => true),
      settle(500).then(() => false),
    ]);
    expect(foreverStopped).toBe(false);
    forever.shutdown();
  });

  test("stale-session sweep at zero sessions never shuts the daemon down", async () => {
    const daemon = createSessionBrokerDaemon({
      broker: createBroker(),
      idleTimeoutMs: 0,
      staleSessionTtlMs: 5,
      staleSessionSweepIntervalMs: 5,
    });
    await settle(100); // many sweep ticks with nothing to prune
    const stopped = await Promise.race([
      daemon.stopped.then(() => true),
      settle(10).then(() => false),
    ]);
    expect(stopped).toBe(false);
    expect(daemon.getHealth().sessions).toBe(0);
    daemon.shutdown();
  });

  test("custom handleRequest runs before broker routes; undefined falls through", async () => {
    const daemon = createSessionBrokerDaemon({ broker: createBroker(), idleTimeoutMs: 0 });
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port: 0,
      handleRequest: (request) => {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/hestia/")) {
          return Response.json({ custom: true });
        }
        return undefined; // everything else falls through to the broker
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const custom = await fetch(`${base}/hestia/ping`);
      expect(custom.status).toBe(200);
      expect(await custom.json()).toEqual({ custom: true });

      // /health must still be the broker's, not shadowed and not 404.
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { ok: boolean; sessions: number };
      expect(body.ok).toBe(true);
      expect(body.sessions).toBe(0);

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test("custom handleRequest streams a Response and propagates request cancellation", async () => {
    const daemon = createSessionBrokerDaemon({ broker: createBroker(), idleTimeoutMs: 0 });
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const server = serveSessionBrokerDaemon({
      daemon,
      hostname: "127.0.0.1",
      port: 0,
      handleRequest: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
              interval = setInterval(() => {
                controller.enqueue(new TextEncoder().encode("tick\n"));
              }, 10);
            },
            cancel() {
              cancelled = true;
              clearInterval(interval);
            },
          }),
        ),
    });
    try {
      const requestController = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/stream`, {
        signal: requestController.signal,
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
      requestController.abort();
      for (let attempt = 0; attempt < 50 && !cancelled; attempt++) await settle(10);
      expect(cancelled).toBe(true);
    } finally {
      clearInterval(interval);
      server.stop(true);
      daemon.shutdown();
    }
  });
});
