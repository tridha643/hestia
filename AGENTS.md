# hestia

Per-worktree isolated dev stacks for parallel coding agents. `hestia up` in a
git worktree brings up that worktree's docker compose services on **ephemeral
host ports**; `hestia run` and `hestia up --workers` supervise **host
processes** (next/vite/wrangler dev) the same way; `hestia expose` publishes
stack services through **cloudflare tunnels** — so parallel agents never fight
over ports, DBs, container names, wrangler service bindings, or public
hostnames.

This branch (`scope-hestia-terminal-tool`) holds the **docker-compose MVP**,
the **phase-2 proc + wrangler backend**, the **phase-3 unified-tunnel public
ingress**, and the **phase-4 hestiad daemon** (machine-wide stack cap +
connector supervision) with `hestia doctor` and the agent skill. Logs, TUI,
and the portless localhost URL router are later efforts layered on the same
`IsolationEngine` seam.

## Layout

- `packages/core` — shared types + naming. The `IsolationEngine` seam and
  `StackRecord`/`ProcSpec`/`Endpoint` shapes are fixed here so the current CLI
  and any future daemon drive the same contract.
- `packages/engine` — the engine (`ComposeEngine`, now compose + procs):
  - `compose/` — override generation, `docker compose` CLI wrapper.
  - `proc/` — host-process supervision: `supervisor` (detached spawn, `{port}`
    templating, readiness), `ports` (bind-probe, process-tree port-ownership
    oracle), `pidfile` (verbatim-`lstart` identity), `shutdown` (group-wide
    signal), `lock` (per-worktree mutation lock), `resolver` (varlock
    composition).
  - `wrangler/` — `discover` (config glob + jsonc/toml parse), `adapter`
    (flag/env injection, foreign-session preflight), `verify` (private-registry
    assertion).
  - `tunnel/` — public ingress: `cloudflared` (CLI wrapper — adopt/route,
    uuid-only mutations), `ingress` (hostname derivation, base-rule import,
    merged-config generation), `registry` (the machine-global single-connector
    singleton + hostname ledger + enriched `adopted.json`), `verify`
    (`/ready`+`/quicktunnel` polling).
  - `daemon/` — hestiad: `main` (entrypoint + in-process single-instance
    guard), `slots` (derived occupancy + persisted reservations), `routes`
    (`Admission` FIFO + `/hestia/*` HTTP), `duties` (sweep: recount, grant,
    connector revival), `ensure` (CLI-side spawn/restart), `client` (HTTP
    client + `daemon.json` discovery), `launchd` (plist gen/install).
  - `doctor.ts` — report-only, concurrently budgeted preflight/state audit.
- `packages/session-broker{-core,,-bun}` — **vendored** from modem-dev/hunk
  (not on npm; see `packages/VENDORED.md` for the pinned commit and the
  no-fork rule). hestiad composes them as an external consumer would.
- `packages/cli` — the `hestia` CLI (`up`/`run`/`expose`/`open`/`stop`/`down`/
  `status`/`env`/`endpoint`/`daemon`/`doctor`), `--json` on every command.
- `skills/hestia/SKILL.md` — the agent skill: workflow, `--json` contract,
  error-code table with remedies, invariants agents must respect.
- `bin/hestia` — bash launcher that execs `bun run packages/cli/src/index.ts`.
- `test/e2e/isolation.test.ts` — docker-gated compose e2e (two real worktrees,
  distinct ephemeral ports, isolated teardown).
- `test/e2e/proc.test.ts` — proc e2e, **no docker needed** (two worktrees,
  pgid-wide teardown, mirror-based `down --project` after worktree deletion,
  concurrent-`run` lock semantics).
- `test/e2e/wrangler.test.ts` — wrangler-gated e2e: two worktrees × two
  service-bound workers; asserts bindings resolve inside each worktree's
  private dev registry. Enable with `cd test/fixtures/wrangler-repo && bun
  install`; skips cleanly otherwise.
