import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "..", "cli", "src", "index.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bun", [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("stable CLI contract", () => {
  test("version JSON exposes all compatibility numbers", () => {
    const result = run(["version", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cliVersion: "1.3.0",
      stateSchema: 1,
      daemonProtocol: 6,
      runtime: "bun",
    });
  });

  test("rejects unknown, inapplicable, missing, invalid enum, and non-finite options", () => {
    for (const args of [
      ["status", "--bogus", "--json"],
      ["version", "--destroy", "--json"],
      ["run", "--signal", "kill", "--json", "--", "true"],
      ["run", "--ready-timeout", "Infinity", "--json", "--", "true"],
      ["run", "--name", "--json", "--", "true"],
    ]) {
      const result = run(args);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("usage");
    }
  });

  test("init writes require explicit scope", () => {
    const result = run(["init", "proc", "consumer", "--write", "--json", "--", "true"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.message).toContain("--scope");
  });
});
