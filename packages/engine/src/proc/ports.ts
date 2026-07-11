import { createServer } from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { HestiaError } from "@hestia/core";

const pexec = promisify(execFile);

/** Bind-probe 127.0.0.1:0, close, hand the freed port to the proc. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface PsRow {
  pid: number;
  pgid: number;
  ppid: number;
}

function psSnapshot(): PsRow[] {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows: PsRow[] = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
      if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]) });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * The spawned root plus every live descendant, with pgids. Membership is
 * ancestry, NOT process group: env-resolver wrappers (varlock's runner) put
 * their child in a fresh group, so the group id alone loses the subtree.
 */
export function processTree(rootPid: number): PsRow[] {
  const rows = psSnapshot();
  const byParent = new Map<number, PsRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? [];
    list.push(r);
    byParent.set(r.ppid, list);
  }
  const tree: PsRow[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = rows.find((r) => r.pid === pid);
    if (self !== undefined) tree.push(self);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return tree;
}

export interface Listener {
  pid: number;
  port: number;
}

/** `lsof -F` machine output: `p<pid>` lines then `n<addr>` lines per socket. */
function parseLsof(out: string): Listener[] {
  const listeners: Listener[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const m = line.match(/:(\d+)(?:->|$| )/);
      if (m) listeners.push({ pid, port: Number(m[1]) });
    }
  }
  return listeners;
}

/** `ss -tlnp`: local addr in col 4, `pid=` inside the users:(...) column. */
function parseSs(out: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of out.split("\n")) {
    const pidM = line.match(/pid=(\d+)/);
    const portM = line.match(/[\s:]\S*:(\d+)\s+\S+:\*/);
    if (pidM && portM) {
      listeners.push({ pid: Number(pidM[1]), port: Number(portM[1]) });
    }
  }
  return listeners;
}

let tool: "lsof" | "ss" | undefined;

export async function allListeners(): Promise<Listener[]> {
  if (tool !== "ss") {
    try {
      const { stdout } = await pexec(
        "lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      tool = "lsof";
      return parseLsof(stdout);
    } catch (err) {
      const e = err as { code?: string; stdout?: string };
      // lsof exits 1 when nothing matches but still prints what it found
      if (typeof e.stdout === "string" && e.code !== "ENOENT") {
        tool = "lsof";
        return parseLsof(e.stdout);
      }
      if (tool === "lsof") return [];
    }
  }
  try {
    const { stdout } = await pexec("ss", ["-tlnp"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    tool = "ss";
    return parseSs(stdout);
  } catch {
    throw new HestiaError(
      "ownership-tool-missing",
      "neither lsof nor ss is available — cannot verify port ownership " +
        "(required: tools like next dev silently bind a different port when " +
        "theirs is taken, so a bare listen-check would report the wrong port healthy)",
    );
  }
}

/**
 * The readiness oracle. Who owns the assigned port decides:
 *  - a process in our spawned tree listens on it → ready
 *  - a process OUTSIDE the tree listens on it → definitive steal (this is
 *    precisely the condition that makes next/vite silently auto-increment)
 *    → kill + retry
 *  - nobody yet → still booting; on timeout the tree's actual listening ports
 *    are reported so "bound 3001, not the assigned port" is visible.
 * Tree ancestry (not "listens elsewhere") is the discriminator because dev
 * trees open legitimate extra sockets (workerd control sockets, inspectors).
 */
export interface PortView {
  /** Listener on the given port, if any. */
  owner: Listener | undefined;
  ownerIsMember: boolean;
  /** All ports the process tree currently listens on (for diagnostics). */
  memberPorts: number[];
  groupAlive: boolean;
}

export async function inspectPort(
  rootPid: number,
  port: number,
): Promise<PortView> {
  const members = new Set(processTree(rootPid).map((r) => r.pid));
  const listeners = await allListeners();
  const owner = listeners.find((l) => l.port === port);
  // A freshly spawned relay can fork the target between the ps snapshot and
  // lsof. Re-snapshot before declaring a listener foreign; a false steal
  // would kill a correctly bound dev server and churn through all retries.
  if (owner !== undefined && !members.has(owner.pid)) {
    for (const member of processTree(rootPid)) members.add(member.pid);
  }
  return {
    owner,
    ownerIsMember: owner !== undefined && members.has(owner.pid),
    memberPorts: listeners.filter((l) => members.has(l.pid)).map((l) => l.port),
    groupAlive: members.size > 0,
  };
}
