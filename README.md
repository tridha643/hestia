# Hestia

Hestia runs isolated development workloads for humans and coding agents in
parallel Git worktrees. It assigns collision-safe project identities,
ephemeral loopback ports, private Wrangler registries, recoverable state, and
ownership-verified local/public routing.

V1 supports macOS and requires Bun 1.3 or newer.

```bash
bun add --global @tridha643/hestia
hestia version --json
```

`bunx @tridha643/hestia` is supported for one-off use.

## Ideal workflow

```bash
hestia discover --json
hestia doctor --json
hestia init --print
# Run a suggested init command only when configuration is needed:
hestia init endpoint dashboard web 3000/tcp http --scope repository --write
hestia up --json
hestia endpoint get dashboard --json
hestia logs web -f --json
hestia tui
hestia down
```

Discovery is read-only. It reports the repository, branch, absolute worktree,
runnable workloads, candidates, bindings, configured endpoints, unresolved
decisions, conflicts, the source of each decision, and exact setup commands.
Package scripts and Dockerfile `EXPOSE` declarations are suggestions; Hestia
never executes them implicitly.

Initialization is proposal-first. Without `--write`, the complete TOML is
printed. A write requires an explicit scope, is locked, validated, atomic, and
never committed automatically.

## Configuration layers

Hestia resolves four layers, with conflicts reported explicitly:

1. Per-worktree runtime intent in `<worktree>/.hestia/`.
2. Machine-local repository overlay at
   `~/.hestia/repositories/<repoId>.toml`.
3. Optional committed repository contract at `<repo>/hestia.toml`.
4. Automatic discovery.

`hestia.toml` is optional. Use repository scope when the definition should be
shared and reviewed. Use machine scope for personal aliases or non-portable
commands without dirtying Git. Hestia refuses startup unless `.hestia/` is
ignored; `doctor` prints the exact `.gitignore` remedy.

```toml
version = 1

[workloads.web]
source = "compose"
compose_service = "web"

[workloads.web.endpoints.dashboard]
binding = "3000/tcp"
kind = "http"
local = true

[workloads.consumer]
source = "proc"
command = ["bun", "run", "consume"]
port = "none"
```

Supported workload sources are `compose`, `dockerfile`, `proc`, and
`wrangler`. Complex Dockerfile networking, volumes, or dependencies require a
real Compose definition.

## Workloads, bindings, and endpoints

A workload is one lifecycle/logging unit. A binding is one owned socket, such
as `api:8080/tcp` or `dns:53/udp`. An endpoint gives a binding an alias and
protocol meaning:

```text
dashboard -> web:3000/tcp -> HTTP
metrics   -> api:9090/tcp -> HTTP
db        -> postgres:5432/tcp -> TCP
```

Endpoint input resolves as exact alias, exact canonical selector, then unique
workload. A multi-port workload without a selector fails with
`service-port-ambiguous`.

Every binding receives a canonical variable such as
`HESTIA_API_9090_TCP_PORT`. A uniquely-bound workload also receives
`HESTIA_API_PORT`. Aliases receive `HESTIA_DASHBOARD_PORT` and, for HTTP,
`HESTIA_DASHBOARD_DIRECT_URL`. Normalized env-name collisions fail before
startup.

Auxiliary processes—connectors, quick tunnels, log relays, and daemon
helpers—are kept outside the user workload namespace.

## Isolation and recovery

Project names use `<repo20>-<branch30>-<hash10>`. The hash covers the exact
repository identity, branch, and canonical worktree path, preventing clone,
slug, and truncation collisions.

Compose is resolved through `docker compose config --format json`. Hestia
supports ordinary TCP/UDP mappings, profiles, dependencies, and
project-scoped resources. It rejects port ranges, host network/PID/IPC modes,
external networks/volumes, and explicit machine-global resource names before
creation. Selected services expand through transitive dependencies.

State and pidfiles are schema-versioned, validated, private, and atomically
published to both the worktree and `~/.hestia/stacks/<project>/`. Legacy
stacks remain inspectable and removable but cannot be restarted. Run `down`
before switching/deleting a branch. `down --project` retains label-only Docker
cleanup even when the mirror is corrupt or the worktree is gone.

Host processes run beneath a detached relay. Raw environment values are never
persisted; only a SHA-256 intent fingerprint is stored. Logs rotate at 25 MiB
with three archives, bounding each log family near 100 MiB.

## Local and public routing

Hestiad owns an HTTP/WebSocket gateway on a stable Unix socket below a
mode-0700 per-user runtime directory. Before every origin connection it
verifies the recorded process/container identity and current port ownership.
If an origin dies and another process recycles its port, the gateway returns
503 without sending that process any bytes.

Quick tunnels and Hestia-managed named rules target only this socket. Named
mode performs no DNS writes. Configure one wildcard CNAME before exposing:

```text
*.<zone> CNAME <tunnel-uuid>.cfargotunnel.com
```

An unresolved hostname returns `dns-route-required` with the exact wildcard
target. Named mode supports `--keep-host-header`; quick mode rejects it because
safe internal routing requires Hestia's authority. Imported static Cloudflare
rules remain read-only and outside Hestia's ownership guarantee. Public routes
are fail-closed but unauthenticated—use them only for development traffic.

## Fleet and operations

`hestia tui` always displays the invoking repository. The selected stack block
shows repository, branch, absolute worktree, and project in wide and narrow
layouts; selection updates immediately, and down confirmation repeats the
exact checkout identity. Workload selection drives logs and endpoint
selection drives copy/open.

Useful commands:

```bash
hestia status --json
hestia env --json
hestia endpoint list --json
hestia endpoint get dashboard --json
hestia route add|disable|reset dashboard --json
hestia open dashboard --local
hestia stop consumer
hestia down --project <project>
hestia daemon status
hestia router status
```

Individual Docker workloads are not stoppable; use `hestia down`. Named
volumes and project-built images are retained unless `--destroy` is explicit
(`--destroy` removes named volumes and `--rmi local` project images; shared
base images are left in place). `doctor` is strictly report-only.

## Development and release

```bash
bun install
bunx tsc --noEmit
bun test
bun run build
npm pack --dry-run
```

The public package contains bundled CLI, daemon, relay, TUI code, the agent
skill, and a checksummed hardened Portless payload. Internal Hestia and Hunk
workspaces are implementation details. Releases install and test the exact
tarball in an isolated Bun home, publish prereleases to `next`, then promote
that same artifact to `latest` with provenance and protected credentials.

Rollback:

```bash
bun add --global @tridha643/hestia@<previous-version>
```
