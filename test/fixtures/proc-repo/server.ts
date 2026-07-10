// e2e fixture: serves $PORT and spawns a child so pgid teardown is provable.
import { spawn } from "node:child_process";

const port = Number(process.env.PORT);
const child = spawn("sleep", ["600"], { stdio: "ignore" });

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () =>
    new Response(
      JSON.stringify({ marker: process.env.WORKTREE_MARKER ?? "", childPid: child.pid }),
      { headers: { "content-type": "application/json" } },
    ),
});
