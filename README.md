# hestia

Per-worktree isolated dev stacks. `hestia up` in a git worktree brings up that
worktree's docker compose services on **ephemeral host ports** with connection
env injected, isolated from every other worktree — so parallel agents never
fight over ports, databases, or container names.

This is the **MVP**: the docker compose backend only. Host processes (wrangler
dev, next dev), the concurrency daemon, logs, and the TUI are later efforts
layered on the same engine seam (see `packages/core/src/types.ts` →
`IsolationEngine`). Full plan and roadmap: the approved plan doc.

**Nothing is committed to the target repo — there is one interface, zero-config.**
`hestia up` reads the repo's existing compose file, brings up the services on
ephemeral ports, and hands back each service's port as `HESTIA_<SVC>_PORT` and a
structured `endpoints[]` in `hestia up --json`. The caller — an agent, a script,
or the CLI later — wires whatever URL it needs (`DATABASE_URL`, …) from those
ports. hestia has no config file of its own.

## How it works

`hestia up` derives a deterministic compose project name from `(repo, branch)`,
generates a compose **override** (never touching your compose file) that:

- replaces pinned host ports with ephemeral loopback publishes (`127.0.0.1:0:…`),
  so Docker assigns a free port per worktree,
- rewrites any pinned `container_name` (it would collide even under `-p`),
- sets `restart: "no"` so Docker never hands a container a new port behind us,
- labels every container `dev.hestia.*` for discovery.

It then reads the assigned ports back (`docker compose ps --format json`),
surfaces them as `HESTIA_<SVC>_PORT` + `endpoints[]`, and writes state to
`<worktree>/.hestia/stack.json` (mirrored to `~/.hestia/stacks/<project>/` so
`down` works even if the worktree is deleted). No config file, no long-lived
daemon.

## Usage

```
hestia up   [--services a,b] [--json]   # bring up this worktree's stack
hestia down [--destroy]     [--json]    # tear down (--destroy also drops volumes)
hestia status               [--json]
hestia env                  [--json]    # HESTIA_<SVC>_PORT as export lines, or JSON
hestia endpoint list        [--json]
```

Just run `hestia up` in a repo with a compose file; read the ports back from
`--json` (`env.HESTIA_<SVC>_PORT` or `endpoints[]`) and wire your own URLs.
`--services a,b` restricts to a subset of the compose services.

## Develop

```
bun install
bun test            # unit (naming, override) + docker-gated e2e isolation test
bunx tsc --noEmit   # typecheck
```

The e2e test (`test/e2e/isolation.test.ts`) spins two real git worktrees of a
self-contained, config-free postgres fixture, brings up both stacks, and asserts
distinct ephemeral ports, live TCP connectivity, and isolated teardown. It skips
cleanly when Docker is unavailable.
