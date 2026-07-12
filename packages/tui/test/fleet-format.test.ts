import { describe, expect, test } from "bun:test";
import type { FleetStackView, RepoId } from "@hestia/core";
import { buildEnvBlock, formatUptime } from "../src/fleet-format.ts";

const base = Date.parse("2026-07-12T12:00:00.000Z");

describe("formatUptime", () => {
  test("scales units with age and drops zero remainders", () => {
    expect(formatUptime(new Date(base - 45_000).toISOString(), base)).toBe("45s");
    expect(formatUptime(new Date(base - 12 * 60_000).toISOString(), base)).toBe("12m");
    expect(formatUptime(new Date(base - (3 * 60 + 12) * 60_000).toISOString(), base)).toBe("3h12m");
    expect(formatUptime(new Date(base - 3 * 3_600_000).toISOString(), base)).toBe("3h");
    expect(formatUptime(new Date(base - 50 * 3_600_000).toISOString(), base)).toBe("2d2h");
    expect(formatUptime("not-a-date", base)).toBeUndefined();
  });
});

describe("buildEnvBlock", () => {
  test("mirrors the engine key derivation and skips tunnel connectors", () => {
    const stack: FleetStackView = {
      project: "modem-alpha",
      repoId: "repo-1234567890abcdef" as RepoId,
      repo: "modem",
      branch: "alpha",
      worktree: "/tmp/alpha",
      phase: "up",
      services: [
        {
          name: "web-app",
          backend: "proc",
          state: "healthy",
          publishedPort: 4100,
          endpoints: [{
            name: "web-app",
            host: "127.0.0.1",
            port: 4100,
            url: "http://127.0.0.1:4100",
            localUrl: "http://web.alpha.localhost",
            publicUrl: "https://alpha.dev.example.com",
          }],
        },
        {
          name: "db",
          backend: "docker",
          state: "healthy",
          publishedPort: 41203,
          endpoints: [{ name: "db-admin", host: "127.0.0.1", port: 41209 }],
        },
        { name: "expose", backend: "tunnel", state: "healthy", publishedPort: 999 },
      ],
    };
    expect(buildEnvBlock(stack).split("\n")).toEqual([
      "HESTIA_WEB_APP_PORT=4100",
      "HESTIA_WEB_APP_URL=https://alpha.dev.example.com",
      "HESTIA_WEB_APP_LOCAL_URL=http://web.alpha.localhost",
      "HESTIA_WEB_APP_DIRECT_URL=http://127.0.0.1:4100",
      "HESTIA_DB_PORT=41203",
      "HESTIA_DB_MAIN_TCP_PORT=41203",
      "HESTIA_DB_ADMIN_PORT=41209",
    ]);
  });

  test("returns an empty block when nothing is published", () => {
    const stack: FleetStackView = {
      project: "modem-queued",
      repoId: "repo-1234567890abcdef" as RepoId,
      repo: "modem",
      branch: "queued",
      worktree: "/tmp/queued",
      phase: "queued",
      services: [],
    };
    expect(buildEnvBlock(stack)).toBe("");
  });
});
