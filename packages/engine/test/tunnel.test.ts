import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  generateMergedConfig,
  hostnameFor,
  importBaseRules,
  inferZone,
  zoneOf,
  type DynamicRule,
  type IngressRule,
} from "../src/tunnel/ingress.ts";
import {
  collectDynamicRules,
  ledgerAdd,
  ledgerHas,
} from "../src/tunnel/registry.ts";
import {
  hestiaTunnelMarker,
  parseLocalHestiaConnectors,
} from "../src/tunnel/orphans.ts";
import {
  internalEndpointAuthority,
  publicGatewaySocketPath,
} from "../src/router/local-http-router.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

describe("hostnameFor", () => {
  test("short names pass through as one label under the zone", () => {
    expect(hostnameFor("tri", "salem", "slack", "modem.codes")).toBe(
      "tri-salem-slack.modem.codes",
    );
  });

  test("over-budget labels are truncated with a stable hash and stay distinct", () => {
    const branch = "feature-very-long-branch-name-that-keeps-going-forever";
    const a = hostnameFor("tri", branch, "slack-notifications-worker", "modem.codes");
    const b = hostnameFor("tri", branch, "slack-notifications-worker2", "modem.codes");
    const labelA = a.split(".")[0]!;
    const labelB = b.split(".")[0]!;
    expect(labelA.length).toBeLessThanOrEqual(63);
    expect(labelB.length).toBeLessThanOrEqual(63);
    expect(labelA).not.toBe(labelB); // hash suffix keeps long names apart
    // deterministic across calls
    expect(
      hostnameFor("tri", branch, "slack-notifications-worker", "modem.codes"),
    ).toBe(a);
  });

  test("slugging: foo_bar and foo-bar produce the SAME label (conflict is caught downstream)", () => {
    expect(hostnameFor("t", "b", "foo_bar", "z.dev")).toBe(
      hostnameFor("t", "b", "foo-bar", "z.dev"),
    );
  });
});

describe("zone inference", () => {
  test("zoneOf strips the first label", () => {
    expect(zoneOf("tri-slack.modem.codes")).toBe("modem.codes");
    expect(zoneOf("nodots")).toBeUndefined();
  });

  test("inferZone: unanimous base rules win; mixed or empty → undefined", () => {
    const mk = (h: string): IngressRule => ({ hostname: h, service: "x" });
    expect(inferZone([mk("a.modem.codes"), mk("b.modem.codes")])).toBe("modem.codes");
    expect(inferZone([mk("a.modem.codes"), mk("b.other.dev")])).toBeUndefined();
    expect(inferZone([])).toBeUndefined();
  });
});

