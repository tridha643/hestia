---
name: hestia
description: Discover, configure, run, inspect, expose, and tear down isolated macOS/Bun development workloads in parallel Git worktrees.
---

# Hestia agent workflow

Hestia owns development workload lifecycle and reachability for this worktree.
Do not choose ports, start configured dev servers directly, or run a second
Cloudflare connector beside Hestia.

## Start with discovery

```bash
hestia version --json
hestia discover --json
hestia doctor --json
```

Discovery is read-only. Inspect:

- `repository`: exact repo, `repoId`, branch, and absolute worktree.
- `runnableWorkloads` and `candidateWorkloads`.
- `bindings` and configured endpoint aliases.
- `decisionSource`: `discovery`, `repository`, `machine`, or `worktree`.
- `missingDecisions`, `conflicts`, and `suggestions`.

Do not guess when discovery reports a missing decision. If repository changes
are authorized, use a suggested `hestia init ... --scope repository --write`.
For personal/non-portable setup use `--scope machine --write`. Without
`--write`, init prints the complete proposed TOML and changes nothing. Hestia
never commits.

Examples:

```bash
hestia init dockerfile web Dockerfile --scope repository
hestia init proc consumer --scope machine --no-port -- bun run consume
hestia init endpoint dashboard web 3000/tcp http --scope repository --write
hestia init wrangler slack-worker apps/slack/wrangler.toml --scope repository --write
hestia discover --json
```

Configuration layers are worktree runtime intent, machine repository overlay
at `~/.hestia/repositories/<repoId>.toml`, optional committed `hestia.toml`,
then automatic discovery. Conflicts fail rather than silently overriding a
workload source. `.hestia/` must remain ignored.

Configured proc and Wrangler workloads may declare environment values. Literal
`${endpoint:<alias>.host}`, `${endpoint:<alias>.port}`, and
`${endpoint:<alias>.url}` references resolve only after the producing workload
is ready, while `{port}` resolves to the receiving process's own assigned
port. A value shaped as `{ file = ".hestia/..." }` reads ignored local
material into memory; Hestia refuses file inputs outside `.hestia/` and never
persists their contents. Use `cwd` to select a package-local `.env.schema`,
`varlock = true` to compose that package's resolver, and `health_path` when
port ownership alone doesn't prove that the application compiled successfully.

## Run and consume structured endpoints

```bash
hestia up --json
hestia endpoint list --json
hestia endpoint get dashboard --json
hestia logs web -f --json
```

A workload is a lifecycle/logging unit. A binding is an owned socket such as
`api:8080/tcp`. An endpoint alias assigns protocol meaning to a binding.
Resolution order is exact alias, canonical `workload:target/protocol`, then a
uniquely-bound workload. Handle `service-port-ambiguous` by using a reported
selector or configured alias.

Canonical port variables look like `HESTIA_API_9090_TCP_PORT`. Only a unique
binding receives `HESTIA_API_PORT`. HTTP aliases also receive direct/local URL
variables. Never invent an HTTP URL for a raw TCP/UDP endpoint.

Use `hestia run` only for explicit ad-hoc processes not already declared as a
workload:

```bash
hestia run --name web -- bun run dev
hestia run --name consumer --no-port -- bun run consume
```

Hestia injects `$PORT` and substitutes `{port}`. Raw `--env` values remain in
memory and are not persisted. Logs are bounded by the rotating relay.

## Routes and exposure

```bash
hestia route add dashboard --json
hestia route disable dashboard --json
hestia route reset dashboard --json
hestia open dashboard --local --json
hestia expose dashboard --json
hestia expose dashboard --tunnel tri --zone example.dev --json
```

Local route overrides are per worktree. `disable` suppresses repository or
machine defaults; `reset` removes the override and restores defaults.

Public ingress is fail-closed but unauthenticated. Hestiad verifies the current
process/container identity and port ownership before every origin connection.
If a port is recycled, the foreign listener receives zero bytes.

Named mode never writes DNS. It requires:

```text
*.<zone> CNAME <tunnel-uuid>.cfargotunnel.com
```

