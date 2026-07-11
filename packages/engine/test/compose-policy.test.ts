import { describe, expect, test } from "bun:test";
import { generateOverride } from "../src/compose/override.ts";
import { expandComposeDependencies, validateResolvedComposeModel } from "../src/index.ts";

describe("strict resolved Compose policy", () => {
  test("expands selected services through transitive dependencies", () => {
    const model = {
      services: {
        web: { depends_on: { api: { condition: "service_started" } } },
        api: { depends_on: { db: { condition: "service_healthy" } } },
        db: {},
        unrelated: {},
      },
    };
    expect(expandComposeDependencies(model, ["web"])).toEqual(["web", "api", "db"]);
  });

  test("preserves UDP and TCP as distinct target bindings", () => {
    const result = generateOverride({
      userCompose: {
        services: {
          dns: { ports: [{ target: 53, protocol: "udp" }, { target: 53, protocol: "tcp" }] },
        },
      },
      project: "repo-branch-0123456789",
      repo: "repo",
      branch: "branch",
      worktree: "/tmp/worktree",
      services: ["dns"],
    });
    expect(result.serviceBindings.dns).toEqual([
      { target: 53, protocol: "udp" },
      { target: 53, protocol: "tcp" },
    ]);
    expect(result.yaml).toContain("127.0.0.1:0:53/udp");
    expect(result.yaml).toContain("127.0.0.1:0:53/tcp");
  });

  test("rejects ranges, host modes, external resources, and global names", () => {
    const unsupported = [
      { services: { web: { ports: [{ target: "8000-8002" }] } } },
      { services: { web: { network_mode: "host" } } },
      { services: { web: {} }, networks: { shared: { external: true } } },
      { services: { web: {} }, volumes: { data: { name: "global-data" } } },
    ];
    for (const model of unsupported) {
      try {
        validateResolvedComposeModel(model, "repo-branch-0123456789");
        throw new Error("expected compose-unsupported");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("compose-unsupported");
      }
    }
  });

  test("accepts project-scoped resources and ordinary TCP/UDP ports", () => {
    expect(() => validateResolvedComposeModel({
      services: { web: { ports: [{ target: 3000, published: "0", protocol: "tcp" }] } },
      networks: { default: { name: "repo-branch-0123456789_default" } },
      volumes: { data: { name: "repo-branch-0123456789_data" } },
    }, "repo-branch-0123456789")).not.toThrow();
  });
});
