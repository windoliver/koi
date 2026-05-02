# @koi/middleware-fs-rollback — Filesystem Rollback on Tool Failure

Snapshots the working tree before a protected tool call (e.g. `fs_write`,
`fs_edit`) and restores it on failure, using `git stash` as the snapshot
mechanism.

Closes the third sub-task of issue #1421 (tool-safety middleware bundle).
Companion to `@koi/middleware-tool-error-formatter` (#2099).

---

## Why It Exists

Many file-mutating tools have no native undo. When a tool partially writes a
file and then throws, or returns a failure `ToolResponse`, the working tree is
left in a half-baked state. The agent cannot rely on subsequent file reads
matching its expectations, and the operator may not even notice the partial
write.

Rather than building a bespoke per-tool snapshot scheme (the v1 approach in
`archive/v1/packages/middleware/middleware-fs-rollback`, which used a
custom `FileSystemBackend.read()` + `SnapshotChainStore`), we delegate to
`git stash` — the OS already has the snapshot/restore primitive we need:

- handles binary files
- handles deletions (the v1 in-memory backend could not)
- handles arbitrary subdirectory moves
- restoration is `git stash pop`

Result: the v1 needed ~1.3K LOC of bespoke code; this one delivers the same
guarantee in ~250 LOC of middleware glue.

---

## Architecture

L2 feature package. Depends only on `@koi/core` (L0) and `@koi/git-utils`
(L0u).

```
┌────────────────────────────────────────────────────────┐
│  @koi/middleware-fs-rollback  (L2)                     │
│  types.ts                ← config + handle types       │
│  fs-rollback-middleware.ts ← factory                   │
│  index.ts                ← public API                  │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│  @koi/core       (L0)   KoiMiddleware, ToolRequest,    │
│                          ToolResponse, ToolHandler,     │
│                          KoiError, JsonObject           │
│  @koi/git-utils  (L0u)  runGit                         │
└────────────────────────────────────────────────────────┘
```

---

## Configuration

```typescript
interface FsRollbackConfig {
  /** Tool ids that should be wrapped with snapshot/restore.
   *  Default: ["fs_write", "fs_edit"]. */
  readonly protectedTools?: readonly string[];
  /** Working directory for git commands. Default: process.cwd(). */
  readonly cwd?: string;
  /** Optional seam for tests — replaces the real Bun.spawn-based git runner.
   *  Receives the full argv (without the leading "git") and the cwd. */
  readonly runGit?: (args: readonly string[], cwd: string) => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}
```

Default protected tools (`fs_write`, `fs_edit`) match the v1 prefix
convention. Add `Bash`, `apply_patch`, or any custom tool by passing an
explicit list.

---

## Behavior Matrix

| Situation                                 | Snapshot taken? | Restore on failure? |
| ----------------------------------------- | --------------- | ------------------- |
| In-repo path, dirty tree                  | Yes             | Yes                 |
| In-repo path, clean tree                  | No (no-op)      | Nothing to restore  |
| Path resolves outside the git repo root   | No              | No                  |
| `cwd` is not in any git repository        | No (warn once)  | No                  |
| `git stash pop` fails (merge conflict)    | -               | KoiError(`INTERNAL`, retryable=false) with `context.stashRef` |
| Tool not in `protectedTools`              | No              | No (passthrough)    |

A "failure" is either:
1. The tool handler throws.
2. The tool handler returns `ToolResponse` whose `metadata.blockedByHook ===
   true` or `metadata.exitCode !== 0`.

---

## Priority — 180

Placed at priority **180**, immediately innermost of
`@koi/middleware-tool-error-formatter` (priority 170).

Ordering matters: rollback must restore the working tree BEFORE the
formatter wraps the throw into a model-readable `ToolResponse`. If the
formatter ran innermost, the rollback layer would never see the throw and
the working tree would stay corrupted.

```
… → tool-error-formatter (170) → fs-rollback (180) → tool …
                outer                inner
```

---

## Concurrency

Each call's stash entry is tagged with a unique message:
`koi-fs-rollback:<sessionId>:<callId>:<counter>`. Pop matches by message,
not by stash index — so two protected tool calls in flight from different
sessions cannot pop each other's stash entries. The middleware tracks
per-call whether it actually created a stash entry (clean tree → no
entry → no pop attempted).

---

## TUI Default — Opt-In

This middleware is **not** auto-instantiated by the CLI runtime factory.
Users opt in via manifest. Same posture as
`@koi/middleware-tool-disclosure`. The rationale: many users run koi
outside a git repo, and a no-op middleware adds startup cost and one
warning log to those sessions.

---

## Pop-Conflict Recovery

If `git stash pop` returns non-zero (typically a merge conflict because
the tool wrote files that overlap with prior uncommitted changes), the
middleware throws a `KoiError`:

```typescript
{
  code: "INTERNAL",
  retryable: false,
  message: "fs-rollback: failed to restore snapshot ...",
  context: {
    stashRef: "koi-fs-rollback:<sessionId>:<callId>:<n>",
    toolId: "fs_write",
  },
}
```

The leftover stash entry is **not** auto-discarded — the operator can
recover manually via `git stash list | grep koi-fs-rollback` and
`git stash apply <ref>`.

---

## Related

- Issue #1421 — tool-safety middleware bundle umbrella
- PR #2099 — `tool-error-formatter` + `tool-disclosure` (sub-tasks 1 & 2)
- v1 reference: `archive/v1/packages/middleware/middleware-fs-rollback`
- `@koi/middleware-tool-error-formatter` — runs immediately outside us so
  the model still sees a formatted error after rollback.
