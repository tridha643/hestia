import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hestiaHome } from "../state.ts";
import { HestiaError } from "@hestia/core";
import { writeAtomicTextFile } from "../atomic-json-file.ts";

export const LAUNCHD_LABEL = "dev.hestia.daemon";

/** HESTIA_LAUNCHD_DIR overrides for tests — they must never touch the real LaunchAgents. */
export function launchAgentsDir(): string {
  return process.env.HESTIA_LAUNCHD_DIR ?? join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(): string {
  return join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
}

export function daemonMainPath(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "daemon.js");
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL("./main.ts", import.meta.url));
}

function xml(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface PlistInput {
  bunPath: string;
  mainPath: string;
  /** Full PATH baked in — gui LaunchAgents inherit only /usr/bin:/bin:/usr/sbin:/sbin,
   * which has neither cloudflared nor docker, so revival would ENOENT without this. */
  path: string;
  logPath: string;
  hestiaHome?: string;
}

export function generatePlist(input: PlistInput): string {
  const env: string[] = [
    `      <key>PATH</key><string>${xml(input.path)}</string>`,
  ];
  if (input.hestiaHome !== undefined) {
    env.push(`      <key>HESTIA_HOME</key><string>${xml(input.hestiaHome)}</string>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(input.bunPath)}</string>
      <string>run</string>
      <string>${xml(input.mainPath)}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <!-- SuccessfulExit:false — respawn crashes only. Plain 'true' would respawn
         the single-instance guard's exit-0 forever and make 'daemon stop' a lie. -->
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
${env.join("\n")}
    </dict>
    <key>StandardOutPath</key><string>${xml(input.logPath)}</string>
    <key>StandardErrorPath</key><string>${xml(input.logPath)}</string>
  </dict>
</plist>
`;
}

/** The plist input for THIS checkout + environment, with tool-resolution warnings. */
export function currentPlistInput(): { input: PlistInput; warnings: string[] } {
  const warnings: string[] = [];
  const path = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  for (const tool of ["cloudflared", "docker"]) {
    if (Bun.which(tool) === null) {
      warnings.push(
        `${tool} not found in PATH — the daemon won't be able to run it after a reboot ` +
          `(install it, then re-run \`hestia daemon install\`)`,
      );
    }
  }
  return {
    input: {
      bunPath: process.execPath,
      mainPath: daemonMainPath(),
      path,
      logPath: join(hestiaHome(), "daemon", "launchd.log"),
      hestiaHome: process.env.HESTIA_HOME,
    },
    warnings,
  };
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function launchctl(...args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: (err as { stderr?: string }).stderr ?? String(err) };
  }
}

/** Whether launchd currently manages the label (decides stop's bootout-vs-kill). */
export function isBootstrapped(): boolean {
  if (process.platform !== "darwin") return false;
  return launchctl("print", `${domain()}/${LAUNCHD_LABEL}`).ok;
}

/**
 * Whether the bootstrapped agent manages the CURRENT hestia home. launchd is
 * machine-global but HESTIA_HOME is not — a CLI under a test/temp home must
 * never bootout or kickstart the real agent (found live: a HESTIA_HOME=tmp
 * e2e's `daemon stop` booted the user's real agent out).
 */
export function launchdManagesThisHome(): boolean {
  if (!isBootstrapped()) return false;
  try {
    const content = readFileSync(plistPath(), "utf8");
    const home = /<key>HESTIA_HOME<\/key><string>([^<]*)<\/string>/.exec(content)?.[1];
    return home === process.env.HESTIA_HOME || (home === undefined && process.env.HESTIA_HOME === undefined);
  } catch {
    return false;
  }
}

export function kickstart(): { ok: boolean; output: string } {
  return launchctl("kickstart", "-k", `${domain()}/${LAUNCHD_LABEL}`);
}

export interface InstallResult {
  plist: string;
  /** Set when the plist was actually written + bootstrapped. */
  installedAt?: string;
  warnings: string[];
}

/**
 * Write + bootstrap the LaunchAgent (macOS). `print` renders the plist and
 * instructions without touching the system — also the non-darwin behavior.
 */
export function installLaunchd(opts?: { print?: boolean }): InstallResult {
  const { input, warnings } = currentPlistInput();
  const plist = generatePlist(input);
  if (opts?.print === true || process.platform !== "darwin") {
    if (process.platform !== "darwin") {
      warnings.push(
        "launchd is macOS-only — wire the equivalent (systemd user unit) yourself: " +
          `run \`${input.bunPath} run ${input.mainPath}\` at login with the printed PATH`,
      );
    }
    return { plist, warnings };
  }
  mkdirSync(launchAgentsDir(), { recursive: true });
  mkdirSync(dirname(input.logPath), { recursive: true });
  const target = plistPath();
  const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
  const previouslyBootstrapped = isBootstrapped();
  const rollback = (): void => {
    launchctl("bootout", `${domain()}/${LAUNCHD_LABEL}`);
    if (previous === null) rmSync(target, { force: true });
    else writeAtomicTextFile(target, previous);
    if (previouslyBootstrapped && previous !== null) {
      launchctl("bootstrap", domain(), target);
      launchctl("kickstart", "-k", `${domain()}/${LAUNCHD_LABEL}`);
    }
  };
  // Re-install must supersede a live agent: boot it out first (ignore "not loaded").
  launchctl("bootout", `${domain()}/${LAUNCHD_LABEL}`);
  writeAtomicTextFile(target, plist);
  const boot = launchctl("bootstrap", domain(), target);
  if (!boot.ok) {
    rollback();
    throw new HestiaError(
      "launchd-install-failed",
      `launchctl bootstrap failed and the previous agent was restored: ${boot.output.trim()}`,
    );
  }
  const started = kickstart();
  if (!started.ok) {
    rollback();
    throw new HestiaError(
      "launchd-install-failed",
      `launchctl kickstart failed and the previous agent was restored: ${started.output.trim()}`,
    );
  }
  return { plist, installedAt: target, warnings };
}

export function uninstallLaunchd(): { removed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (process.platform !== "darwin") return { removed: false, warnings };
  const out = launchctl("bootout", `${domain()}/${LAUNCHD_LABEL}`);
  if (!out.ok && !out.output.includes("No such process")) {
    warnings.push(`launchctl bootout: ${out.output.trim()}`);
  }
  const target = plistPath();
  const existed = existsSync(target);
  rmSync(target, { force: true });
  return { removed: existed, warnings };
}
