# Hestia v1 release verification

The release workflow builds once, tests the exact tarball, publishes that artifact to `next`, smoke-tests it, and promotes the same npm version to `latest` without rebuilding.

Required evidence for a signed v1 report:

- Typecheck and full unit/E2E suite output, with every skip explained.
- Real Wrangler isolation, Docker isolation, modem Fleet/TUI, Cloudflare edge recycled-origin rejection, and privileged Portless/reboot results.
- `npm pack --dry-run` manifest and SHA-256 checksum of the tested tarball.
- Hardened Portless source version and patch checksum from the packaged asset manifest.
- Empty-cache global install, `bunx`, upgrade, rollback, and uninstall acceptance.

Rollback:

```bash
bun add --global @tridha643/hestia@<previous-version>
```

Older binaries treat newer state as inspection/down-only. Uninstall with `hestia daemon uninstall`, `hestia router uninstall`, then `bun remove --global @tridha643/hestia`.

