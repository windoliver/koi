# @koi/workspace — Backend-Agnostic Workspace Isolation

Per-agent workspace isolation for Koi's swarm pattern. Each agent gets its own directory — no merge conflicts during parallel development.

## Why

When multiple agents work on the same codebase simultaneously, they overwrite each other's files:

```
Agent A ──write──┐
Agent B ──write──┤──► same directory ──► MERGE CONFLICTS
Agent C ──write──┘
```

With `@koi/workspace`, each agent gets an isolated workspace:

```
Agent A ──write──► workspace/a1  ──┐
Agent B ──write──► workspace/b2  ──┼──► merge when ready
Agent C ──write──► workspace/c3  ──┘
```

## Architecture

```
L0  @koi/core        WorkspaceComponent + WORKSPACE token
L2  @koi/workspace   WorkspaceBackend interface + provider + git backend
```

The workspace is an **ECS component** attached to agents via a `ComponentProvider`. A `WorkspaceBackend` strategy interface decouples the isolation mechanism from the consumer API.

```
┌──────────────────────────────────────────────────────┐
│                  createKoi()                          │
│   providers: [workspaceProvider]                      │
└────────────────────────┬─────────────────────────────┘
                         │ attach()
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     ┌─────────┐   ┌─────────┐   ┌─────────┐
     │ Agent A  │   │ Agent B  │   │ Agent C  │
     │          │   │          │   │          │
     │ WORKSPACE│   │ WORKSPACE│   │ WORKSPACE│
     │ .path    │   │ .path    │   │ .path    │
     │ .id      │   │ .id      │   │ .id      │
     └────┬─────┘   └────┬─────┘   └────┬─────┘
          │              │              │
          ▼              ▼              ▼
     ┌─────────────────────────────────────────┐
     │          WorkspaceBackend                │
     │  ┌────────────┐ ┌────────┐ ┌─────────┐ │
     │  │Git Worktree│ │Temp Dir│ │ Docker  │ │
     │  │ (shipped)  │ │(custom)│ │(shipped)│ │
     │  └────────────┘ └────────┘ └─────────┘ │
     └─────────────────────────────────────────┘
```

## Quick Start

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createGitWorktreeBackend, createWorkspaceProvider } from "@koi/workspace";
import { WORKSPACE } from "@koi/core";
import type { WorkspaceComponent } from "@koi/core";

// 1. Create backend
const backend = createGitWorktreeBackend({ repoPath: "/path/to/repo" });
if (!backend.ok) throw new Error(backend.error.message);

// 2. Create provider
const provider = createWorkspaceProvider({
  backend: backend.value,
  cleanupPolicy: "on_success",
});
if (!provider.ok) throw new Error(provider.error.message);

// 3. Wire into runtime
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5-20251001" } },
  adapter: createLoopAdapter({ modelCall: handler, maxTurns: 5 }),
  providers: [provider.value],
});

// 4. Access workspace on agent
const ws = runtime.agent.component<WorkspaceComponent>(WORKSPACE);
console.log(ws?.path);     // /path/to/repo-workspaces/workspace-a1
console.log(ws?.metadata); // { branchName: "workspace/a1", baseBranch: "main", repoPath: "..." }

// 5. Agent runs in isolated workspace
const events = await collectEvents(runtime.run({ kind: "text", text: "Fix the bug" }));

// 6. Cleanup on dispose
await runtime.dispose();
```

## WorkspaceBackend Interface

The strategy interface — implement this to add new isolation mechanisms:

```typescript
interface WorkspaceBackend {
  readonly name: string;
  readonly isSandboxed: boolean;
  readonly create: (agentId: AgentId, config: ResolvedWorkspaceConfig)
    => Promise<Result<WorkspaceInfo, KoiError>>;
  readonly dispose: (workspaceId: string)
    => Promise<Result<void, KoiError>>;
  readonly isHealthy: (workspaceId: string)
    => boolean | Promise<boolean>;
}
```

| Member | Purpose |
|--------|---------|
| `name` | Backend identifier (e.g., `"docker"`, `"git-worktree"`) |
| `isSandboxed` | Whether this backend provides OS-level container isolation |
| `create` | Allocate an isolated workspace for the agent |
| `dispose` | Tear down the workspace and free resources |
| `isHealthy` | Check if the workspace is still usable |

## Git Worktree Backend

The shipped backend. Creates a git worktree per agent with its own branch.

```typescript
import { createGitWorktreeBackend } from "@koi/workspace";

