# @koi/workspace-conformance — Shared Contract Test Suite

A `bun:test` conformance harness that any `WorkspaceBackend` implementation
can run against itself. Both `@koi/workspace` (git worktrees) and
`@koi/workspace-nexus` import this package and feed in their factory; the
harness asserts that they behave identically at the L0 contract boundary.

---

## Why It Exists

`WorkspaceBackend` is an L0 contract with multiple production implementations
(git worktrees today, containers/Nexus tomorrow). Without a shared suite,
contract drift between backends slips in as silent divergence — `dispose`
that throws on one backend and returns a typed Result on the other, or
`isHealthy` that returns true on a freshly-created workspace for one backend
but false for another. The conformance package extracts that contract into
one place so divergence fails CI as a real bug.

This package is **test-only**. It exports nothing at runtime that production
code should depend on; it lives in `dependencies` purely so adapter packages
can `import { describeWorkspaceConformance }` from their own `*.test.ts` files.

---

## Public API

```typescript
import { describeWorkspaceConformance } from "@koi/workspace-conformance";
import { createGitWorktreeBackend } from "@koi/workspace";

describeWorkspaceConformance("createGitWorktreeBackend", async () => {
  const repoPath = await makeTempRepo();
  const worktreeBasePath = await mkdtemp(...);
  const backend = createGitWorktreeBackend({ repoPath, worktreeBasePath });
  return {
    backend,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
      await rm(worktreeBasePath, { recursive: true, force: true });
    },
  };
});
```

The factory MUST return a brand-new backend on each call so tests don't share
state. `cleanup` (if returned) is invoked after each test to free filesystem
artifacts (temp git repos, container roots, etc.).

---

## What the Suite Covers

| # | Test | Contract guarantee |
|---|------|--------------------|
| 1 | shape | `name` non-empty string, `isSandboxed` boolean |
| 2 | create | returns workspace with id/path/createdAt/metadata |
| 3 | isHealthy on fresh workspace | true |
| 4 | second dispose | typed Result (idempotent or NOT_FOUND — both valid; never throws) |
| 5 | exists (capability-gated) | flips to false after dispose |
| 6 | findByAgentId (capability-gated) | lists own survivors |
| 7 | attestation triple (capability-gated) | attest → verify → invalidate consistency |

Optional methods (`findByAgentId`, `attestSetupComplete`, `exists`, ...) are
skipped when the backend exposes `undefined` for them — the suite gates on
capability, not on backend identity, so a git backend without attestation
still passes the suite without forcing the workspace-nexus to opt out.

---

## Layer Position

L2 (test harness). Depends only on `@koi/core` (L0). Runs on `bun:test` (declared
as `external` in `tsup.config.ts` so the dist bundle stays test-runner-agnostic).
