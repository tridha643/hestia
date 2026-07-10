# Vendored packages

`session-broker-core/`, `session-broker/`, and `session-broker-bun/` are vendored
verbatim from [modem-dev/hunk](https://github.com/modem-dev/hunk) (MIT).

- Source commit: `059dd13c8bd27fe503ef59652077edf0041034c8` (main, 2026-07-10)
- Upstream paths: `packages/session-broker-core`, `packages/session-broker`,
  `packages/session-broker-bun`

Why vendored: the packages are `"private": true` upstream (not on npm) but are
exactly the daemon substrate hestia wants — the TUI phase inherits the same
broker the hunk TUI uses. If upstream publishes them, delete these directories
and switch `@hestia/engine`'s dependencies to the npm versions.

Rules:

- **Never fork their internals.** hestia composes them exactly as an external
  consumer would (`hestiad` uses `SessionBrokerDaemon` + the bun adapter's
  `handleRequest` hook only), so a re-sync is always `cp -R` from a fresh
  checkout + updating the commit hash above.
- Their own test files ship with them and run in hestia's suite — an
  incompatible re-sync fails loudly.
- One manifest deviation: `session-broker-bun/package.json` adds
  `@hunk/session-broker-core` to `dependencies` — its source imports it
  directly but upstream never declares it (hoisting masks the gap there;
  hestia's stricter workspace resolution doesn't). Re-apply on re-sync.
- Behavioral assumptions hestiad depends on are additionally pinned by
  `packages/engine/test/daemon-vendor.test.ts` (idle-shutdown disable
  semantics, `handleRequest` routing order, stale-session pruning inert at
  zero sessions).
