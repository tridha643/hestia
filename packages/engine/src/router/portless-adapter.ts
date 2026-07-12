import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { HestiaError } from "@hestia/core";
import { ensureDir, hestiaHome } from "../state.ts";
import { startTimeOf } from "../proc/pidfile.ts";
import { writeAtomicJsonFile } from "../atomic-json-file.ts";
import { ensureDaemon } from "../daemon/ensure.ts";
import { withLock } from "../proc/lock.ts";
import {
  HESTIA_PORTLESS_VERSION,
  expectedPortlessPayloadProvenance,
  portlessPayloadProvenanceIsCurrent,
} from "./portless-payload.ts";

const pexec = promisify(execFile);
export { HESTIA_PORTLESS_VERSION };
const PORTLESS_LAUNCHD_PLIST = "/Library/LaunchDaemons/sh.portless.proxy.plist";
const HESTIA_ROUTER_INSTALL_DIR = "/Library/Application Support/Hestia/router";
const HESTIA_ROUTER_STAGED_DIR = "/Library/Application Support/Hestia/router.next";
const HESTIA_ROUTER_PREVIOUS_DIR = "/Library/Application Support/Hestia/router.previous";
const HESTIA_ROUTER_BUN = join(HESTIA_ROUTER_INSTALL_DIR, "bun");
const HESTIA_ROUTER_PORTLESS = join(HESTIA_ROUTER_INSTALL_DIR, "portless");
const HESTIA_ROUTER_CLI = join(HESTIA_ROUTER_PORTLESS, "dist", "cli.js");
const HESTIA_ROUTER_RUNTIME_STATE_DIR = join(HESTIA_ROUTER_INSTALL_DIR, "state");

/** Root-owned runtime state used by the privileged Portless LaunchDaemon. */
export function hestiaPortlessStateDir(): string {
  return HESTIA_ROUTER_RUNTIME_STATE_DIR;
}

/** User-owned, read-only-to-Portless alias projection written by hestiad. */
export function hestiaPortlessAliasesPath(): string {
  return join(hestiaHome(), "router", "portless", "aliases.json");
}

function portlessCliPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const bundled = join(moduleDirectory, "assets", "portless", "dist", "cli.js");
  if (existsSync(bundled) && portlessPayloadRootIsCurrent(dirname(dirname(bundled)))) return bundled;
  const workspaceBuild = join(moduleDirectory, "..", "..", "..", "..", "dist", "assets", "portless", "dist", "cli.js");
  if (existsSync(workspaceBuild) && portlessPayloadRootIsCurrent(dirname(dirname(workspaceBuild)))) {
    return workspaceBuild;
  }
  throw new HestiaError(
    "router-version-unsupported",
    "current hardened Portless payload is unavailable; run bun run build and retry",
  );
}

function portlessPayloadRootIsCurrent(root: string): boolean {
  try {
    return portlessPayloadProvenanceIsCurrent(
      JSON.parse(readFileSync(join(root, "provenance.json"), "utf8")),
    );
  } catch {
    return false;
  }
}