const backend = createGitWorktreeBackend({
  repoPath: "/path/to/repo",        // required — must be a git repo
  baseBranch: "main",                // default: "main"
  branchPattern: "workspace/${agentId}", // default — ${agentId} is replaced
  worktreeBasePath: "../workspaces", // default: "../<repoName>-workspaces"
});
```

**What it does:**

1. `git worktree add <path> -b workspace/<agentId> main`
2. Writes `.koi-workspace` marker file (for orphan detection)
3. Returns `WorkspaceInfo` with path, branch name, timestamps

**Filesystem layout:**

```
repo/
├── .git/
├── src/
└── README.md

repo-workspaces/               ← worktreeBasePath
├── workspace-agent-1/         ← Agent 1's isolated copy
│   ├── .koi-workspace         ← marker file
│   ├── src/
│   └── README.md
├── workspace-agent-2/         ← Agent 2's isolated copy
│   ├── .koi-workspace
│   ├── src/
│   └── README.md
└── swarm-agent-3/             ← custom branchPattern
    ├── .koi-workspace
    ├── src/
    └── README.md
```

## Docker Container Backend

Container-based workspace isolation via a pluggable `SandboxAdapter`. Each agent runs inside an isolated container with configurable filesystem access and container reuse policies.

```typescript
import { createDockerWorkspaceBackend, createWorkspaceProvider } from "@koi/workspace";

const backend = createDockerWorkspaceBackend({
  adapter: mySandboxAdapter,   // SandboxAdapter from L0 — Docker, E2B, Fly.io, etc.
  mountMode: "ro",             // "none" | "ro" | "rw" (default: "none")
  scope: "session",            // "session" | "per-agent" | "shared" (default: "per-agent")
  workDir: "/workspace",       // default: "/workspace"
});
if (!backend.ok) throw new Error(backend.error.message);

const provider = createWorkspaceProvider({
  backend: backend.value,
  requireSandbox: true,        // reject non-container backends
  cleanupPolicy: "always",
});
```

The `SandboxAdapter` is injected — the Docker backend doesn't import any Docker SDK. You bring your own adapter (Docker CLI wrapper, E2B client, Fly.io API, etc.) that implements `create(profile) → SandboxInstance`.

### Mount Mode

Controls what the container can see of the host filesystem:

```
  mountMode: "none" (DEFAULT — most restrictive)
  ┌─────────────────────┐       Host /workspace
  │  Container          │       ┌─────────────┐
  │  /workspace (empty) │──✗───│ code/        │
  │  Can't read host.   │       │ secrets/     │
  │  Can't write host.  │       └─────────────┘
  └─────────────────────┘

  mountMode: "ro"
  ┌─────────────────────┐       Host /workspace
  │  Container          │       ┌─────────────┐
  │  /workspace         │──👁───│ code/   [R]  │
  │  Read-only access.  │──✗───│ secrets/ [R] │
  └─────────────────────┘       └─────────────┘

  mountMode: "rw"
  ┌─────────────────────┐       Host /workspace
  │  Container          │       ┌─────────────┐
  │  /workspace         │──⟷───│ code/  [RW]  │
  │  Full read+write.   │       │ secrets/[RW] │
  └─────────────────────┘       └─────────────┘
```

| Mode | `allowRead` | `allowWrite` | Use case |
|------|-------------|--------------|----------|
| `"none"` (default) | `[]` | `[]` | Untrusted code execution, strongest isolation |
| `"ro"` | `[workDir]` | `[]` | Code review agents, analysis, read-only inspection |
| `"rw"` | `[workDir]` | `[workDir]` | Development agents that need to modify files |

`profileOverrides.filesystem` takes precedence over `mountMode` if both are provided.

### Container Scope

Controls how containers are shared across agents:

```
  scope: "session" — fresh container per create(), destroyed on dispose
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Container #1 │  │ Container #2 │  │ Container #3 │
  │ (Agent A)    │  │ (Agent A)    │  │ (Agent B)    │
  │ born → dies  │  │ born → dies  │  │ born → dies  │
  └──────────────┘  └──────────────┘  └──────────────┘
  Three requests = three containers. Nothing persists.

  scope: "per-agent" (DEFAULT) — one container per agentId
  ┌────────────────────────────────┐  ┌──────────────┐
  │     Container #1 (Agent A)     │  │ Container #2 │
  │     reused across requests     │  │ (Agent B)    │
  └────────────────────────────────┘  └──────────────┘

  scope: "shared" — single container, unique sub-paths per agent
  ┌──────────────────────────────────────────────┐
  │           Container #1 (shared)              │
  │  /workspace/agent-a/   ← Agent A's space     │
  │  /workspace/agent-b/   ← Agent B's space     │
  │  ref_count: 2                                │
  │  destroyed when last agent disposes          │
  └──────────────────────────────────────────────┘
