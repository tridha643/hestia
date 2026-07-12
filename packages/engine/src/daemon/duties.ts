import { isLive } from "../proc/pidfile.ts";
import {
  connectorPidfile,
  listAdopted,
  readAdopted,
  reconcileTunnel,
} from "../tunnel/registry.ts";
import type { Admission } from "./routes.ts";
import type { SharedArbiter } from "./shared-arbiter.ts";

const SWEEP_INTERVAL_MS = 15_000;

/**
 * The daemon's standing duties, on one overlap-guarded interval:
 *  - re-derive occupancy and grant queued waiters (frees slots whose stacks
 *    died without a `down`, expires dead-holder reservations),
 *  - revive dead connectors of adopted tunnels — base rules must keep serving
 *    even with zero live stacks; this is what makes `tri`'s uptime survive
 *    crashes and (via launchd) reboots.
 *
 * Every duty is error-contained: a CLI legitimately holding the global tunnel
 * lock through an expose ready-poll makes reconcile throw lock-timeout — log,
 * retry next tick, never kill the interval.
 */
export function startDuties(
  admission: Admission,
  opts?: { intervalMs?: number; log?: (line: string) => void; shared?: SharedArbiter },
): () => void {
  const log = opts?.log ?? ((line) => console.error(line));
  let running = false;

  const tick = async () => {
    if (running) return; // overlap guard — a slow docker probe must not stack ticks
    running = true;
    try {
      try {
        await admission.pump();
      } catch (err) {
        log(`sweep: pump failed: ${(err as Error).message}`);
      }
      if (opts?.shared !== undefined) {
        try {
          // pump() just refreshed the cached occupancy — live ∪ reserved is
          // the "still occupying a slot" set that keeps a holder's claim.
          const state = admission.healthSnapshot();
          await opts.shared.sweep(new Set([...state.live, ...state.reserved]));
        } catch (err) {
          log(`sweep: shared-hostname sweep failed: ${(err as Error).message}`);
        }
      }
      for (const uuid of listAdopted()) {
        try {
          const pf = connectorPidfile(uuid);
          if (pf !== null && isLive(pf)) continue; // healthy — CLI ops keep config current
          const ref = readAdopted(uuid);
          if (ref === null) continue;
          if (ref.reconstructed) {
            log(
              `sweep: reviving connector for ${uuid} from a legacy marker ` +
                `(name=${ref.name}); the marker will be re-written enriched`,
            );
          }
          const outcome = await reconcileTunnel(ref);
          if (outcome.restarted) {
            log(`sweep: connector for ${ref.name} (${uuid}) revived (ready=${outcome.ready})`);
          }
        } catch (err) {
          log(`sweep: connector revival for ${uuid} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, opts?.intervalMs ?? SWEEP_INTERVAL_MS);
  void tick(); // first pass immediately — reboot revival shouldn't wait a tick
  return () => clearInterval(timer);
}
