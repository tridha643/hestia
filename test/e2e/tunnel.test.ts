import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// Public-ingress e2e in three tiers:
//   1. stub cloudflared (ALWAYS runs, no network, no account) — the full
//      unified-tunnel lifecycle across two worktrees;
//   2. generated ingress vs the REAL cloudflared parser (offline, auto-gated
//      on the binary being installed);
//   3. a REAL quick tunnel through the edge (opt-in: HESTIA_E2E_TUNNEL=1).
// Invariant: automated tests never create DNS records and never touch the
// shared account's tunnels — the real binary is only used offline or in
// account-less quick mode.

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "index.ts");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "proc-repo");
const STUB_DIR = join(import.meta.dir, "..", "fixtures", "tunnel-stub");

function realCloudflared(): boolean {
  try {
    execFileSync("cloudflared", ["version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hestia",
      GIT_AUTHOR_EMAIL: "hestia@test",
      GIT_COMMITTER_NAME: "hestia",
      GIT_COMMITTER_EMAIL: "hestia@test",
    },
  });

interface CliResult {
  code: number;
  stdout: string;
}

interface StackJson {
  project: string;
  env: Record<string, string>;
  endpoints: Array<{ name: string; publicUrl?: string }>;
  services: Array<{ name: string; pid?: number; publishedPort?: number; state: string }>;
  auxiliary?: Array<{ name: string; originService?: string; state: string }>;
  tunnel?: { uuid: string; exposures: Array<{ hostname: string; originPort: number }> };
}

describe("unified tunnel lifecycle (stub cloudflared, no network)", () => {
  const uuid = `stub-uuid-${Math.random().toString(36).slice(2, 10)}`;
  let tmpRoot: string;
  let repoDir: string;
  let wtA: string;
  let wtB: string;
  let stubState: string;
  let cfHome: string;
  let env: Record<string, string>;

  const tunnelHome = () => join(env?.HESTIA_HOME ?? join(homedir(), ".hestia"), "tunnel", uuid);
  const mergedConfig = () =>
    parseYaml(readFileSync(join(tunnelHome(), "config.yml"), "utf8")) as {
      ingress: Array<{ hostname?: string; service: string; originRequest?: Record<string, unknown> }>;
    };
  const connectorPid = (): number | null => {
    const p = join(tunnelHome(), ".hestia", "procs", "connector.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { pid: number }).pid : null;
  };
  const routeLog = (): string[][] =>
    (existsSync(join(stubState, "route.log")) ? readFileSync(join(stubState, "route.log"), "utf8") : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);

  function runCli(cwd: string, args: string[]): CliResult {
    try {
      const stdout = execFileSync("bun", [CLI, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      return { code: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-tunnel-e2e-"));
    repoDir = join(tmpRoot, "tunrepo");
    cpSync(FIXTURE, repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    wtA = join(tmpRoot, "wt-a");
    wtB = join(tmpRoot, "wt-b");
    git(repoDir, ["worktree", "add", "-q", "-b", "tun-a", wtA]);
    git(repoDir, ["worktree", "add", "-q", "-b", "tun-b", wtB]);

    stubState = join(tmpRoot, "stub-state");
    mkdirSync(stubState);
    writeFileSync(
      join(stubState, "tunnels.json"),
      JSON.stringify([
        { id: uuid, name: "stubtun", connections: [] },
        { id: "busy-uuid", name: "busytun", connections: [{ id: "c1" }] },
      ]),
    );
    cfHome = join(tmpRoot, "cf-home");
    mkdirSync(cfHome);
    writeFileSync(join(cfHome, "cert.pem"), "stub-cert");
    writeFileSync(join(cfHome, `${uuid}.json`), JSON.stringify({ TunnelID: uuid }));
    writeFileSync(join(cfHome, "busy-uuid.json"), JSON.stringify({ TunnelID: "busy-uuid" }));
    // the user's static config: gives base-rule import + zone inference
    writeFileSync(
      join(cfHome, "config.yml"),
      `tunnel: ${uuid}\ncredentials-file: ${join(cfHome, `${uuid}.json`)}\n` +
        `ingress:\n  - hostname: stubtun-static.stub.test\n    service: http://localhost:9\n` +
        `  - service: http_status:404\n`,
    );
    env = {
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      HESTIA_STUB_STATE: stubState,
      HESTIA_CLOUDFLARED_HOME: cfHome,
      HESTIA_HOME: join(tmpRoot, "hestia-home"),
      HESTIA_E2E_DNS_RESOLVED: "1",
      HESTIA_NO_OPEN: "1", // never spawn a real browser from the suite
    };
  });

  afterAll(() => {
    for (const wt of [wtA, wtB]) {
      if (wt && existsSync(wt)) runCli(wt, ["down"]);
    }
    for (const b of ["tun-a", "tun-b"]) runCli(tmpRoot, ["down", "--project", `tunrepo-${b}`]);
    // CRITICAL: the daemon these runs auto-spawned inherited the STUB
    // cloudflared PATH — left alive it would "revive" real tunnels with the
    // stub. Stop it; the next real command respawns a clean one.
    runCli(tmpRoot, ["daemon", "stop"]);
    // the global connector has no owning stack — kill it via its pidfile
    const pid = connectorPid();
    if (pid !== null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    rmSync(join(homedir(), ".hestia", "tunnel", uuid), { recursive: true, force: true });
    rmSync(join(homedir(), ".hestia", "tunnel", "busy-uuid"), { recursive: true, force: true });
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test(
    "adopt → merged ingress → rotation regen → down isolation → mirror teardown",
    async () => {
      // two worktrees, one proc each
      const run = (wt: string, marker: string) =>
        runCli(wt, ["run", "--name", "web", "--env", `WORKTREE_MARKER=${marker}`, "--json", "--", "bun", "server.ts"]);
      expect(run(wtA, "A").code).toBe(0);
      expect(run(wtB, "B").code).toBe(0);

      // 1. A exposes through the named tunnel — zone inferred from base rules
      const aOut = runCli(wtA, ["expose", "web", "--tunnel", "stubtun", "--json"]);
      expect(aOut.code).toBe(0);
      const a = JSON.parse(aOut.stdout) as StackJson;
      expect(a.env.HESTIA_WEB_URL).toBe("https://stubtun-tun-a-web.stub.test");
      expect(a.endpoints.find((e) => e.name === "web")?.publicUrl).toBe(
        "https://stubtun-tun-a-web.stub.test",
      );

      // Named v1 never mutates DNS; wildcard routing was preflighted.
      const routes = routeLog();
      expect(routes).toEqual([]);

      // merged config: base rule first, A's dynamic rule with Host rewrite, catch-all last
      let cfg = mergedConfig();
      expect(cfg.ingress[0]!.hostname).toBe("stubtun-static.stub.test");
      const aPort = a.services.find((s) => s.name === "web")!.publishedPort!;
      const aRule = cfg.ingress.find((r) => r.hostname === "stubtun-tun-a-web.stub.test")!;
      expect(aRule.service.startsWith("unix:")).toBe(true);
      expect(String(aRule.originRequest?.httpHostHeader)).toMatch(/\.hestia\.internal$/);
      expect(cfg.ingress[cfg.ingress.length - 1]).toEqual({ service: "http_status:404" });
      const pid1 = connectorPid();
      expect(pid1).not.toBeNull();

      // 2. B joins the same tunnel — one connector, both rules, restart happened
      const bOut = runCli(wtB, ["expose", "web", "--tunnel", "stubtun", "--json"]);
      expect(bOut.code).toBe(0);
      const b = JSON.parse(bOut.stdout) as StackJson;
      cfg = mergedConfig();
      expect(cfg.ingress.some((r) => r.hostname === "stubtun-tun-a-web.stub.test")).toBe(true);
      expect(cfg.ingress.some((r) => r.hostname === "stubtun-tun-b-web.stub.test")).toBe(true);
      const pid2 = connectorPid();
      expect(pid2).not.toBe(pid1);

      // 3. sticky adoption + idempotence: bare re-expose changes nothing
      expect(runCli(wtA, ["expose", "web", "--json"]).code).toBe(0);
      expect(connectorPid()).toBe(pid2);
      expect(routeLog()).toEqual([]);

      // 4. port rotation: replacing A's proc re-points the rule automatically
      expect(runCli(wtA, ["run", "--name", "web", "--env", "WORKTREE_MARKER=A2", "--json", "--", "bun", "server.ts"]).code).toBe(0);
      const rotated = JSON.parse(runCli(wtA, ["status", "--json"]).stdout) as StackJson;
      const newPort = rotated.services.find((s) => s.name === "web")!.publishedPort!;
      expect(newPort).not.toBe(aPort);
      cfg = mergedConfig();
      expect(
        cfg.ingress.find((r) => r.hostname === "stubtun-tun-a-web.stub.test")!.service,
      ).toMatch(/^unix:/);
      expect(connectorPid()).toBe(pid2); // stable gateway removes origin-rotation restarts

      // 5. status: tunnel row healthy, exposure ports current
      const status = JSON.parse(runCli(wtA, ["status", "--json"]).stdout) as StackJson;
      expect(status.services.find((s) => s.name === "tunnel")?.state).toBe("healthy");

      // 6. down A: A's rule gone, B's + base survive, connector still up
      expect(runCli(wtA, ["down"]).code).toBe(0);
      cfg = mergedConfig();
      expect(cfg.ingress.some((r) => r.hostname === "stubtun-tun-a-web.stub.test")).toBe(false);
      expect(cfg.ingress.some((r) => r.hostname === "stubtun-tun-b-web.stub.test")).toBe(true);
      expect(cfg.ingress[0]!.hostname).toBe("stubtun-static.stub.test");
      expect(connectorPid()).not.toBeNull();

      // 7. delete B's worktree; mirror teardown drops its rule too
      git(repoDir, ["worktree", "remove", "--force", wtB]);
      expect(runCli(tmpRoot, ["down", "--project", b.project]).code).toBe(0);
      cfg = mergedConfig();
      expect(cfg.ingress.some((r) => r.hostname === "stubtun-tun-b-web.stub.test")).toBe(false);
    },
    120_000,
  );

  test(
    "takeover preflight, DNS conflict handling, quick mode, dead-connector revival",
    async () => {
      const wt = join(tmpRoot, "wt-c");
      git(repoDir, ["worktree", "add", "-q", "-b", "tun-c", wt]);
      expect(
        runCli(wt, ["run", "--name", "web", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);

      // foreign connectors block adoption (never kill what we didn't spawn)
      const busy = runCli(wt, ["expose", "web", "--tunnel", "busytun", "--zone", "stub.test", "--json"]);
      expect(busy.code).toBe(1);
      expect(busy.stdout).toContain("tunnel-busy");

      // Existing DNS state is read-only to Hestia; resolved wildcard DNS wins.
      writeFileSync(
        join(stubState, "dns-existing.json"),
        JSON.stringify(["stubtun-tun-c-web.stub.test"]),
      );
      const conflict = runCli(wt, ["expose", "web", "--tunnel", "stubtun", "--json"]);
      expect(conflict.code).toBe(0);
      expect(routeLog()).toEqual([]);
      // --overwrite-dns was removed from the v1 mutation path.
      const forced = runCli(wt, ["expose", "web", "--tunnel", "stubtun", "--overwrite-dns", "--json"]);
      expect(forced.code).toBe(1);
      expect(forced.stdout).toContain("usage");

      // dead connector: killed out-of-band, the next expose revives it
      const pid = connectorPid()!;
      process.kill(-pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
      expect(runCli(wt, ["expose", "web", "--json"]).code).toBe(0);
      expect(connectorPid()).not.toBe(pid);

      expect(runCli(wt, ["down"]).code).toBe(0);

      // quick mode: a worktree that never adopted gets per-service quick tunnels
      const wtQ = join(tmpRoot, "wt-q");
      git(repoDir, ["worktree", "add", "-q", "-b", "tun-q", wtQ]);
      expect(
        runCli(wtQ, ["run", "--name", "web", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);
      const quick = JSON.parse(runCli(wtQ, ["expose", "web", "--json"]).stdout) as StackJson;
      expect(quick.env.HESTIA_WEB_URL).toMatch(/^https:\/\/stub-.*\.trycloudflare\.com$/);
      expect(quick.auxiliary?.some((service) => service.originService === "web")).toBe(true);

      // `hestia open` resolves the public URL (+ optional path) for a click
      const opened = JSON.parse(
        runCli(wtQ, ["open", "web", "/auth/login", "--json"]).stdout,
      ) as { url: string };
      expect(opened.url).toBe(`${quick.env.HESTIA_WEB_URL}/auth/login`);
      const bare = JSON.parse(runCli(wtQ, ["open", "web", "--json"]).stdout) as { url: string };
      expect(bare.url).toBe(quick.env.HESTIA_WEB_URL);
      // unexposed service → clear error, not a crash
      expect(runCli(wtQ, ["open", "nope", "--json"]).stdout).toContain("service-not-found");
      // stopping the origin also stops its hidden quick-tunnel auxiliary.
      expect(runCli(wtQ, ["stop", "web"]).code).toBe(0);
      const after = JSON.parse(runCli(wtQ, ["status", "--json"]).stdout) as StackJson | null;
      expect(after).toBeNull();
      expect(runCli(wtQ, ["down"]).code).toBe(0);
    },
    120_000,
  );
});

describe.if(realCloudflared())("generated ingress vs the real cloudflared parser (offline)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hestia-ingress-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("merged config validates and every hostname matches its own rule", () => {
    const cfgPath = join(dir, "config.yml");
    // shape mirrors generateMergedConfig output: base + dynamic + catch-all
    writeFileSync(
      cfgPath,
      [
        `tunnel: 00000000-0000-0000-0000-000000000000`,
        `credentials-file: ${join(dir, "cred.json")}`,
        `ingress:`,
        `  - hostname: tri-static.modem.codes`,
        `    service: http://localhost:9`,
        `  - hostname: tri-salem-slack.modem.codes`,
        `    service: unix:/tmp/hestia-test-origin.sock`,
        `    originRequest:`,
        `      httpHostHeader: slack-0123456789.hestia.internal`,
        `  - service: http_status:404`,
      ].join("\n") + "\n",
    );
    execFileSync("cloudflared", ["tunnel", "--config", cfgPath, "ingress", "validate"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const match = execFileSync(
      "cloudflared",
      ["tunnel", "--config", cfgPath, "ingress", "rule", "https://tri-salem-slack.modem.codes"],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(match).toContain("unix:/tmp/hestia-test-origin.sock");
    // an unknown hostname falls through to the catch-all, not someone's origin
    const fallthrough = execFileSync(
      "cloudflared",
      ["tunnel", "--config", cfgPath, "ingress", "rule", "https://nope.modem.codes"],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(fallthrough).toContain("http_status:404");
  });
});

describe.if(process.env.HESTIA_E2E_TUNNEL === "1")("real quick tunnel through the edge (gated)", () => {
  let tmpRoot: string;
  let wt: string;

  function runCli(cwd: string, args: string[]): CliResult {
    try {
      const stdout = execFileSync("bun", [CLI, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "hestia-quick-e2e-"));
    const repoDir = join(tmpRoot, "quickrepo");
    cpSync(FIXTURE, repoDir, { recursive: true });
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-q", "-m", "fixture"]);
    wt = join(tmpRoot, "wt-q");
    git(repoDir, ["worktree", "add", "-q", "-b", "quick-a", wt]);
  });

  afterAll(() => {
    if (wt && existsSync(wt)) runCli(wt, ["down"]);
    runCli(tmpRoot, ["down", "--project", "quickrepo-quick-a"]);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test(
    "expose --quick round-trips through trycloudflare",
    async () => {
      expect(
        runCli(wt, ["run", "--name", "web", "--env", "WORKTREE_MARKER=EDGE", "--json", "--", "bun", "server.ts"]).code,
      ).toBe(0);
      const out = runCli(wt, ["expose", "web", "--ready-timeout", "60", "--json"]);
      expect(out.code).toBe(0);
      const r = JSON.parse(out.stdout) as StackJson;
      const url = r.env.HESTIA_WEB_URL!;
      expect(url).toMatch(/^https:\/\/.*\.trycloudflare\.com$/);

      // Edge DNS lags a few seconds behind the minted URL, and the FIRST
      // lookup lands in that gap — macOS's system resolver then negative-
      // caches the NXDOMAIN (bun's fetch cache does the same), leaving curl
      // and fetch blind for minutes while the records exist. Resolve via dig
      // (bypasses the cache) and pin curl with --resolve; SNI/Host stay real,
      // so this still proves the edge round-trip.
      const host = url.replace("https://", "");
      let marker: string | undefined;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && marker === undefined) {
        try {
          const ip = execFileSync("dig", ["+short", host, "A"], {
            encoding: "utf8",
            timeout: 10_000,
          })
            .split("\n")
            .find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()))
            ?.trim();
          if (ip !== undefined) {
            const body = execFileSync(
              "curl",
              ["-sf", "--max-time", "5", "--resolve", `${host}:443:${ip}`, url],
              { encoding: "utf8", timeout: 10_000 },
            );
            marker = (JSON.parse(body) as { marker?: string }).marker;
            break;
          }
        } catch {}
        await new Promise((rr) => setTimeout(rr, 3_000));
      }
      expect(marker).toBe("EDGE");
      expect(runCli(wt, ["down"]).code).toBe(0);
    },
    240_000,
  );
});