- `test/e2e/tunnel.test.ts` — three tiers: full unified-tunnel lifecycle vs a
  **stub cloudflared** (`test/fixtures/tunnel-stub/`, always runs, no network);
  generated ingress vs the **real cloudflared parser** offline (auto-gated on
  the binary); a **real quick tunnel** through the edge (`HESTIA_E2E_TUNNEL=1`).
- `test/e2e/daemon.test.ts` — hestiad e2e, no docker, isolated via
  `HESTIA_HOME`: auto-spawn, cap admit/deny/queue, crash-respawn,
  stop-leaves-stacks, stub-connector revival, doctor budget.
- `hestia-scope.html` / `hestia-tui.html` — scoping doc + TUI design spec.
  Reference-only; not shipped.

## Runtime + commands

Bun + TypeScript workspaces (`packages/*`). No build step.

```
bun install
bun test            # unit + proc/tunnel-stub e2e always; docker/wrangler auto-gated
bunx tsc --noEmit   # typecheck
HESTIA_E2E_TUNNEL=1 bun test test/e2e/tunnel.test.ts   # real edge round-trip
bin/hestia up [--workers[=a,b]] [--allow-remote] [--force] [--no-varlock]
              [--wait[=secs]] [--no-daemon]
bin/hestia run --name web [--env K=V] [--no-port] [--varlock] [--signal int]
               [--wait[=secs]] [--no-daemon] -- <cmd...>
bin/hestia expose <svc...> [--tunnel <name>] [--zone <z>] [--keep-host-header]
                  [--overwrite-dns] [--force]
bin/hestia daemon status|start|stop|install [--print]|uninstall
bin/hestia doctor [--json]     # report-only; exit 1 only on error rows
bin/hestia stop <name> | down [--project <name>] | status | env | endpoint list
```

## The single interface (zero-config)

hestia writes **nothing** to the target repo. `hestia up` reads the repo's
existing compose file, generates a `.hestia/compose.override.yml` that:

- replaces pinned host ports with `127.0.0.1:0:<container>` so Docker assigns a
  free ephemeral port,
- rewrites any pinned `container_name` (would collide even under `-p`),
- sets `restart: "no"` so Docker never hands a restarted container a new port,
- labels every container `dev.hestia.*` for discovery.

It then reads assigned ports back from `docker compose ps --format json`,
surfaces them as `HESTIA_<SVC>_PORT` env keys + `endpoints[]`, and persists
state to `<worktree>/.hestia/stack.json` mirrored (full copies, incl. pidfiles)
to `~/.hestia/stacks/<project>/` — `hestia down --project <name>` tears down
from the mirror alone after the worktree is deleted. The caller wires whatever
URL it needs (`DATABASE_URL`, …) from the ports.

**Host processes** follow the same contract. `hestia run --name web -- <cmd>`
bind-probes an ephemeral port, injects it as `$PORT` + `HESTIA_<NAME>_PORT`
(and substitutes `{port}` tokens in the command; `{{port}}` escapes), spawns
the command detached with logs at `.hestia/logs/<name>.log`, and reports ready
only when the assigned port is owned by the spawned process tree.
`hestia up --workers` auto-discovers `wrangler.{jsonc,json,toml}` and runs one
supervised `wrangler dev` per config with `--port`/`--inspector-port` injected
and the dev registry redirected to `.hestia/wrangler-registry` (both
`WRANGLER_REGISTRY_PATH` and `MINIFLARE_REGISTRY_PATH` — the vite-plugin path
reads the latter), so service bindings never cross-wire between worktrees.
When the repo has `.env.schema` + a local varlock, worker spawns are wrapped in
`varlock run --no-redact-stdout --` (opt-out `--no-varlock`; opt-in on `run`
via `--varlock`) — hestia composes the repo's own resolver, it never parses
env files.

