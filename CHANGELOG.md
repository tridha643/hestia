# Changelog

## Unreleased

## 1.2.0

- Reap untracked hestia-owned tunnel connector process groups on reconcile and
  daemon sweep (lost-pidfile revival storms no longer accumulate HA replicas).
- Doctor reports `tunnel:<name>:local-orphans` with PIDs and clarifies foreign
  vs hestia-owned connector mismatches.
- Fleet TUI overhaul (hunk-patterned): stripe-and-wash row selection instead
  of the solid highlight, keycap status bar with a live capacity summary,
  transient toasts that expire, compact two-line context strip, stack uptime
  and slot counts, `pub` endpoint badges, stack warning markers, a `starting`
  spinner, memoized wrapped log rows with clamped scrolling, and new keys —
  `, .` stacks, `f` follow toggle, `g`/`G` top/bottom, `Y` env-block yank,
  Esc clears the filter before leaving it.
- Fleet TUI readability: focus-accented panes, health glyphs, workload column
  headers with ports, wrapped log lines, carriage-return progress cleanup, and
  a clearer doctor report layout.

## 1.0.0

- Added read-only workload discovery and proposal-first repository or machine-local initialization.
- Added versioned, collision-safe stack identity and legacy inspection/down-only handling.
- Added strict resolved-Compose validation, explicit TCP/UDP bindings, endpoint aliases, and transactional partial-start recovery.
- Added fail-closed local, quick, and named ingress through hestiad's guarded Unix-socket gateway.
- Added bounded rotating process supervision without persisted environment secrets.
- Added repository/worktree-aware Fleet workload and endpoint views.
- Added deterministic macOS/Bun npm packaging for `@tridha643/hestia`.