describe("importBaseRules", () => {
  function withUserConfig(text: string): string {
    const home = mkdtempSync(join(tmpdir(), "hestia-cf-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.yml"), text);
    return home;
  }

  test("imports the adopted tunnel's rules verbatim, minus the catch-all", () => {
    const home = withUserConfig(
      `tunnel: 657d-uuid\ncredentials-file: /x.json\ningress:\n` +
        `  - hostname: tri-slack.modem.codes\n    service: http://localhost:8789\n` +
        `  - service: http_status:404\n`,
    );
    process.env.HESTIA_CLOUDFLARED_HOME = home;
    try {
      const rules = importBaseRules("657d-uuid", "tri");
      expect(rules).toEqual([
        { hostname: "tri-slack.modem.codes", service: "http://localhost:8789" },
      ]);
      // matching by NAME also works (config.yml may say `tunnel: tri`)
      expect(importBaseRules("other-uuid", "tri")).toEqual([]);
      const byName = withUserConfig(
        `tunnel: tri\ningress:\n  - hostname: a.z.dev\n    service: http://localhost:1\n  - service: http_status:404\n`,
      );
      process.env.HESTIA_CLOUDFLARED_HOME = byName;
      expect(importBaseRules("whatever", "tri")).toHaveLength(1);
    } finally {
      delete process.env.HESTIA_CLOUDFLARED_HOME;
    }
  });

  test("absent file or foreign tunnel → no base rules", () => {
    const home = mkdtempSync(join(tmpdir(), "hestia-cf-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.HESTIA_CLOUDFLARED_HOME = home;
    try {
      expect(importBaseRules("u", "t")).toEqual([]);
    } finally {
      delete process.env.HESTIA_CLOUDFLARED_HOME;
    }
  });
});

describe("generateMergedConfig", () => {
  const base: IngressRule[] = [
    { hostname: "tri-slack.modem.codes", service: "http://localhost:8789" },
  ];
  const dyn = (over?: Partial<DynamicRule>): DynamicRule => ({
    project: "modem-salem",
    service: "slack",
    hostname: "tri-salem-slack.modem.codes",
    originPort: 50123,
    ...over,
  });

  test("base first, dynamic after, catch-all last; Host rewritten by default", () => {
    const text = generateMergedConfig({
      uuid: "u1",
      credFile: "/c.json",
      baseRules: base,
      dynamicRules: [dyn()],
    });
    const cfg = parseYaml(text) as {
      tunnel: string;
      "credentials-file": string;
      ingress: IngressRule[];
    };
    expect(cfg.tunnel).toBe("u1");
    expect(cfg["credentials-file"]).toBe("/c.json");
    expect(cfg.ingress).toHaveLength(3);
    expect(cfg.ingress[0]!.hostname).toBe("tri-slack.modem.codes");
    expect(cfg.ingress[1]).toEqual({
      hostname: "tri-salem-slack.modem.codes",
      service: `unix:${publicGatewaySocketPath()}`,
      originRequest: { httpHostHeader: internalEndpointAuthority("modem-salem", "slack") },
    });
    expect(cfg.ingress[2]).toEqual({ service: "http_status:404" });
  });

  test("keepHostHeader drops the rewrite", () => {
    const text = generateMergedConfig({
      uuid: "u1",
      credFile: "/c.json",
      baseRules: [],
      dynamicRules: [dyn({ keepHostHeader: true })],
    });
    const cfg = parseYaml(text) as { ingress: IngressRule[] };
    expect(cfg.ingress[0]!.originRequest).toBeUndefined();
  });

  test("duplicate hostnames are a hard conflict — dynamic vs dynamic and vs base", () => {
    expect(() =>
      generateMergedConfig({
        uuid: "u1",
        credFile: "/c.json",
        baseRules: [],
        dynamicRules: [dyn(), dyn({ project: "other-main" })],
      }),
    ).toThrow(/hostname-conflict|already claimed/);
    expect(() =>
      generateMergedConfig({
        uuid: "u1",
        credFile: "/c.json",
        baseRules: base,
        dynamicRules: [dyn({ hostname: "tri-slack.modem.codes" })],
      }),
    ).toThrow(/already claimed/);
  });
});

describe("hostname ledger + mirror-derived rules", () => {
  const uuid = `test-${Math.random().toString(36).slice(2, 10)}`;
  const project = `hestia-test-${Math.random().toString(36).slice(2, 10)}`;
  cleanups.push(() => {
    rmSync(join(homedir(), ".hestia", "tunnel", uuid), { recursive: true, force: true });
    rmSync(join(homedir(), ".hestia", "stacks", project), { recursive: true, force: true });
  });

  test("ledger remembers routed hostnames", () => {
    expect(ledgerHas(uuid, "a.z.dev")).toBe(false);
    ledgerAdd(uuid, "a.z.dev");
    expect(ledgerHas(uuid, "a.z.dev")).toBe(true);
    ledgerAdd(uuid, "a.z.dev"); // idempotent
    expect(ledgerHas(uuid, "b.z.dev")).toBe(false);
  });

  test("collectDynamicRules reads mirrors, re-points at live ports, drops dead origins", () => {
    const mdir = join(homedir(), ".hestia", "stacks", project);
    mkdirSync(mdir, { recursive: true });
    writeFileSync(
      join(mdir, "stack.json"),
      JSON.stringify({
        schemaVersion: 1,
        project,
        repo: "r",
        branch: "b",
        worktree: "/gone",
        state: "up",
        env: {},
        endpoints: [],
        createdAt: new Date(0).toISOString(),
        services: [
          { name: "web", backend: "proc", state: "healthy", publishedPort: 60001 },
        ],
        tunnel: {
          name: "t",
          uuid,
          zone: "z.dev",
          credFile: "/c.json",
          exposures: [
            { service: "web", hostname: "t-b-web.z.dev", originPort: 59999 },
            { service: "dead", hostname: "t-b-dead.z.dev", originPort: 1 },
          ],
        },
      }),
    );
    const { rules, dropped } = collectDynamicRules(uuid);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.originPort).toBe(60001); // live record beats stale exposure
    expect(dropped).toEqual([
      { project, service: "dead", hostname: "t-b-dead.z.dev" },
    ]);
    // other uuids see nothing
    expect(collectDynamicRules("some-other-uuid").rules).toEqual([]);
  });
});

describe("parseLocalHestiaConnectors", () => {
  const uuid = "657d6e71-33a6-4105-992c-5fc00a575dd1";
  const marker = `/Users/x/.hestia/tunnel/${uuid}`;

  test("selects hestia-config cloudflareds and ignores token/foreign/editor rows", () => {
    const ps = [
      `  943   929 cloudflared tunnel --config ${marker}/config.yml --metrics 127.0.0.1:1 run ${uuid}`,
      ` 2643  2619 /opt/homebrew/bin/cloudflared tunnel --config ${marker}/config.yml run ${uuid}`,
      ` 5238     1 /opt/homebrew/bin/cloudflared tunnel run --token REDACTED-TOKEN-VALUE`,
      ` 9999  9999 vim ${marker}/config.yml`,
      ` 1111  1111 cloudflared tunnel --config /tmp/other/config.yml run other-uuid`,
      `not a process line`,
    ].join("\n");
    const rows = parseLocalHestiaConnectors(ps, marker);
    expect(rows).toEqual([
      {
        pid: 943,
        pgid: 929,
        command: `cloudflared tunnel --config ${marker}/config.yml --metrics 127.0.0.1:1 run ${uuid}`,
      },
      {
        pid: 2643,
        pgid: 2619,
        command: `/opt/homebrew/bin/cloudflared tunnel --config ${marker}/config.yml run ${uuid}`,
      },
    ]);
  });

  test("hestiaTunnelMarker nests under HESTIA_HOME", () => {
    const prev = process.env.HESTIA_HOME;
    process.env.HESTIA_HOME = "/tmp/hestia-home-x";
    try {
      expect(hestiaTunnelMarker("abc")).toBe("/tmp/hestia-home-x/tunnel/abc");
    } finally {
      if (prev === undefined) delete process.env.HESTIA_HOME;
      else process.env.HESTIA_HOME = prev;
    }
  });
});