**Public ingress** rides the same machinery. `hestia expose <svc>` with no
tunnel adopted mints one **quick tunnel** per service (account-less,
`*.trycloudflare.com`, URL rotates per run). `hestia expose <svc> --tunnel tri`
**adopts the user's existing named tunnel** (sticky per worktree): hestia
becomes the tunnel's SINGLE connector, serving a merged ingress = the user's
static rules from `~/.cloudflared/config.yml` (read-only import) + one
`<tunnel>-<branch>-<svc>.<zone>` rule per exposure across ALL worktrees,
Host rewritten to the origin (vite/next reject foreign Hosts;
`--keep-host-header` opts out). Per-hostname `route dns` is skipped when the
hostname ledger (`~/.hestia/tunnel/<uuid>/hostnames.json`) already has it.
Public URLs surface as `endpoints[].publicUrl` + `HESTIA_<SVC>_URL`. The
connector is a global proc under `~/.hestia/tunnel/<uuid>/` — `up`/`run`/
`stop`/`down` regenerate the merged config and restart it whenever an exposed
port rotates (a ~2–5 s public blip for all exposed worktrees, by design).

**The daemon (hestiad)** auto-spawns on `up`/`run` — never managed by hand.
Starting a NEW stack takes one of `maxStacks` machine-wide slots (default 5;
`HESTIA_MAX_STACKS` env or `~/.hestia/config.json`, strict-parsed — invalid →
default + warning, never deny-all). At the cap: fail fast with `stack-limit`
listing the live stacks; `--wait[=secs]` joins a FIFO queue instead;
`--no-daemon` skips admission entirely. Occupancy is DERIVED (mirrors +
pidfile/docker-label liveness + persisted reservations under
`~/.hestia/daemon/reservations/`), so a daemon crash never corrupts
accounting; only in-memory queue order dies with it. A 15 s sweep frees slots
of dead stacks and **revives dead connectors of adopted tunnels** (base rules
must keep serving with zero live stacks). `hestia daemon install` writes a
launchd agent so hestiad — and the adopted tunnel — survive reboots.

## Non-obvious invariants

- **Compose project name is `slug(repo)-slug(branch)`**, capped and hash-suffixed
  only when truncation makes it ambiguous. Deterministic across re-`up` of the
  same `(worktree, branch)`. Repo name comes from the *common git dir*, so every
  worktree of one repo shares the same repo prefix. See `packages/core/src/naming.ts`.
- **`repo` derives from `git rev-parse --git-common-dir`**, not the worktree
  basename — worktrees under different directory names still resolve to the same
  repo. Detached HEAD falls back to short SHA as the branch.
- **The `!override` YAML tag is docker-compose-specific** — the `yaml` npm lib
  can't parse it. Tests strip it before parsing (`test/override.test.ts`).
- **`restart: "no"` is load-bearing**: without it, Docker can restart a
  container and hand it a *new* ephemeral port that the injected env wouldn't
  know about.
- **`.hestia/` is gitignored** at the repo root. The state file (`stack.json`)
  is mirrored to `~/.hestia/stacks/<project>/` so `hestia down` still works if
  the worktree directory has been removed.
- **Networks/volumes are auto-isolated by `-p <project>`** — the override
  intentionally only touches `services:`. Don't add network/volume renaming to
  the override.
- **CLI error contract**: `HestiaError(code, message)` codes are the stable
  interface. `--json` emits `{ error: { code, message } }`; humans get
  `error [code]: message` on stderr. Preserve the code when adding failures.
  The full code list lives on `HestiaError`'s doc comment in
  `packages/core/src/types.ts`.
- **Readiness is port *ownership*, not a listen-check**: `next dev` silently
  auto-increments when its port is taken (verified in next 16's
  `start-server.js`), so "something listens" would report the wrong port
  healthy. The oracle (`proc/ports.ts inspectPort`) checks who owns the
  assigned port: in our tree → ready; outside → definitive steal → kill +
  retry (×3); nobody at timeout → left running `unhealthy` for inspection.
- **Supervision is process-TREE based, not pgid based**: varlock's runner puts
  its child in a NEW process group (verified live), so pgid alone loses the
  wrangler/workerd subtree. Ownership walks `ps` ancestry from the spawned
  root; teardown signals every group found in the tree, with ready-time child
  identities snapshotted in the pidfile for orphan cleanup after the root dies.
