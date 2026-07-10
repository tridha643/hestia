/**
 * Runtime verification against cloudflared's metrics endpoint (loopback only):
 * /ready returns 200 + {readyConnections} once the connector holds an edge
 * connection; /quicktunnel returns {"hostname":"…trycloudflare.com"} for quick
 * tunnels (empty hostname on named tunnels).
 */

const POLL_MS = 300;

async function get(port: number, path: string): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    return null;
  }
}

/** True once /ready reports ≥1 edge connection within the timeout. */
export async function pollReady(
  metricsPort: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(metricsPort, "/ready");
    if (res !== null && res.ok) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

/** One-shot /ready check (status refresh). */
export async function isReady(metricsPort: number): Promise<boolean> {
  const res = await get(metricsPort, "/ready");
  return res !== null && res.ok;
}

/** Poll /quicktunnel until the assigned *.trycloudflare.com URL appears. */
export async function quickTunnelUrl(
  metricsPort: number,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(metricsPort, "/quicktunnel");
    if (res !== null && res.ok) {
      try {
        const body = (await res.json()) as { hostname?: string };
        if (body.hostname !== undefined && body.hostname !== "") {
          return `https://${body.hostname}`;
        }
      } catch {
        // not JSON yet — keep polling
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}
