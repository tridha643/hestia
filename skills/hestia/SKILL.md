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
    - `tunnel:<uuid>:connectors` reporting N registered vs 0 run by Hestia —
      this means foreign `cloudflared` processes (possibly from other active
      Conductor workspaces, or leaked from a different repo's own test suite,
      e.g. hestia's own e2e fixtures under `.../test/fixtures/tunnel-stub/`)
      are registered against the same tunnel. Identify them with `ps aux |
      grep cloudflared` and `cloudflared tunnel list`, but do **not** kill any
      of them without the user's explicit go-ahead — one of those processes
      may belong to another live workspace. Report the count, PIDs, and ages
      found, and let the human decide what to stop.

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
workloads can. Named volumes are retained unless `--destroy` is explicit.

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
| `tunnel-busy` | stop the foreign connector; do not kill processes Hestia did not start — identify via `ps aux \| grep cloudflared` + `cloudflared tunnel list`, then confirm with the human before killing anything (see "Post-up health sweep") |
| `route-origin-unavailable` | restart the workload through Hestia |
| `backend-not-stoppable` | use `hestia down` for Docker workloads |

`--json` failures are `{ "error": { "code", "message", "details"? } }`.
`hestia logs --json` is NDJSON, one `LogLine` per line.