- **Pid identity = pid + verbatim `ps -o lstart=` output**, captured post-spawn
  and compared string-equal on the same host. Guards every liveness check and
  kill against pid reuse. Don't parse it, don't reformat it.
- **`Bun.spawn` has no `detached`** — the supervisor uses `node:child_process`
  under Bun (compat verified by a unit test). Don't "simplify" it back.
- **All state mutations serialize on `<worktree>/.hestia/lock`** (`withLock`):
  parallel agents in one worktree are the product premise; unserialized
  read-modify-write of `stack.json` loses records. Stale locks (dead holder)
  are broken automatically.
- **Wrangler is always the worktree's own binary invoked directly** — never
  package dev scripts (modem's use `env -i` and pin inspector ports), never a
  global install. `--port` beats `config.dev.port` pins.
- **`IsolationEngine` reserved methods (`restartService`/`adopt`/`probe`/
  `discoverOrphans`) still throw `NotImplemented`** — declared so the
  daemon/TUI efforts slot in without changing callers.
- **One tunnel, ONE connector — replicas are the bug, not redundancy**: two
  connectors on one named tunnel are HA replicas that Cloudflare load-balances
  nondeterministically across worktrees (the original modem pain). Hestia owns
  the single connector; the takeover preflight refuses to become connector #2
  (`tunnel-busy`, `--force` to override) and hestia never kills processes it
  didn't spawn.
- **Hestia never creates or deletes tunnels, and mutates by UUID only** —
  it adopts an existing named tunnel (`tunnel list` → uuid, cred JSON from
  `~/.cloudflared/<uuid>.json`); `route dns` targets the uuid, never the name.
  Teammate tunnels on the shared account are untouchable by construction.
- **An ingress rule aimed at a port the stack no longer owns is a live
  cross-worktree leak** (the OS recycles it to another worktree). That's why
  `up`/`run`/`stop`/`down` all sync exposures + regenerate/restart the
  connector, and why `status` flags port drift `unhealthy`. "Re-run expose" is
  never the answer.
- **Lock order is worktree → global tunnel lock**, and Cloudflare CRUD
  (`tunnel list`, `route dns`) happens OUTSIDE both locks. The global lock
  (`~/.hestia/tunnel/<uuid>/.hestia/lock`) covers only config regen +
  connector restart. The tunnel dir doubles as a proc-machinery "worktree
  root" so the connector reuses startProc/pidfile/tree-shutdown unchanged.
- **Quick tunnels must pass an explicit empty `--config`**: cloudflared
  implicitly loads `~/.cloudflared/config.yml`, whose ingress rules override
  `--url` and 404 every request (found by the gated edge e2e; the stub can't
  catch it). Don't remove the `quick-tunnel.yml` write.
- **DNS records can't be deleted via the cloudflared CLI** (verified in
  source) — per-branch CNAMEs persist and serve CF 1033 after `down`. The
  hostname ledger keeps re-routing a no-op; `--overwrite-dns` is required to
  re-point a record hestia has no memory of; foreign records are NEVER
  captured silently. A one-time wildcard `*.<zone>` CNAME makes hestia's DNS
  writes unnecessary (printed in help).
- **Automated tests never create DNS records and never touch the shared
  account's tunnels.** The stub covers lifecycle; the real binary is used only
  offline (`ingress validate`/`ingress rule`) or account-less (quick mode).
- **hestiad's single-instance guard lives in `main.ts` under the daemon-dir
  lock**, not in the spawner — launchd `RunAtLoad` bypasses the CLI's ensure
  path entirely. The guard's loser exits 0, which pairs with the plist's
  **`KeepAlive={SuccessfulExit:false}`** (plain `true` would respawn exit-0
  forever and make `daemon stop` a lie). `daemon stop` boots the label out via
  launchctl when installed; SIGTERM otherwise. Don't "simplify" either half.
