import { expect, test, describe } from "bun:test";
import { parse as rawParseYaml } from "yaml";
import { generateOverride } from "../src/compose/override.ts";

// docker compose understands the `!override` tag; the yaml lib does not, so
// strip it before parsing the generated file for structural assertions.
function parseYaml(s: string): unknown {
  return rawParseYaml(s.replaceAll("!override", ""));
}

const userCompose = {
  name: "modem",
  services: {
    postgres: {
      image: "postgres:17",
      container_name: "modem-postgres",
      ports: ["54322:5432"],
      restart: "unless-stopped",
    },
  },
};

function gen() {
  return generateOverride({
    userCompose,
    project: "modem-salem",
    repo: "modem",
    branch: "salem",
    worktree: "/wt/salem",
    services: ["postgres"],
  });
}

describe("generateOverride", () => {
  test("reports the container ports it will publish", () => {
    expect(gen().servicePorts).toEqual({ postgres: [5432] });
  });

  test("emits a valid YAML override with the !override tag on ports", () => {
    const { yaml } = gen();
    expect(yaml).toContain("ports: !override");
    // yaml lib parses the custom tag without throwing
    const parsed = parseYaml(yaml) as {
      services: Record<string, { ports: unknown[]; container_name: string; restart: string }>;
    };
    const pg = parsed.services.postgres!;
    expect(pg.ports).toEqual(["127.0.0.1:0:5432"]);
    expect(pg.container_name).toBe("hestia-modem-salem-postgres");
    expect(pg.restart).toBe("no");
  });

  test("labels every service for discovery", () => {
    const parsed = parseYaml(gen().yaml) as {
      services: Record<string, { labels: Record<string, string> }>;
    };
    const labels = parsed.services.postgres!.labels;
    expect(labels["dev.hestia.stack"]).toBe("modem-salem");
    expect(labels["dev.hestia.repo"]).toBe("modem");
    expect(labels["dev.hestia.branch"]).toBe("salem");
    expect(labels["dev.hestia.worktree"]).toBe("/wt/salem");
  });

  test("handles ip:host:container and long-form ports", () => {
    const r = generateOverride({
      userCompose: {
        services: {
          a: { ports: ["127.0.0.1:9000:8080"] },
          b: { ports: [{ target: 3000, published: 3000 }] },
        },
      },
      project: "p",
      repo: "r",
      branch: "b",
      worktree: "/wt",
      services: ["a", "b"],
    });
    expect(r.servicePorts).toEqual({ a: [8080], b: [3000] });
  });

  test("throws on an unknown service", () => {
    expect(() =>
      generateOverride({
        userCompose,
        project: "p",
        repo: "r",
        branch: "b",
        worktree: "/wt",
        services: ["nope"],
      }),
    ).toThrow(/not defined/);
  });
});
