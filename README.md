# hestia

Per-worktree isolated dev stacks. `hestia up` in a git worktree brings up that
worktree's docker compose services on **ephemeral host ports** with connection
env injected, isolated from every other worktree — so parallel agents never
fight over ports, databases, or container names.

The shipped stack includes Docker Compose, supervised host processes
(wrangler/next/vite), public Cloudflare ingress, the machine-wide hestiad
capacity daemon, pull-based logs, a repo-scoped Fleet TUI, and optional stable
local HTTPS URLs through an isolated Portless router. Every surface drives the
same `IsolationEngine` seam.

**Nothing is committed to the target repo — there is one interface, zero-config.**
`hestia up` reads the repo's existing compose file, brings up the services on
ephemeral ports, and hands back each service's port as `HESTIA_<SVC>_PORT` and a
structured `endpoints[]` in `hestia up --json`. The caller — an agent, a script,
or the CLI later — wires whatever URL it needs (`DATABASE_URL`, …) from those
ports. Optional repository route defaults live in machine-local
`~/.hestia/config.toml`; Hestia never writes them to the target repository.
The privileged Portless service keeps writable runtime/TLS state under the
root-owned `/Library/Application Support/Hestia/router/state`; hestiad only
publishes a validated alias projection under `~/.hestia/router/portless/` for
Portless to read, never write.

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
`down` works even if the worktree is deleted). hestiad derives live Fleet
state from those mirrors and owns capacity admission plus authenticated log
streaming; it never becomes the source of truth for stack liveness.

## Usage

```
hestia up [--workers[=a,b]] [--json]    # compose + optional wrangler workers
hestia run --name web -- <command...>   # supervised host process on a safe port
hestia logs [service...] -f [--json]    # pull-based proc/docker stream
hestia expose web [--tunnel tri]        # quick or adopted named public ingress
hestia route add web api --json         # stable local HTTPS, service names only
hestia route remove web --json          # remove worktree CLI intent
hestia route list --json                # effective explicit + TOML routes
hestia router status|install|uninstall  # isolated Portless service
hestia config path|show|validate        # machine-local TOML helpers
hestia open web [--direct|--local|--public]
hestia tui                              # interactive repo-scoped Fleet cockpit
hestia down [--destroy] [--json]        # default retains named volumes
hestia status | env | endpoint list
hestia doctor [--json]
```

For routed HTTP services, `Endpoint.url` and `HESTIA_<SVC>_DIRECT_URL` are the
ephemeral `127.0.0.1:<port>` surface, `Endpoint.localUrl` and
`HESTIA_<SVC>_LOCAL_URL` are stable localhost HTTPS, and
`Endpoint.publicUrl` / `HESTIA_<SVC>_URL` retain Cloudflare ingress semantics.
Raw TCP services continue to use host and port directly.

`hestia tui` shows only stacks Hestia currently manages for the invoking Git
repository. Its first release is observational except for a named,
double-confirmed `down` action; that action always retains named volumes.
Stack and service rows are mouse-selectable, the log pane accepts wheel
scrolling, and reconnect backfill is overlap-deduplicated before it reaches the
visible ring.

## Develop

```
bun install
bun test            # unit + proc/daemon/TUI PTY; Docker/Wrangler auto-gated
bun run test:tui    # OpenTUI component + Tuistory PTY gates
bunx tsc --noEmit   # typecheck
```

The opt-in modem ship gate runs the real Postgres, ingest/slack Wrangler
workers, Next dashboard, Fleet transport, logs, and confirmed-down behavior:

```
HESTIA_E2E_MODEM_REPO=/path/to/modem \
HESTIA_E2E_MODEM_REF=origin/main \
HESTIA_E2E_MODEM_ENV_FILE=/path/to/modem-e2e.env \
bun test test/e2e/modem-tui.test.ts
```