- **Slot occupancy is DERIVED, never owned**: recomputed from mirrors +
  liveness each time. Liveness = live non-tunnel pidfiles → provisional
  `starting` record with a live `starter` (pid+lstart) → label-based
  `docker ps` probe. Docker *errors* are sticky (keep last known, default
  LIVE) — a restarting Docker Desktop must never free slots. Quick-tunnel
  procs (`backend: "tunnel"`) never count.
- **The provisional `starting` record is the admission bridge**: written
  right after a grant, before the worktree lock section that starts services.
  It's why a multi-minute cold `compose up` can't lose its slot and why a
  CLI crash frees one (dead starter → sweep). Reservation files only bridge
  the seconds until that record exists.
- **`ensureDaemon` must not poll while holding the daemon-dir lock** —
  `main.ts` takes the same lock to start serving; the lock covers only
  check+spawn (deadlock otherwise, found during implementation).
- **`adopted.json` is enriched** (`{at, uuid, name, credFile}`) so the daemon
  can revive a connector with zero live stacks; legacy `{at}`-only markers
  reconstruct (uuid=dirname, credFile by convention, name from mirrors) and
  self-heal on the first reconcile. gui LaunchAgents inherit a bare PATH —
  `daemon install` bakes the user's full PATH into the plist or revival
  ENOENTs on cloudflared/docker after a reboot.
- **`HESTIA_HOME` overrides `~/.hestia`** (call-time, mirrors
  `HESTIA_CLOUDFLARED_HOME`) — the daemon e2e depends on it because cap math
  is machine-global. `HESTIA_LAUNCHD_DIR` likewise redirects the plist; tests
  never `launchctl bootstrap`.
- **The vendored `@hunk/session-broker*` packages are never forked** —
  `packages/VENDORED.md` pins the commit; behavioral assumptions are pinned by
  `daemon-vendor.test.ts` (idleTimeoutMs `0` = disabled — a "huge number"
  would overflow setTimeout and shut down instantly; custom `handleRequest`
  runs BEFORE broker routes; pruning is inert at 0 sessions).

## Testing

- Unit: `naming`, `generateOverride`, plus `packages/engine/test/proc.test.ts`
  (detached-spawn survival, ownership oracle, templating, env precedence,
  lstart liveness, lock contention), `wrangler.test.ts` (jsonc/toml discovery,
  remote detection, filters), `tunnel.test.ts` (hostname budget/collision,
  base-rule import, merged-config shape, ledger, mirror-derived rules),
  `daemon.test.ts` (occupancy/reservations/FIFO/cap parsing, plist content,
  adopted.json reconstruction), and `daemon-vendor.test.ts` (the vendored
  broker behavior pins) — no docker, no network.
- E2E gating: compose e2e needs docker (`dockerAvailable()` auto-skip); proc,
  stub-tunnel, and daemon e2e always run; wrangler e2e needs `bun install` in
  `test/fixtures/wrangler-repo`; the offline-ingress tier needs cloudflared on
  PATH; the edge tier needs `HESTIA_E2E_TUNNEL=1` + network. Only the daemon
  e2e isolates `HESTIA_HOME`; the other suites run against the real
  environment (user's call) and their teardowns `daemon stop` so no daemon
  carrying test env (stub PATH!) outlives a run. **Ship gates: the wrangler
  e2e must have run green locally before committing proc/wrangler changes,
  and `HESTIA_E2E_TUNNEL=1` must have run green locally before committing
  tunnel changes** — CI may skip both.

## What's NOT here yet (planned)

- Log streaming (`EngineHooks.onLog` reserved; for now `--json` returns each
  proc's `logPath` and agents tail the file) — the vendored session-broker's
  websocket sessions are the intended substrate
- `hestia logs` / `gc` commands (gc = the CF-API-token DNS cleanup for stale
  per-branch CNAMEs)
- Remote-managed tunnel config (would remove the connector-restart blip on
  ingress changes — reserved as an upgrade, needs an API token)
- TUI (spec at `hestia-tui.html`)
- Portless localhost URL router (`Endpoint.reservedName` is populated but
  dormant)
- Daemon queue persistence (FIFO order dies with a daemon restart; waiters
  retry — accepted)