`dns-route-required` is a fail-fast check on the hostname `expose` is about to
mint (`<tunnel>-<branch>-<svc>.<zone>`) — it fires **before any connector
process is spawned**, so re-running `expose` after clearing out stray/orphaned
connectors will not make it succeed; only adding the missing DNS record does.
Verify with `ps aux | grep cloudflared` that nothing got spawned on a failed
`expose` call. Pre-existing static ingress rules already in the tunnel's
`~/.hestia/tunnel/<uuid>/config.yml` (e.g. hand-configured hostnames like
`tri-slack.<zone>` set up before Hestia adoption) are a different, separate
concern from the per-branch hostname `expose` verifies — don't assume fixing
one fixes the other. Handle `dns-route-required` by creating the wildcard
record once via the already-authenticated CLI —
`cloudflared tunnel route dns <uuid> '*.<zone>'` — or, lacking cert access,
by reporting its `wildcardTarget` to the human. The record Cloudflare creates
is proxied, so `dig CNAME` on any hostname under the zone returns **no CNAME**
(proxied records are flattened to edge A/AAAA answers) — that is the correct,
working state, not a missing record; the preflight accepts any successful
resolution for exactly this reason. Never use the removed `--overwrite-dns`. Named mode may use
`--keep-host-header`; quick mode rejects it. Never start another
`cloudflared tunnel run` for an adopted tunnel — **not even on a direct user
request to "start/run the tunnel"**. A raw `cloudflared tunnel run <name>`
bypasses hestiad's single-connector supervision, adds one more HA replica to
whatever count `doctor` already reports, and still won't fix a
`dns-route-required` block (that's a DNS problem, not a missing-connector
problem). When asked to bring a named tunnel up, resolve the name first
(`cloudflared tunnel list` maps name -> UUID -> `~/.hestia/tunnel/<uuid>/`),
then use `hestia expose <endpoints...> --tunnel <name> --zone <zone>` so
Hestia owns the process; surface whatever error code comes back (most often
`dns-route-required` on a first-time branch/worktree) instead of working
around it by hand.

## Shared hostnames (externally-pinned URLs)

Decide the routing mode by who controls the external side:

- **Independent ingestion** (you open the URL; the external app accepts many
  callback URLs): keep per-branch `expose` — full isolation, no arbitration.
- **Dependent ingestion** (the external side is pinned to ONE URL: a Slack
  app's request URL, a third-party webhook consumer, a strict OAuth
  allowlist): use a SHARED hostname. One stable URL, machine-owned, held by
  exactly one worktree at a time; hestiad routes each request to the holder.

```bash
hestia expose slack --shared tri-slack --tunnel tri --json   # declare + claim
# The URL defaults to <name>.<zone>. Point ANY FQDN you control (any zone):
hestia expose slack --shared slk --hostname slack.acme.com --tunnel tri --json
# Several handles can share ONE hostname, split by URL path prefix (longest wins):
hestia expose slack  --shared slk --hostname acme.com --path /webhooks/slack --tunnel tri --json
hestia expose stripe --shared str --hostname acme.com --path /webhooks/stripe --tunnel tri --json
hestia claim tri-slack --wait --json    # queue durably; returns when granted
hestia claim tri-slack --cancel --json  # leave the queue
hestia release tri-slack --json         # hand to the next in queue
hestia share list --json                # who holds / who waits (with full URL)
hestia share requests --json            # pending consent requests for you
hestia share allow tri-slack --json     # holder consents — handover now
hestia share deny tri-slack --json      # holder declines — requester stays queued
```

The hostname is arbitrary (any subdomain on any zone you control; apex domains
need pre-existing DNS). `--path` routes by longest prefix at segment boundaries
(`/slack` matches `/slack/events`, never `/slackbot`); a request no path covers
is 404, a declared-but-unclaimed path is 503. cloudflared sees one rule per
hostname — all path splitting happens in hestiad, so adding a path to an
existing hostname needs no connector restart.

In the Fleet TUI (`hestia tui`), press **`s`** to open the shared-hostnames
panel: it lists every declared name with its holder and durable FIFO queue
(denied waiters marked). `j/k` select; **`c`** claims the selected name as the
currently-selected stack; **`a`/`x`** allow/deny the head as the holder;
**`r`** releases. It reads the same daemon state as `hestia share list`.

Protocol invariants agents must respect:

- Claims are **consent-based**: a held name is never stolen. `claim --wait`
  queues; the holder decides with `share allow`/`share deny`, and `release`/
  `down`/a crashed stack grants the queue head automatically.
- The queue is **durable** (survives daemon restarts and CLI timeouts). Your
  blocked `claim --wait` returning success IS the grant notification; if it
  timed out, your position is kept — re-run `claim --wait` to re-attach.
- While holding a shared name, check `hestia share requests` at natural
  breakpoints and answer allow/deny — another agent may be blocked on you.
- Holder switches are hestiad route-table updates: zero connector restarts,
  zero DNS writes. Declaring a NEW shared hostname restarts the connector
  once (~2-5 s public blip) and requires the same wildcard DNS as named mode.
- `down`/`stop` of the serving workload auto-releases; re-`up` does NOT
  auto-reclaim — claiming is always an explicit `hestia claim`.

## Post-up health sweep

