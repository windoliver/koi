# @koi/workspace — Workspace Isolation Backends

Implements the `WorkspaceBackend` (L0) strategy for git worktree isolation, plus a
`ComponentProvider` that attaches `WorkspaceComponent` to agents and handles
lifecycle cleanup.

---

## Why It Exists

Agents need isolated filesystem directories so they can read, write, and build code
without interfering with each other or the host repo. This package provides:

- A `WorkspaceBackend` backed by `git worktree` for fast, branch-scoped isolation
- A `ComponentProvider` that creates workspaces on agent attach, cleans up on detach

---

## Public API

```typescript
import { createGitWorktreeBackend, createWorkspaceProvider } from "@koi/workspace";

// 1. Build a backend
const backend = createGitWorktreeBackend({ repoPath: "/path/to/repo" });

// 2. Build a provider (wires backend into the ECS)
const provider = createWorkspaceProvider({
  backend,
  cleanupPolicy: "on_success", // "always" | "on_success" | "never"
});

// 3. Register provider during koi assembly — agent gets WORKSPACE component
```

---

## Git Worktree Backend

`createGitWorktreeBackend(config)` creates a `WorkspaceBackend` that:

- Runs `git worktree add -b workspace/<agentId>/<id> <path>` on `create`
- Writes a `.koi-workspace` marker file (JSON) inside the worktree
- Runs `git worktree remove --force <path>` on `dispose` (best-effort branch delete)
- Reports `isSandboxed: false` (filesystem access, no OS-level container)

Config:

```typescript
interface GitWorktreeBackendConfig {
  readonly repoPath: string;        // git repo root
  readonly worktreeBasePath?: string; // override for worktree parent dir
}
```

---

## Workspace Provider

`createWorkspaceProvider(config)` returns a `ComponentProvider` that:

1. On `attach`: calls `backend.create()`, optionally calls `postCreate(workspace)`,
   attaches `WorkspaceInfo` under the `WORKSPACE` token
2. On `detach`: applies cleanup policy:
   - `"always"` — dispose regardless of outcome
   - `"on_success"` — dispose only if agent succeeded
   - `"never"` — never dispose (manual cleanup)

Config:

```typescript
interface WorkspaceProviderConfig {
  readonly backend: WorkspaceBackend;
  readonly cleanupPolicy?: CleanupPolicy;       // default: "on_success"
  readonly cleanupTimeoutMs?: number;            // default: 5_000
  readonly postCreate?: (ws: WorkspaceInfo) => Promise<void>;
}
```

---

## Cleanup Policy

| Policy | Disposes on success | Disposes on error |
|--------|--------------------|--------------------|
| `"always"` | ✓ | ✓ |
| `"on_success"` | ✓ | ✗ |
| `"never"` | ✗ | ✗ |

---

## Layer & Dependencies

- **Layer**: L2
- **Imports from**: `@koi/core` (L0), `@koi/git-utils` (L0u)

---

## Changelog

- 2026-04-24 — Initial v2 implementation (issue #1370)