```

| Scope | Containers created | Isolation | State persistence | Best for |
|-------|-------------------|-----------|-------------------|----------|
| `"session"` | One per `create()` | Strongest | None | Untrusted workloads |
| `"per-agent"` (default) | One per `agentId` | Per-agent | Across requests | Long-running dev agents |
| `"shared"` | One total | Sub-path only | Shared container | Cost-sensitive, many agents |

### Require Sandbox

Policy guard that rejects non-container backends at factory time:

```typescript
const provider = createWorkspaceProvider({
  backend: gitWorktreeBackend,   // isSandboxed: false
  requireSandbox: true,          // ← VALIDATION error!
});
// Result.error: "requireSandbox is enabled but backend 'git-worktree'
//               does not provide container isolation"
```

Backends self-declare their isolation capability via `isSandboxed: boolean`:

| Backend | `isSandboxed` | `requireSandbox: true` |
|---------|---------------|------------------------|
| Docker container | `true` | Allowed |
| Git worktree | `false` | Rejected |
| Temp directory | `false` | Rejected |
| E2B (custom) | `true` | Allowed |

### Blocked Path Patterns

In shared scope, agent IDs become sub-path names (`/workspace/{agentId}`). To prevent agents from targeting credential directories, the backend rejects agent IDs containing sensitive segments:

```
Blocked: .ssh  .gnupg  .aws  .azure  .gcloud  .kube  .docker
         .env  .netrc  .npmrc  .secret  credentials
         id_rsa  id_ed25519  private_key
```

```typescript
// ❌ Rejected — ".ssh" segment detected
backend.create(agentId("agent-.ssh-keys"), config);
// Result.error: 'Agent ID "agent-.ssh-keys" contains blocked path segment ".ssh"'

// ❌ Rejected — path traversal
backend.create(agentId("../../etc/passwd"), config);
// Result.error: 'Agent ID "../../etc/passwd" would escape workDir boundary'

// ✅ Allowed
backend.create(agentId("code-reviewer-42"), config);
```

These checks only apply to shared scope (where agent IDs become sub-paths). Per-agent and session scopes use the root `workDir` directly.

### Docker Backend Quick Start

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createDockerWorkspaceBackend, createWorkspaceProvider } from "@koi/workspace";
import type { WorkspaceComponent } from "@koi/core";
import { WORKSPACE } from "@koi/core";

// 1. Create backend with your SandboxAdapter
const backend = createDockerWorkspaceBackend({
  adapter: myDockerAdapter,
  mountMode: "ro",
  scope: "session",
});
if (!backend.ok) throw new Error(backend.error.message);

// 2. Create provider with sandbox enforcement
const provider = createWorkspaceProvider({
  backend: backend.value,
  requireSandbox: true,
  cleanupPolicy: "always",
});
if (!provider.ok) throw new Error(provider.error.message);

// 3. Wire into runtime
const runtime = await createKoi({
  manifest: { name: "reviewer", version: "1.0.0", model: { name: "claude-haiku-4-5-20251001" } },
  adapter: createPiAdapter({ model: "anthropic:claude-haiku-4-5-20251001", getApiKey }),
  providers: [provider.value],
});

// 4. Agent runs inside container with read-only filesystem
const ws = runtime.agent.component<WorkspaceComponent>(WORKSPACE);
console.log(ws?.path);     // /workspace
console.log(ws?.metadata); // { adapterName: "docker", workDir: "/workspace" }
```

### SandboxAdapter Contract

The Docker backend delegates container lifecycle to a `SandboxAdapter` (defined in L0):

```typescript
interface SandboxAdapter {
  readonly name: string;
  readonly create: (profile: SandboxProfile) => Promise<SandboxInstance>;
}

interface SandboxInstance {
  readonly exec: (command: string, args: readonly string[]) => Promise<SandboxAdapterResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  readonly destroy: () => Promise<void>;
}
```

You implement this interface to plug in any container runtime — Docker CLI, E2B, Fly.io, OrbStack, etc.

## Cleanup Policies

Control what happens when an agent detaches:

| Policy | Behavior |
|--------|----------|
| `"on_success"` (default) | Dispose only when `terminationOutcome === "success"`. Preserve on `"error"`, `"interrupted"`, or unknown outcome (fail-closed) |
| `"always"` | Always dispose regardless of outcome |
| `"never"` | Never dispose — workspace persists for debugging |

The cleanup decision uses the agent's `TerminationOutcome`, which is derived from the engine's stop reason:

| Engine Stop Reason | Termination Outcome | `on_success` Action |
|--------------------|--------------------|--------------------|
| `"completed"` | `"success"` | Cleanup |
| `"max_turns"` | `"success"` | Cleanup |
| `"error"` | `"error"` | **Preserve** |
| `"interrupted"` | `"interrupted"` | **Preserve** |
| Agent still running | `undefined` | **Preserve** |

```typescript
const provider = createWorkspaceProvider({
  backend: backend.value,
  cleanupPolicy: "on_success",  // keep workspace on failure for debugging
  cleanupTimeoutMs: 5_000,      // default: 5 seconds
});
```

### Preservation Logging

When a workspace is preserved (not cleaned up), the provider emits a structured log line so operators can see why workspaces persist:

```
[workspace] preserved workspace ws-abc for agent agent-123 (policy=on_success, outcome=error)
```

This answers: which workspace, which agent, which policy, and which outcome caused preservation.

## Post-Create Hooks

Run setup commands after workspace creation (e.g., `bun install`):

```typescript
import { createShellSetup, createWorkspaceProvider } from "@koi/workspace";

// Option 1: Shell command helper
const provider = createWorkspaceProvider({
  backend: backend.value,
  postCreate: createShellSetup("bun", ["install"]),
});

// Option 2: Custom function
const provider = createWorkspaceProvider({
  backend: backend.value,
  postCreate: async (ws) => {
    await Bun.write(`${ws.path}/.env`, "NODE_ENV=development");
    // If this throws, workspace is automatically disposed
  },
});
```

If `postCreate` throws, the workspace is disposed automatically and the error propagates.

## Automatic Stale Pruning

Preserved workspaces accumulate over time. The `pruneStale` config hook triggers automatic cleanup of orphaned workspaces whenever a workspace is preserved:

```typescript
import {
  createGitWorktreeBackend,
  createWorkspaceProvider,
  pruneStaleWorkspaces,
} from "@koi/workspace";

const repoPath = "/path/to/repo";
const backend = createGitWorktreeBackend({ repoPath });

const provider = createWorkspaceProvider({
  backend: backend.value,
  cleanupPolicy: "on_success",
  pruneStale: () => pruneStaleWorkspaces(repoPath),
});
```

**How it works:**

```
  detach(agent)
       │
       ├── shouldCleanup=true ──► dispose workspace, done
       │
       └── shouldCleanup=false
            │
            ├── log: "[workspace] preserved workspace ws-abc ..."
            │
            └── pruneStale()   ◄── fires here, best-effort
                 │
                 ├── success ──► stale workspaces removed
                 └── failure ──► swallowed, logged as warning
```

The hook is **backend-agnostic** — it's just `() => Promise<void>`. Wire it to `pruneStaleWorkspaces` for git worktrees, or your own implementation for containers, cloud VMs, etc.

**Design decisions:**

- **Best-effort** — `pruneStale` failure never blocks or breaks detach
- **Caller-controlled** — the provider doesn't import any pruning logic; you choose the implementation
- **Only on preservation** — never fires when cleanup succeeds (no orphans to prune)
- **Not a hot path** — detach is a lifecycle event, not per-request

## Orphan Cleanup

Workspaces can become orphaned if the host process crashes. `pruneStaleWorkspaces()` detects and cleans them up:

```typescript
import { pruneStaleWorkspaces } from "@koi/workspace";

// Dry run — see what would be pruned
const preview = await pruneStaleWorkspaces("/path/to/repo", { dryRun: true });
console.log(preview.pruned); // ["/path/to/repo-workspaces/workspace-a1"]

// Actual prune — removes stale worktrees
const result = await pruneStaleWorkspaces("/path/to/repo", {
  maxAgeMs: 24 * 60 * 60 * 1_000, // default: 24 hours
});
```

**Detection logic:**

1. `git worktree list --porcelain` to find all worktrees
2. Check each for `.koi-workspace` marker file
3. Mark stale if: owning PID is dead **OR** age exceeds `maxAgeMs`
4. Remove stale worktrees with `git worktree remove --force`
5. Run `git worktree prune` as safety net

## Parallel Swarm Pattern

Multiple agents, each with isolated workspaces, running in parallel:

```typescript
// Agent 1 — default branch pattern
const provider1 = createWorkspaceProvider({
  backend: createGitWorktreeBackend({ repoPath }).value,
  cleanupPolicy: "never",
});

// Agent 2 — custom branch pattern to avoid collision
const provider2 = createWorkspaceProvider({
  backend: createGitWorktreeBackend({
    repoPath,
    branchPattern: "swarm/${agentId}",
  }).value,
  cleanupPolicy: "never",
});

const [runtime1, runtime2] = await Promise.all([
  createKoi({ manifest: manifest1, adapter: adapter1, providers: [provider1.value] }),
  createKoi({ manifest: manifest2, adapter: adapter2, providers: [provider2.value] }),
]);

// Both agents run simultaneously in isolated workspaces
const [events1, events2] = await Promise.all([
  collectEvents(runtime1.run({ kind: "text", text: "Fix auth bug" })),
  collectEvents(runtime2.run({ kind: "text", text: "Add tests" })),
]);
```

## Writing a Custom Backend

Implement the `WorkspaceBackend` interface:

```typescript
import type { AgentId, KoiError, Result } from "@koi/core";
import type { ResolvedWorkspaceConfig, WorkspaceBackend, WorkspaceInfo } from "@koi/workspace";

function createTmpDirBackend(): Result<WorkspaceBackend, KoiError> {
  const tracked = new Map<string, string>();

  return {
    ok: true,
    value: {
      name: "tmpdir",
      isSandboxed: false,  // no container isolation

      create: async (agentId: AgentId, _config: ResolvedWorkspaceConfig) => {
        const dir = await mkdtemp(`/tmp/koi-ws-${agentId}-`);
        const id = `tmp-${agentId}-${Date.now()}`;
        tracked.set(id, dir);
        return {
          ok: true,
          value: { id, path: dir, createdAt: Date.now(), metadata: {} },
        };
      },

      dispose: async (workspaceId: string) => {
        const dir = tracked.get(workspaceId);
        if (!dir) return { ok: false, error: { code: "NOT_FOUND", message: "Unknown", retryable: false } };
        tracked.delete(workspaceId);
        await rm(dir, { recursive: true });
        return { ok: true, value: undefined };
      },

      isHealthy: (workspaceId: string) => {
        const dir = tracked.get(workspaceId);
        return dir !== undefined && existsSync(dir);
      },
    },
  };
}
```

Then plug it in — zero consumer changes:

```typescript
const provider = createWorkspaceProvider({
  backend: createTmpDirBackend().value,
  cleanupPolicy: "always",
});
```

## Public API

| Export | Type | Purpose |
|--------|------|---------|
| `createWorkspaceProvider` | Factory | Creates a `ComponentProvider` for workspace isolation |
| `createGitWorktreeBackend` | Factory | Git worktree `WorkspaceBackend` implementation |
| `createDockerWorkspaceBackend` | Factory | Docker container `WorkspaceBackend` implementation |
| `createFilesystemPolicy` | Utility | Derive `FilesystemPolicy` from a `MountMode` and workDir (Docker backend) |
| `createShellSetup` | Factory | Convenience `postCreate` hook for shell commands |
| `pruneStaleWorkspaces` | Utility | Detect and clean up orphaned workspaces |
| `validateWorkspaceConfig` | Validation | Validate and apply defaults to config |
| `WorkspaceBackend` | Interface | Strategy interface for custom backends |
| `WorkspaceInfo` | Interface | Workspace metadata returned by backends |
| `WorkspaceProviderConfig` | Interface | User-facing provider configuration |
| `DockerWorkspaceBackendConfig` | Interface | Docker backend configuration |
| `CleanupPolicy` | Type | `"always" \| "on_success" \| "never"` |
| `MountMode` | Type | `"none" \| "ro" \| "rw"` |
| `ContainerScope` | Type | `"session" \| "per-agent" \| "shared"` |

## L0 Types (in @koi/core)

```typescript
// Typed component — accessible on any agent
interface WorkspaceComponent {
  readonly path: string;
  readonly id: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
}

// Well-known token
const WORKSPACE: SubsystemToken<WorkspaceComponent>;

// Usage
const ws = agent.component<WorkspaceComponent>(WORKSPACE);
```

## Related

- Issue #325 — Original implementation issue
- Issue #394 — Nexus-backed workspace backend (cross-device sync)
- `@koi/core` `ecs.ts` — `WorkspaceComponent` and `WORKSPACE` token
- `@koi/test-utils` — `createTempGitRepo()` helper for testing