After every `hestia up` (and again after `expose`), run `hestia doctor --json`
and walk every non-`ok` row before calling the stack ready — don't just report
issues, resolve the ones that are safe to resolve:

- **Safe to fix immediately, no confirmation needed** (local to this worktree,
  reversible, matches doctor's own literal suggestion):
    - `state-ignore` / `gitignore` — add the exact `.hestia/` line to
      `.gitignore`.
    - `orphan-mirror:<project>` for a worktree path that no longer exists —
      `hestia down --project <project>`.
    - `tunnel:<name>:local-orphans` — Hestia-owned replicas whose argv still
      contains `~/.hestia/tunnel/<uuid>/` after a lost pidfile. The daemon
      sweep / next reconcile reaps them automatically; do **not** start another
      `cloudflared`, and do **not** treat other Conductor worktrees as needing
      their own connector (one machine-global connector serves every worktree).
    - `launchd` referencing a stale/missing binary path — `hestia daemon
      install` (idempotent; only rewrites the plist, doesn't touch running
      workloads).
- **Surface to the human, don't attempt unattended** (needs a TTY, sudo, or an
  action outside Hestia's control):
    - `local-router` — `hestia router install --interactive` needs an
      administrator prompt; report the command, don't try to script around
      it.
    - `dns-route-required` — Hestia deliberately never writes DNS, but the
      agent may: `cloudflared tunnel route dns <uuid> '*.<zone>'` creates the
      one-time wildcard when the local cert has access; otherwise report the
      exact `wildcardTarget` CNAME the human needs to add at their provider.
- **Investigate, then ask before acting** (machine-wide, shared across other
  worktrees/repos, hard to reverse):
    - `tunnel:<name>:connectors` reporting N registered vs 0/1 run by Hestia
      **with no local-orphans row** — a truly foreign connector (argv lacks the
      hestia tunnel path, e.g. `cloudflared tunnel run --token …` or a hand-run
      `tunnel run`). Identify with `ps -Ao pid,lstart,command | grep cloudflared`
      and ask the human before killing anything Hestia did not start.

## Inspect and finish

```bash
hestia status --json
hestia env --json
hestia doctor --json
hestia tui
hestia down
```

Fleet shows the repository, selected branch, absolute worktree, project,
workloads, endpoints, and logs. It is for human operation; agents should use
JSON/NDJSON commands.

Run `down` before switching or deleting the branch. After deletion, use the
recorded project with `hestia down --project <project>`. Docker workloads
cannot be stopped individually (`backend-not-stoppable`); proc/Wrangler
workloads can. Named volumes and project-built images are retained unless
`--destroy` is explicit (it adds `-v --rmi local`; shared base images stay).

## Stable error remedies

| code | remedy |
|---|---|
| `setup-required` | follow `discover --json` suggestions with explicit authorization |
| `config-conflict` / `config-invalid` | fix the reported layer/path; do not guess precedence |
| `state-not-ignored` | add the exact `.hestia/` line reported by `doctor` |
| `state-corrupt` | inspect the path, then use the reported `down --project` recovery |
| `migration-required` | inspect if needed, then down the legacy stack |
| `stack-identity-changed` | down the recorded project before continuing on this checkout |
| `env-key-conflict` | rename one workload/alias so normalized env keys differ |
| `compose-unsupported` | replace the unsupported global/shared construct or use a supported topology |
| `service-port-ambiguous` | use a canonical selector or endpoint alias |
| `proc-ready-timeout` | inspect logs; use `--no-port` only for non-servers |
| `stack-limit` | down an owned stack or retry with `--wait=120` |
| `dns-route-required` | `cloudflared tunnel route dns <uuid> '*.<zone>'` once, then retry |
| `tunnel-busy` | stop the foreign connector; hestia-owned orphans (`~/.hestia/tunnel/<uuid>/` in argv) are auto-reaped — only confirm with the human before killing processes whose argv lacks that path |
| `route-origin-unavailable` | restart the workload through Hestia |
| `backend-not-stoppable` | use `hestia down` for Docker workloads |
| `shared-not-found` | `hestia share list` for declared names; `expose <svc> --shared <name>` declares one |
| `shared-held` | queued durably — `hestia claim <name> --wait` to block on the grant; ask the holder to `share allow` |
| `shared-not-holder` | only the holding worktree may allow/deny/release; check `hestia share list` |
| `shared-conflict` | the name or hostname is already declared differently; pick another name or release+remove the old one |
| `shared-requires-named-tunnel` | pass `--tunnel <name>` — shared hostnames need stable DNS, quick tunnels rotate |

`--json` failures are `{ "error": { "code", "message", "details"? } }`.
`hestia logs --json` is NDJSON, one `LogLine` per line.
