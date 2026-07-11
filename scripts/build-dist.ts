import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = dirname(import.meta.dir);
const dist = join(root, "dist");
const expectedPortlessVersion = "0.15.1";
const expectedPatchSha256 = "8b31085f9991c9df1fde89c21bb9fc0d8f310b9a440556a5144969181eca7e05";
const runtimeExternals = ["@opentui/core", "@opentui/react", "react", "portless"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true, mode: 0o700 });

async function bundle(entrypoint: string, outputName: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, entrypoint)],
    outdir: dist,
    naming: outputName,
    target: "bun",
    format: "esm",
    sourcemap: "external",
    external: runtimeExternals,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to build ${entrypoint}`);
  }
}

await bundle("packages/cli/src/index.ts", "cli.js");
await bundle("packages/engine/src/daemon/main.ts", "daemon.js");
await bundle("packages/engine/src/proc/proc-relay.ts", "proc-relay.js");

const portlessRoot = join(root, "node_modules", "portless");
const portlessPackage = JSON.parse(readFileSync(join(portlessRoot, "package.json"), "utf8")) as {
  version?: string;
};
if (portlessPackage.version !== expectedPortlessVersion) {
  throw new Error(`expected Portless ${expectedPortlessVersion}, found ${String(portlessPackage.version)}`);
}
const patchPath = join(root, "patches", `portless@${expectedPortlessVersion}.patch`);
const patchSha256 = createHash("sha256").update(readFileSync(patchPath)).digest("hex");
if (patchSha256 !== expectedPatchSha256) {
  throw new Error(`Portless patch checksum mismatch: ${patchSha256}`);
}
const assetRoot = join(dist, "assets", "portless");
mkdirSync(assetRoot, { recursive: true });
cpSync(join(portlessRoot, "dist"), join(assetRoot, "dist"), { recursive: true });
cpSync(join(portlessRoot, "package.json"), join(assetRoot, "package.json"));
cpSync(patchPath, join(assetRoot, "hestia-hardening.patch"));
const hardenedCli = join(assetRoot, "dist", "cli.js");
if (!readFileSync(hardenedCli, "utf8").includes("HESTIA_PORTLESS_ROUTES_PATH")) {
  const patched = Bun.spawnSync(["patch", "-p1", "-i", patchPath], {
    cwd: assetRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (patched.exitCode !== 0) {
    throw new Error(`could not apply Portless hardening patch: ${patched.stderr.toString()}`);
  }
}
if (!readFileSync(hardenedCli, "utf8").includes("HESTIA_PORTLESS_ROUTES_PATH")) {
  throw new Error("Portless payload is missing Hestia hardening after patch application");
}
writeFileSync(join(assetRoot, "provenance.json"), JSON.stringify({
  package: "portless",
  version: expectedPortlessVersion,
  patchSha256,
}, null, 2) + "\n");

for (const executable of ["cli.js", "daemon.js", "proc-relay.js"]) {
  const path = join(dist, executable);
  const source = readFileSync(path, "utf8");
  if (!source.startsWith("#!")) writeFileSync(path, `#!/usr/bin/env bun\n${source}`);
}
