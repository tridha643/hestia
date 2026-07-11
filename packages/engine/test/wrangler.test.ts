import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorkers,
  filterWorkers,
  planWorkers,
  stripJsonc,
} from "../src/index.ts";

let tmp: string;

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function fixtureTree(): string {
  tmp = mkdtempSync(join(tmpdir(), "hestia-wrangler-"));
  const put = (rel: string, text: string) => {
    const p = join(tmp, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  put(
    "apps/ingest/wrangler.jsonc",
    `{
      // the ingest worker
      "name": "modem-ingest", /* inline */
      "main": "src/index.ts",
      "compatibility_flags": ["nodejs_compat",],
    }`,
  );
  put(
    "apps/agent/wrangler.toml",
    `name = "modem-agent"\nmain = "src/index.ts"\n\n[env.staging]\nname = "modem-agent-staging"\n`,
  );
  put(
    "apps/nameless/wrangler.jsonc",
    `{ "main": "src/index.ts" }`,
  );
  put(
    "apps/remote/wrangler.jsonc",
    `{ "name": "modem-remote", "services": [{ "binding": "X", "service": "y", "remote": true }] }`,
  );
  put(
    "apps/remote-env/wrangler.toml",
    `name = "modem-remote-env"\n\n[env.prod.services]\nremote = true\n`,
  );
  put("node_modules/dep/wrangler.toml", `name = "should-not-appear"\n`);
  return tmp;
}

describe("stripJsonc", () => {
  test("preserves URLs and quoted braces, drops comments and trailing commas", () => {
    const jsonc = `{
      // comment with "quotes" and http://url
      "url": "https://example.com/path", /* block */
      "brace": "not // a comment, has , and }",
      "list": [1, 2, 3,],
    }`;
    const parsed = JSON.parse(stripJsonc(jsonc));
    expect(parsed.url).toBe("https://example.com/path");
    expect(parsed.brace).toBe("not // a comment, has , and }");
    expect(parsed.list).toEqual([1, 2, 3]);
  });

  test("drops a trailing comma separated from its bracket by a comment", () => {
    const source = `{
      "name": "modem-slack",
      "migrations": [
        { "tag": "v3" }, // the production config explains this migration here
      ],
    }`;
    expect(JSON.parse(stripJsonc(source))).toEqual({
      name: "modem-slack",
      migrations: [{ tag: "v3" }],
    });
  });
});

describe("discoverWorkers", () => {
  test("finds configs, parses top-level names, flags remote, skips node_modules", () => {
    const root = fixtureTree();
    const workers = discoverWorkers(root);
    const byName = new Map(workers.map((w) => [w.name, w]));

    expect(byName.has("modem-ingest")).toBe(true);
    expect(byName.has("modem-agent")).toBe(true); // top-level, not env override
    expect(byName.has("modem-agent-staging")).toBe(false);
    expect(byName.has("should-not-appear")).toBe(false);
    expect(workers.some((w) => w.name === null)).toBe(true); // nameless kept for warning

    expect(byName.get("modem-remote")!.hasRemote).toBe(true);
    expect(byName.get("modem-remote-env")!.hasRemote).toBe(true); // env.* block counts
    expect(byName.get("modem-ingest")!.hasRemote).toBe(false);
  });

  test("filterWorkers matches by worker name or path substring", () => {
    const root = tmp;
    const workers = discoverWorkers(root);
    expect(filterWorkers(workers, root, ["modem-ingest"]).length).toBe(1);
    expect(filterWorkers(workers, root, ["apps/agent"]).length).toBe(1);
    expect(
      filterWorkers(workers, root, ["modem-ingest", "apps/agent"]).length,
    ).toBe(2);
    expect(filterWorkers(workers, root, []).length).toBe(workers.length);
  });
});

describe("planWorkers resource mode", () => {
  test("forces ordinary bindings local", async () => {
    const root = fixtureTree();
    const bin = join(root, "node_modules", ".bin", "wrangler");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");

    const plan = await planWorkers(root, {
      filter: ["modem-ingest"],
      allowRemote: false,
      force: true,
      varlock: false,
    });

    expect(plan.specs[0]?.argv).toContain("--local");
  });

  test("permits declared remote bindings only after explicit opt-in", async () => {
    const root = fixtureTree();
    const bin = join(root, "node_modules", ".bin", "wrangler");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");

    const plan = await planWorkers(root, {
      filter: ["modem-remote"],
      allowRemote: true,
      force: true,
      varlock: false,
    });

    expect(plan.specs[0]?.argv).not.toContain("--local");
  });
});
