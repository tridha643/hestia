---
name: hestia
description: Per-worktree isolated dev stacks for parallel coding agents. Use when working in a git worktree that needs its own docker compose services, dev servers (next/vite/wrangler), or public URLs — hestia assigns ephemeral ports, isolates wrangler dev registries, and publishes services through cloudflare tunnels so parallel worktrees never collide.
---

# hestia

Every git worktree gets an isolated stack. You never pick ports, never write
config, never fight another agent over postgres, container names, wrangler
service bindings, or public hostnames. All commands accept `--json`.

**The golden rule: one stack per worktree, and it's YOURS. Never start dev
servers or `cloudflared tunnel run` by hand next to a hestia stack — hand the
command to `hestia run` instead so it gets a safe port and supervision.**

## Workflow

```bash
hestia up                          # compose services on ephemeral ports
hestia up --workers                # + one supervised `wrangler dev` per config
hestia run --name web -- pnpm dev  # supervise any dev server ($PORT injected)
hestia env                         # PORT, DIRECT_URL, LOCAL_URL, public URL
hestia endpoint list --json        # host/port plus direct/local/public surfaces
hestia route add web api --json    # stable local HTTPS, service names only
hestia route remove web --json     # removes CLI intent; TOML may keep it
hestia route list --json           # effective explicit + repository defaults
hestia router status --json        # non-interactive Portless state
hestia config path --json          # canonical machine-local config.toml
hestia logs -f web --json          # ndjson LogLine stream (docker or proc)
hestia tui                          # human Fleet cockpit for managed repo stacks
hestia expose web                  # public URL (quick tunnel, rotates per run)
hestia expose web --tunnel tri     # sticky named tunnel, stable hostname
hestia open web /auth/login        # local → public → direct preference
hestia open web --direct           # request one surface explicitly
hestia status --json               # current stack; null if none
hestia down                        # tear down THIS worktree's stack
hestia down --project <name>       # tear down after the worktree was deleted
hestia doctor --json               # report-only audit; exit 1 on error rows
```

- `up`/`run` inject ports: `$PORT` in the child env, `{port}` tokens in the
  command line (`{{port}}` escapes a literal), `HESTIA_<NAME>_PORT` in `env`.
- Wire your own URLs from ports: `DATABASE_URL=postgres://…:$HESTIA_DB_PORT/…`.
- Routed services retain `Endpoint.url` / `HESTIA_<SVC>_DIRECT_URL`, add
  `Endpoint.localUrl` / `HESTIA_<SVC>_LOCAL_URL`, and preserve
  `Endpoint.publicUrl` / `HESTIA_<SVC>_URL` for Cloudflare ingress.
- Repository route defaults live only in `~/.hestia/config.toml`; discover and
  validate it with `hestia config path|show|validate --json`.
- The trusted Portless LaunchDaemon writes only below its root-owned
  `/Library/Application Support/Hestia/router/` runtime. Hestiad publishes
  agent route intent separately in `~/.hestia/router/portless/aliases.json`,
  which Portless validates and reads without writing through the user path.
- Logs: `hestia logs [service...] [-f] [--tail N] [--project P]`; the default
  is all services and 50 backfill lines. `--json` is ndjson: one `LogLine`
  (`project`, `service`, `source`, `text`, optional `meta`) per output line.
- Fleet: `hestia tui` requires an interactive terminal and shows only stacks
  Hestia currently manages for this Git repository. The only mutation is a
  confirmed `down`; named volumes are always retained. Agents should continue
  using the JSON CLI while humans use Fleet for live observation. Humans can
  click stack/service rows and wheel-scroll logs; reconnect backfill is
  deduplicated before display.
- Public URLs are guarded only by obscurity — fine for webhooks/dev demos.
- **Before deleting a worktree, run `hestia down`.** Forgot? `hestia status
  --json` in any worktree won't show it, but `hestia down --project <name>`
  (project = `<repo>-<branch>` slug) cleans up from the mirror.

## The stack cap (daemon)

Starting a **new** stack takes one of 5 machine-wide slots (config:
`HESTIA_MAX_STACKS`, then `~/.hestia/config.toml` `max_stacks`, then legacy
`~/.hestia/config.json` `{"maxStacks": n}`). The
hestiad daemon auto-starts on `up`/`run` — you never manage it, but you can:
`hestia daemon status|start|stop|install|uninstall`.

- At the cap, `up`/`run` fail fast with `stack-limit` listing the live stacks.
  Prefer finishing + `hestia down`-ing one; or queue with `--wait[=secs]`
  (FIFO; the command blocks until a slot frees or the wait times out).
- Re-`up`/`run` on an already-running stack never takes a second slot.
- `--no-daemon` skips the cap (escape hatch; supervision paused — avoid).

## Error codes (`--json` → `{error: {code, message}}`)

| code | meaning | what to do |
|---|---|---|
| `stack-limit` | machine stack cap reached | `hestia down` a stack you own, or retry with `--wait=120` |
| `config-missing` | no compose file for plain `up` | use `hestia run`/`up --workers`, or add a compose file |
| `proc-ready-timeout` | proc never listened on its port | read `logPath`; if it's not a server, use `--no-port` |
| `proc-exited` | proc died before ready | read `logPath` |
| `name-conflict` | name taken by another backend | pick another `--name` |
| `worktree-busy` | foreign wrangler/dev proc holds the registry | stop it, or `--force` |
| `service-not-found` | expose/open target not running | `hestia up`/`run` it first; for `open`, `expose` it first |
| `no-stack` | no cwd stack or `--project` mirror exists | start the stack or check the project name |
| `tunnel-busy` | another connector on the named tunnel | stop your manual `cloudflared tunnel run`; `--force` accepts replica risk |
| `hostname-conflict` | another worktree owns that public hostname | different service name or branch |
| `dns-record-conflict` | hostname's DNS points somewhere foreign | `--overwrite-dns` ONLY if you know it's stale |
| `lock-timeout` | another hestia command holds the worktree lock | retry shortly |
| `daemon-start-failed` / `daemon-unreachable` | hestiad broken | `hestia daemon status`, read `~/.hestia/daemon/daemon.log`; last resort `--no-daemon` |
| `router-setup-required` | trusted router absent | `hestia router install --interactive` in a terminal |
| `router-privilege-required` | non-interactive setup lacks sudo | run the structured remediation command in a terminal |
| `router-port-busy` | foreign process owns `:443` | inspect and stop it yourself; Hestia never kills it |
| `route-origin-unavailable` | no verified direct origin | start the service through Hestia, then add the route |

## Invariants you must respect

1. Never run `cloudflared tunnel run <name>` yourself while hestia has adopted
   that tunnel — two connectors = requests randomly cross worktrees.
2. Never hardcode ports; always consume `hestia env` / `endpoint list`.
3. `.hestia/` is state, not code — it must stay gitignored; never commit it.
4. Exposed port drift is repaired automatically by any hestia command; if
   `doctor` reports it as an error, run any `hestia` command — never "fix" it
   by re-running `expose`.
