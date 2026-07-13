import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTimeOf, writeAtomicJsonFile } from "../../packages/engine/src/index.ts";

const HESTIA_ROOT = join(import.meta.dir, "..", "..");
const PORTLESS_CLI = join(HESTIA_ROOT, "dist", "assets", "portless", "dist", "cli.js");
const suite = existsSync(PORTLESS_CLI) ? describe : describe.skip;

let temporaryRoot = "";
let portlessPort = 0;
let originServer: ReturnType<typeof Bun.serve> | undefined;

/** Run the isolated hardened Portless payload used by the alias reload regression. */
function runIsolatedPortless(args: string[]): void {
  execFileSync("bun", [PORTLESS_CLI, ...args], {
    env: {
      ...process.env,
      PORTLESS_STATE_DIR: join(temporaryRoot, "portless"),
      PORTLESS_SYNC_HOSTS: "0",
      HESTIA_PORTLESS_ROUTES_PATH: join(temporaryRoot, "portless", "aliases.json"),
      HESTIA_PORTLESS_ROUTES_UID: String(process.getuid?.() ?? 0),
    },
    stdio: "ignore",
    timeout: 30_000,
  });
}

/** Reserve and release one loopback port before Portless binds it. */
function allocatePortlessPort(): number {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

afterEach(() => {
  if (temporaryRoot !== "") {
    try { runIsolatedPortless(["proxy", "stop", "-p", String(portlessPort)]); } catch {}
  }
  originServer?.stop(true);
  originServer = undefined;
  if (temporaryRoot !== "") rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
  portlessPort = 0;
});

suite("Portless external alias reload", () => {
  test("observes an atomic aliases.json replacement without restarting", async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "hestia-portless-alias-reload-"));
    const aliasesPath = join(temporaryRoot, "portless", "aliases.json");
    writeAtomicJsonFile(aliasesPath, []);
    portlessPort = allocatePortlessPort();
    runIsolatedPortless(["proxy", "start", "-p", String(portlessPort), "--no-tls"]);

    originServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("atomic alias reached origin"),
    });
    const processStartTime = startTimeOf(process.pid);
    expect(processStartTime).not.toBeNull();
    writeAtomicJsonFile(aliasesPath, [{
      hostname: "atomic-alias.hestia.localhost",
      port: originServer.port,
      pid: process.pid,
      startTime: processStartTime,
    }]);

    const deadline = Date.now() + 10_000;
    let response: Response | undefined;
    while (Date.now() < deadline) {
      response = await fetch(`http://127.0.0.1:${portlessPort}/health`, {
        headers: { host: "atomic-alias.hestia.localhost" },
      });
      if (response.ok) break;
      await Bun.sleep(50);
    }

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("atomic alias reached origin");
  });
});
