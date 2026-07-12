import { isLive, type Pidfile } from "./pidfile.ts";
import { processTree } from "./ports.ts";

const GRACE_MS = 10_000;
const POLL_MS = 200;

type StopTarget = Pick<
  Pidfile,
  "pid" | "pgid" | "startTime" | "signal" | "children"
>;

function signalGroups(pgids: Set<number>, sig: NodeJS.Signals): void {
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, sig);
    } catch {
      // group already gone
    }
  }
}

/**
 * Every process group in the spawned tree. Live root → walk the real tree
 * (exact). Dead root → fall back to the ready-time child snapshot, keeping
 * only identities that still match (pid + verbatim start time), so a recycled
 * pid never gets an innocent group killed.
 */
function groupsOf(t: StopTarget): Set<number> {
  const groups = new Set<number>([t.pgid]);
  if (isLive(t)) {
    for (const row of processTree(t.pid)) groups.add(row.pgid);
  } else {
    for (const c of t.children ?? []) {
      if (isLive(c)) groups.add(c.pgid);
    }
  }
  return groups;
}

function liveIdentities(
  t: StopTarget,
): Array<{ pid: number; startTime: string }> {
  return [
    { pid: t.pid, startTime: t.startTime },
    ...(t.children ?? []),
  ].filter(isLive);
}

async function waitAllDead(t: StopTarget, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveIdentities(t).length === 0) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return liveIdentities(t).length === 0;
}

/**
 * Stop a supervised process tree: signal every group in it (SIGINT for
 * wrangler — its verified clean-shutdown signal — SIGTERM otherwise), grace,
 * then SIGKILL whatever identity still matches. Idempotent: an already-dead
 * (or pid-reused) tree is a successful no-op.
 */
export async function stopProcTree(
  t: StopTarget,
  graceMs = GRACE_MS,
): Promise<void> {
  const groups = groupsOf(t);
  if (liveIdentities(t).length === 0) return;
  signalGroups(groups, t.signal === "int" ? "SIGINT" : "SIGTERM");
  if (await waitAllDead(t, graceMs)) return;
  signalGroups(groupsOf(t), "SIGKILL");
  await waitAllDead(t, 2_000);
}
