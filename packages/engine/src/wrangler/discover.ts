import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface WorkerConfig {
  /** Absolute path to the wrangler config. */
  configPath: string;
  /** Top-level worker name; null when absent (redirected/inherited configs). */
  name: string | null;
  /** `remote: true` appears anywhere in the config — conservatively includes
   * env.* blocks, since `wrangler dev -c` runs the top-level env but a remote
   * binding anywhere signals real-Cloudflare traffic worth an explicit opt-in. */
  hasRemote: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hestia"]);

/**
 * Strip JSONC down to JSON: // and /* *\/ comments plus trailing commas,
 * tracked through string literals so URLs and quoted braces survive.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      // drop if the next non-whitespace closes a container
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function parseName(configPath: string, text: string): string | null {
  if (configPath.endsWith(".toml")) {
    // top-level only: stop at the first [section] header
    const topLevel = text.split(/^\s*\[/m)[0]!;
    const m = topLevel.match(/^\s*name\s*=\s*"([^"]+)"/m);
    return m ? m[1]! : null;
  }
  try {
    const doc = JSON.parse(stripJsonc(text)) as { name?: unknown };
    return typeof doc.name === "string" ? doc.name : null;
  } catch {
    return null;
  }
}

function detectRemote(configPath: string, text: string): boolean {
  return configPath.endsWith(".toml")
    ? /^\s*remote\s*=\s*true/m.test(text)
    : /"remote"\s*:\s*true/.test(text);
}

/** All wrangler configs in the worktree, skipping vendored/hidden trees. */
export function discoverWorkers(worktreeRoot: string): WorkerConfig[] {
  const glob = new Bun.Glob("**/wrangler.{jsonc,json,toml}");
  const configs: WorkerConfig[] = [];
  for (const rel of glob.scanSync({ cwd: worktreeRoot, onlyFiles: true })) {
    if (rel.split("/").some((part) => SKIP_DIRS.has(part))) continue;
    const configPath = join(worktreeRoot, rel);
    const text = readFileSync(configPath, "utf8");
    configs.push({
      configPath,
      name: parseName(configPath, text),
      hasRemote: detectRemote(configPath, text),
    });
  }
  configs.sort((a, b) => a.configPath.localeCompare(b.configPath));
  return configs;
}

/** `--workers a,b` filter: match by worker name or path substring. */
export function filterWorkers(
  configs: WorkerConfig[],
  worktreeRoot: string,
  filter: string[],
): WorkerConfig[] {
  if (filter.length === 0) return configs;
  return configs.filter((c) => {
    const rel = relative(worktreeRoot, c.configPath);
    return filter.some((f) => c.name === f || rel.includes(f));
  });
}
