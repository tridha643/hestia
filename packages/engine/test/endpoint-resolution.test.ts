import { describe, expect, test } from "bun:test";
import { resolveEndpointSelection } from "../src/endpoint-resolution.ts";
import type { StackRecord } from "@hestia/core";

const record: StackRecord = {
  schemaVersion: 1,
  project: "repo-branch-0123456789",
  repo: "repo",
  branch: "branch",
  worktree: "/tmp/worktree",
  state: "up",
  services: [{
    name: "api",
    backend: "docker",
    state: "healthy",
    bindings: [
      { id: "api:8080/tcp", target: "8080", protocol: "tcp", publishedPort: 50001 },
      { id: "api:9090/tcp", target: "9090", protocol: "tcp", publishedPort: 50002 },
    ],
  }],
  env: {},
  endpoints: [{
    name: "metrics",
    alias: "metrics",
    workload: "api",
    binding: "9090/tcp",
    kind: "http",
    host: "127.0.0.1",
    port: 50002,
    url: "http://127.0.0.1:50002",
  }],
  createdAt: new Date(0).toISOString(),
};

describe("endpoint resolution", () => {
  test("prefers exact aliases and accepts canonical selectors", () => {
    expect(resolveEndpointSelection(record, "metrics").binding).toBe("9090/tcp");
    expect(resolveEndpointSelection(record, "api:8080/tcp").endpoint.port).toBe(50001);
  });

  test("rejects an ambiguous workload with canonical choices", () => {
    try {
      resolveEndpointSelection(record, "api");
      throw new Error("expected ambiguity");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("service-port-ambiguous");
      expect((error as { details?: { selectors?: string[] } }).details?.selectors).toEqual([
        "api:8080/tcp",
        "api:9090/tcp",
      ]);
    }
  });
});
