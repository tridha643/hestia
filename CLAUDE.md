# hestia

Per-worktree isolated dev stacks for parallel coding agents. `hestia up` in a
git worktree brings up that worktree's docker compose services on **ephemeral
host ports**; `hestia run` and `hestia up --workers` supervise **host
processes** (next/vite/wrangler dev) the same way — so parallel agents never
fight over ports, DBs, container names, or wrangler service bindings.

This branch (`scope-hestia-terminal-tool`) holds the **docker-compose MVP**
plus the **phase-2 proc + wrangler backend**. A concurrency daemon, logs, TUI,
and the portless URL router are later efforts layered on the same
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
- `packages/cli` — the `hestia` CLI
  (`up`/`run`/`stop`/`down`/`status`/`env`/`endpoint`), `--json` on every
  command, no daemon.
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
- `hestia-scope.html` / `hestia-tui.html` — scoping doc + TUI design spec.
  Reference-only; not shipped.

## Runtime + commands

Bun + TypeScript workspaces (`packages/*`). No build step.

```
bun install
bun test            # unit + proc e2e always; docker/wrangler e2e auto-gated
bunx tsc --noEmit   # typecheck
bin/hestia up [--workers[=a,b]] [--allow-remote] [--force] [--no-varlock]
bin/hestia run --name web [--env K=V] [--no-port] [--varlock] [--signal int] -- <cmd...>
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

## Testing

- Unit: `naming`, `generateOverride`, plus `packages/engine/test/proc.test.ts`
  (detached-spawn survival, ownership oracle, templating, env precedence,
  lstart liveness, lock contention) and `wrangler.test.ts` (jsonc/toml
  discovery, remote detection, filters) — no docker, no network.
- E2E gating: compose e2e needs docker (`dockerAvailable()` auto-skip); proc
  e2e always runs; wrangler e2e needs `bun install` in
  `test/fixtures/wrangler-repo` (skips otherwise). **Ship gate: the wrangler
  e2e must have run green locally before committing changes to proc/wrangler
  code** — CI may skip it.

## What's NOT here yet (planned)

- Tunnel backend (interface reserved via `ServiceBackend`)
- Concurrency daemon (cap of 5 stacks per plan) + queue
- Log streaming (`EngineHooks.onLog` reserved; for now `--json` returns each
  proc's `logPath` and agents tail the file)
- `hestia logs` / `doctor` / `gc` commands
- TUI (spec at `hestia-tui.html`)
- Portless URL router (`Endpoint.reservedName` is populated but dormant)