function installedPortlessPayloadIsCurrent(): boolean {
  return portlessPayloadRootIsCurrent(HESTIA_ROUTER_PORTLESS);
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function portlessServiceOwnership(): "absent" | "hestia" | "foreign" {
  if (process.platform !== "darwin" || !existsSync(PORTLESS_LAUNCHD_PLIST)) return "absent";
  try {
    const plist = readFileSync(PORTLESS_LAUNCHD_PLIST, "utf8");
    const stateEntry = `<key>PORTLESS_STATE_DIR</key>\n    <string>${xmlEscape(hestiaPortlessStateDir())}</string>`;
    const aliasesEntry = `<key>HESTIA_PORTLESS_ROUTES_PATH</key>\n    <string>${xmlEscape(hestiaPortlessAliasesPath())}</string>`;
    const rootStateEntry = "<key>HESTIA_PORTLESS_ROOT_STATE</key>\n    <string>1</string>";
    const routesUidEntry = `<key>HESTIA_PORTLESS_ROUTES_UID</key>\n    <string>${process.getuid?.() ?? 0}</string>`;
    const hardenedPayload = plist.includes(`<string>${xmlEscape(HESTIA_ROUTER_BUN)}</string>`) &&
      plist.includes(`<string>${xmlEscape(HESTIA_ROUTER_CLI)}</string>`);
    const payloadSecure = [HESTIA_ROUTER_BUN, HESTIA_ROUTER_CLI].every((path) => {
      const stat = statSync(path);
      return stat.uid === 0 && (stat.mode & 0o022) === 0;
    });
    return plist.includes(stateEntry) && plist.includes(aliasesEntry) && plist.includes(rootStateEntry) &&
      plist.includes(routesUidEntry) &&
      hardenedPayload && payloadSecure
      ? "hestia"
      : "foreign";
  } catch {
    return "foreign";
  }
}

function requireHestiaServiceOwnership(action: "install" | "uninstall"): "absent" | "hestia" {
  if (process.platform !== "darwin") {
    throw new HestiaError(
      "router-version-unsupported",
      `Router ${action}: the first privileged installer supports macOS only`,
    );
  }
  const ownership = portlessServiceOwnership();
  if (ownership === "foreign") {
    throw new HestiaError(
      "router-version-unsupported",
      `Router ${action}: the machine-global Portless service belongs to another installation; Hestia will not modify it`,
    );
  }
  return ownership;
}

/** Reconcile every Hestia-owned Portless alias to the current daemon router port. */
export function reconcilePortlessAliases(hostnames: string[], routerPort: number): void {
  const daemonStartTime = startTimeOf(process.pid);
  if (daemonStartTime === null) {
    throw new Error(`cannot capture hestiad process identity for PID ${process.pid}`);
  }
  writeAtomicJsonFile(hestiaPortlessAliasesPath(), hostnames.map((hostname) => ({
    hostname,
    port: routerPort,
    pid: process.pid,
    startTime: daemonStartTime,
  })));
}

export interface HestiaRouterStatus {
  installed: boolean;
  running: boolean;
  trusted: boolean;
  version: string;
  port: number;
  stateDir: string;
}

/** Inspect Hestia's isolated Portless service without prompting or mutating it. */
export async function readHestiaRouterStatus(): Promise<HestiaRouterStatus> {
  const stateDir = hestiaPortlessStateDir();
  const portFile = join(stateDir, "proxy.port");
  const port = existsSync(portFile) ? Number(readFileSync(portFile, "utf8").trim()) : 443;
  let running = false;
  try {
    const response = await fetch(`https://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(500),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    running = response.headers.get("x-portless") === "1";
  } catch {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(500),
      });
      running = response.headers.get("x-portless") === "1";
    } catch {}
  }
  return {
    installed: portlessServiceOwnership() === "hestia",
    running,
    trusted: await hestiaPortlessCaIsTrusted(),
    version: HESTIA_PORTLESS_VERSION,
    port: Number.isInteger(port) && port > 0 ? port : 443,
    stateDir,
  };
}

async function hestiaPortlessCaIsTrusted(): Promise<boolean> {
  const caPath = join(hestiaPortlessStateDir(), "ca.pem");
  if (!existsSync(caPath)) return false;
  try {
    const { stdout } = await pexec(
      "openssl",
      ["x509", "-in", caPath, "-noout", "-fingerprint", "-sha1"],
      { timeout: 10_000 },
    );
    const fingerprint = stdout.replace(/^.*=/, "").replaceAll(":", "").trim().toLowerCase();
    const systemKeychain = "/Library/Keychains/System.keychain";
    if (await keychainHasFingerprint(systemKeychain, fingerprint)) return true;
    const { stdout: loginOutput } = await pexec(
      "security",
      ["default-keychain", "-d", "user"],
      { timeout: 10_000 },
    );
    const loginKeychain = loginOutput.trim().replace(/^"|"$/g, "");
    return loginKeychain !== "" && await keychainHasFingerprint(loginKeychain, fingerprint);
  } catch {
    return false;
  }
}

async function runRootCommand(command: string, args: string[], interactive: boolean, optional = false): Promise<void> {
  if (interactive) {
    const result = spawnSync("sudo", [command, ...args], { stdio: "inherit", timeout: 60_000 });
    if (!optional && (result.error !== undefined || result.status !== 0)) {
      throw result.error ?? new Error(`${command} exited ${result.status}`);
    }
    return;
  }
  try {
    await pexec("sudo", ["-n", command, ...args], { timeout: 60_000 });
  } catch (error) {
    if (!optional) throw error;
  }
}

async function prepareHardenedPortlessPayloadAt(
  installDir: string,
  interactive: boolean,
): Promise<void> {
  const packageRoot = dirname(dirname(portlessCliPath()));
  const portlessDir = join(installDir, "portless");
  const bunPath = join(installDir, "bun");
  const provenanceSource = join(dirname(hestiaPortlessAliasesPath()), "payload-provenance.json");
  ensureDir(dirname(provenanceSource));
  writeAtomicJsonFile(provenanceSource, expectedPortlessPayloadProvenance());
  await runRootCommand("mkdir", ["-p", installDir], interactive);
  await runRootCommand("rm", ["-rf", portlessDir], interactive);
  await runRootCommand("ditto", [packageRoot, portlessDir], interactive);
  await runRootCommand("cp", [provenanceSource, join(portlessDir, "provenance.json")], interactive);
  await runRootCommand("cp", [process.execPath, bunPath], interactive);
  await runRootCommand("chown", ["-R", "root:wheel", installDir], interactive);
  await runRootCommand("chmod", ["-R", "go-w", installDir], interactive);
  rmSync(provenanceSource, { force: true });
}

async function prepareHardenedPortlessPayload(interactive: boolean): Promise<void> {
  await prepareHardenedPortlessPayloadAt(HESTIA_ROUTER_INSTALL_DIR, interactive);
}

async function runHardenedPortlessService(
  action: "install" | "uninstall",
  interactive: boolean,
): Promise<void> {
  await runRootCommand("env", [
    `PORTLESS_STATE_DIR=${hestiaPortlessStateDir()}`,
    "PORTLESS_SYNC_HOSTS=0",
    `HESTIA_PORTLESS_ROUTES_PATH=${hestiaPortlessAliasesPath()}`,
    "HESTIA_PORTLESS_ROOT_STATE=1",
    `HESTIA_PORTLESS_ROUTES_UID=${process.getuid?.() ?? 0}`,
    HESTIA_ROUTER_BUN,
    HESTIA_ROUTER_CLI,
    "service",
    action,
  ], interactive);
}

async function rollbackHardenedPortlessInstall(interactive: boolean): Promise<void> {
  await runRootCommand("launchctl", ["bootout", "system", PORTLESS_LAUNCHD_PLIST], interactive, true);
  await runRootCommand("rm", ["-f", PORTLESS_LAUNCHD_PLIST], interactive, true);
  try {
    await removeHestiaPortlessCa(interactive);
  } catch {}
  await runRootCommand("rm", ["-rf", HESTIA_ROUTER_INSTALL_DIR], interactive, true);
  rmSync(dirname(hestiaPortlessAliasesPath()), { recursive: true, force: true });
}

async function trustHestiaPortlessCa(interactive: boolean): Promise<void> {
  await runRootCommand("env", [
    `PORTLESS_STATE_DIR=${hestiaPortlessStateDir()}`,
    "PORTLESS_SYNC_HOSTS=0",
    HESTIA_ROUTER_BUN,
    HESTIA_ROUTER_CLI,
    "trust",
  ], interactive);
}

async function keychainHasFingerprint(keychain: string, fingerprint: string): Promise<boolean> {
  try {
    const { stdout } = await pexec("security", ["find-certificate", "-Z", "-a", keychain], {
      timeout: 10_000,
    });
    return stdout.replaceAll(/[^a-fA-F0-9]/g, "").toLowerCase().includes(fingerprint);
  } catch {
    return false;
  }
}

async function removeHestiaPortlessCa(interactive: boolean): Promise<void> {
  const stateDir = hestiaPortlessStateDir();
  const caPath = join(stateDir, "ca.pem");
  if (!existsSync(caPath)) return;
  const { stdout } = await pexec("openssl", ["x509", "-in", caPath, "-noout", "-fingerprint", "-sha1"], {
    timeout: 10_000,
  });
  const fingerprint = stdout.replace(/^.*=/, "").replaceAll(":", "").trim().toLowerCase();
  const systemKeychain = "/Library/Keychains/System.keychain";
  try {
    const { stdout: loginOutput } = await pexec("security", ["default-keychain", "-d", "user"], {
      timeout: 10_000,
    });
    const loginKeychain = loginOutput.trim().replace(/^"|"$/g, "");
    if (loginKeychain && await keychainHasFingerprint(loginKeychain, fingerprint)) {
      await pexec("security", ["delete-certificate", "-Z", fingerprint, loginKeychain], { timeout: 30_000 });
    }
  } catch (error) {
    throw new Error(`could not remove Hestia CA from the login keychain: ${(error as Error).message}`);
  }
  if (await keychainHasFingerprint(systemKeychain, fingerprint)) {
    const args = ["security", "delete-certificate", "-Z", fingerprint, systemKeychain];
    if (interactive) {
      const result = spawnSync("sudo", args, { stdio: "inherit", timeout: 60_000 });
      if (result.error !== undefined || result.status !== 0) {
        throw result.error ?? new Error(`security delete-certificate exited ${result.status}`);
      }
    } else {
      await pexec("sudo", ["-n", ...args], { timeout: 60_000 });
    }
  }
}

function requireNonInteractivePrivilege(): void {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const result = spawnSync("sudo", ["-n", "true"], {
    stdio: "ignore",
    timeout: 2_000,
  });
  if (result.status !== 0) {
    throw new HestiaError(
      "router-privilege-required",
      "Router install: trusted HTTPS setup requires an administrator action",
      { command: "hestia router install --interactive", requiresTTY: true },
    );
  }
}

async function loopbackPortIsBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForInstalledHestiaRouter(timeoutMs = 10_000): Promise<HestiaRouterStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await readHestiaRouterStatus();
  while (Date.now() < deadline && !(status.installed && status.running && status.trusted)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await readHestiaRouterStatus();
  }
  if (!(status.installed && status.running && status.trusted)) {
    throw new HestiaError(
      "router-unreachable",
      "Router install did not produce a running, trusted, Hestia-owned service",
    );
  }
  return status;
}

async function waitForRunningHestiaRouter(timeoutMs = 10_000): Promise<HestiaRouterStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await readHestiaRouterStatus();
  while (Date.now() < deadline && !(status.installed && status.running)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await readHestiaRouterStatus();
  }
  if (!(status.installed && status.running)) {
    throw new HestiaError(
      "router-unreachable",
      "Router payload upgrade did not produce a running, Hestia-owned service",
    );
  }
  return status;
}

async function returnWithCurrentDaemon(status: HestiaRouterStatus): Promise<HestiaRouterStatus> {
  await ensureDaemon();
  return status;
}

async function upgradeHardenedPortlessPayloadUnlocked(
  interactive: boolean,
): Promise<HestiaRouterStatus> {
  const stagedPortless = join(HESTIA_ROUTER_STAGED_DIR, "portless");
  const stagedBun = join(HESTIA_ROUTER_STAGED_DIR, "bun");
  const previousPortless = join(HESTIA_ROUTER_PREVIOUS_DIR, "portless");
  const previousBun = join(HESTIA_ROUTER_PREVIOUS_DIR, "bun");
  let preservePrevious = false;
  try {
    await runRootCommand("rm", ["-rf", HESTIA_ROUTER_STAGED_DIR, HESTIA_ROUTER_PREVIOUS_DIR], interactive);
    await prepareHardenedPortlessPayloadAt(HESTIA_ROUTER_STAGED_DIR, interactive);
    await runRootCommand("mkdir", ["-p", HESTIA_ROUTER_PREVIOUS_DIR], interactive);
    await runRootCommand("ditto", [HESTIA_ROUTER_PORTLESS, previousPortless], interactive);
    await runRootCommand("cp", [HESTIA_ROUTER_BUN, previousBun], interactive);
    await runHardenedPortlessService("uninstall", interactive);
    try {
      await runRootCommand("rm", ["-rf", HESTIA_ROUTER_PORTLESS], interactive);
      await runRootCommand("ditto", [stagedPortless, HESTIA_ROUTER_PORTLESS], interactive);
      await runRootCommand("cp", [stagedBun, HESTIA_ROUTER_BUN], interactive);
      await runRootCommand("chown", ["-R", "root:wheel", HESTIA_ROUTER_INSTALL_DIR], interactive);
      await runRootCommand("chmod", ["-R", "go-w", HESTIA_ROUTER_INSTALL_DIR], interactive);
      await runHardenedPortlessService("install", interactive);
      return await waitForRunningHestiaRouter();
    } catch (upgradeError) {
      await runHardenedPortlessService("uninstall", interactive).catch(() => {});
      try {
        await runRootCommand("rm", ["-rf", HESTIA_ROUTER_PORTLESS], interactive);
        await runRootCommand("ditto", [previousPortless, HESTIA_ROUTER_PORTLESS], interactive);
        await runRootCommand("cp", [previousBun, HESTIA_ROUTER_BUN], interactive);
        await runRootCommand("chown", ["-R", "root:wheel", HESTIA_ROUTER_INSTALL_DIR], interactive);
        await runRootCommand("chmod", ["-R", "go-w", HESTIA_ROUTER_INSTALL_DIR], interactive);
        await runHardenedPortlessService("install", interactive);
        await waitForRunningHestiaRouter();
      } catch (restoreError) {
        preservePrevious = true;
        throw new Error(
          `new payload failed (${(upgradeError as Error).message}); previous payload restore failed ` +
          `(${(restoreError as Error).message})`,
        );
      }
      throw upgradeError;
    }
  } finally {
    await runRootCommand("rm", ["-rf", HESTIA_ROUTER_STAGED_DIR], interactive, true);
    if (!preservePrevious) {
      await runRootCommand("rm", ["-rf", HESTIA_ROUTER_PREVIOUS_DIR], interactive, true);
    }
  }
}

async function upgradeHardenedPortlessPayload(
  interactive: boolean,
): Promise<HestiaRouterStatus> {
  const uid = process.getuid?.() ?? 501;
  const lockRoot = join(tmpdir(), `hestia-${uid}`, "router-payload-upgrade");
  return withLock(
    lockRoot,
    () => upgradeHardenedPortlessPayloadUnlocked(interactive),
    120_000,
  );
}

/** Install the trusted Portless service; non-interactive mode never waits for sudo. */
export async function installHestiaRouter(interactive: boolean): Promise<HestiaRouterStatus> {
  const ownership = requireHestiaServiceOwnership("install");
  const existing = await readHestiaRouterStatus();
  const payloadCurrent = ownership === "hestia" && installedPortlessPayloadIsCurrent();
  if (ownership === "hestia" && existing.running && existing.trusted && payloadCurrent) {
    return returnWithCurrentDaemon(existing);
  }
  if (ownership === "hestia" && existing.running && !payloadCurrent) {
    if (interactive && !process.stdin.isTTY) {
      throw new HestiaError("router-privilege-required", "Router install: --interactive requires a TTY");
    }
    if (!interactive) requireNonInteractivePrivilege();
    try {
      let upgraded = await upgradeHardenedPortlessPayload(interactive);
      if (!upgraded.trusted) {
        await trustHestiaPortlessCa(interactive);
        upgraded = await waitForInstalledHestiaRouter();
      }
      return returnWithCurrentDaemon(upgraded);
    } catch (error) {
      const detail = (error as { stderr?: string; message?: string }).stderr ?? (error as Error).message;
      throw new HestiaError("router-unreachable", `Router payload upgrade failed: ${detail.trim()}`);
    }
  }
  if (ownership === "hestia" && existing.running) {
    if (interactive && !process.stdin.isTTY) {
      throw new HestiaError("router-privilege-required", "Router install: --interactive requires a TTY");
    }
    if (!interactive) requireNonInteractivePrivilege();
    try {
      await trustHestiaPortlessCa(interactive);
    } catch (error) {
      throw new HestiaError("router-unreachable", `Router trust failed: ${(error as Error).message}`);
    }
    const trusted = await readHestiaRouterStatus();
    if (!trusted.trusted) throw new HestiaError("router-unreachable", "Router trust failed: CA remains untrusted");
    return returnWithCurrentDaemon(trusted);
  }
  if (await loopbackPortIsBusy(443)) {
    throw new HestiaError("router-port-busy", "Router install: port 443 is already owned by another process");
  }
  if (interactive) {
    if (!process.stdin.isTTY) {
      throw new HestiaError("router-privilege-required", "Router install: --interactive requires a TTY");
    }
  } else {
    requireNonInteractivePrivilege();
  }
  ensureDir(dirname(hestiaPortlessAliasesPath()));
  if (!existsSync(hestiaPortlessAliasesPath())) {
    writeAtomicJsonFile(hestiaPortlessAliasesPath(), []);
  }
  try {
    // Bootstrap only from the already root-owned payload. There is never a
    // root LaunchDaemon whose ProgramArguments reference workspace files.
    await prepareHardenedPortlessPayload(interactive);
    await runHardenedPortlessService("install", interactive);
  } catch (error) {
    await rollbackHardenedPortlessInstall(interactive);
    const detail = (error as { stderr?: string; message?: string }).stderr ?? (error as Error).message;
    if (/address already in use|port 443|EADDRINUSE/i.test(detail)) {
      throw new HestiaError("router-port-busy", "Router install: port 443 is already owned by another process");
    }
    throw new HestiaError("router-unreachable", `Router install failed: ${detail.trim()}`);
  }
  return returnWithCurrentDaemon(await waitForInstalledHestiaRouter());
}

/** Uninstall the Hestia-owned Portless service; non-interactive mode never waits for sudo. */
export async function uninstallHestiaRouter(interactive: boolean): Promise<HestiaRouterStatus> {
  const ownership = requireHestiaServiceOwnership("uninstall");
  if (ownership === "absent" && !existsSync(hestiaPortlessAliasesPath())) {
    return readHestiaRouterStatus();
  }
  if (interactive && !process.stdin.isTTY) {
    throw new HestiaError("router-privilege-required", "Router uninstall: --interactive requires a TTY");
  }
  if (!interactive) requireNonInteractivePrivilege();
  try {
    if (ownership === "hestia") {
      await runHardenedPortlessService("uninstall", interactive);
    }
    await removeHestiaPortlessCa(interactive);
    if (ownership === "hestia") {
      await runRootCommand("rm", ["-rf", HESTIA_ROUTER_INSTALL_DIR], interactive);
    }
    rmSync(dirname(hestiaPortlessAliasesPath()), { recursive: true, force: true });
  } catch (error) {
    const detail = (error as { stderr?: string; message?: string }).stderr ?? (error as Error).message;
    throw new HestiaError("router-unreachable", `Router uninstall failed: ${detail.trim()}`);
  }
  return readHestiaRouterStatus();
}
