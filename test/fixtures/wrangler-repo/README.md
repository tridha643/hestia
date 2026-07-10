# wrangler e2e fixture

Two tiny workers; `fixture-worker-a` service-binds to `fixture-worker-b`.
The e2e (`test/e2e/wrangler.test.ts`) asserts that in two parallel worktrees
each worker-a reaches **its own worktree's** worker-b through the per-worktree
private dev registry, and that the global registry is untouched.

The test skips unless wrangler is installed here:

```
cd test/fixtures/wrangler-repo && bun install
```
