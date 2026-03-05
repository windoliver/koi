# @koi/ipc-stack — IPC Meta-Package

Convenience package that wires `@koi/ipc-local` + `@koi/task-spawn` + `@koi/parallel-minions` + `@koi/orchestrator` + `@koi/workspace` + `@koi/scratchpad-local` into a single `createIpcStack()` call with preset-based defaults.

---

## Why It Exists

The 10 active IPC packages under `packages/ipc/` are standalone L2 packages that users must manually import and wire together. This means knowing which packages exist, importing spawn adapters (`mapSpawnToTask`, `mapSpawnToMinion`, `mapSpawnToWorker`), and composing providers yourself. This L3 bundle provides:

- **One-call setup** — `createIpcStack()` creates and connects all IPC subsystems
- **Preset-based defaults** — `"local"` for dev/test, `"distributed"` for production
- **Spawn adapter wiring** — automatically bridges L0 `SpawnFn` to each L2 package's internal spawn type
- **Tool provisioning** — delegation tools (`task`, `parallel_task`, `orchestrate`) attached to agents via providers
- **Nexus injection** — accepts pre-built Nexus providers from `@koi/nexus` without creating its own

---

## What This Enables

- Agents get delegation tools (task-spawn, parallel-minions, orchestrator) with zero manual wiring
- Workspace isolation (git worktrees, Docker) configured in one place
- Local scratchpad for multi-agent shared state
- Switch between single-task and fan-out delegation by changing one preset field
- Composable with `@koi/nexus` for distributed IPC (mailbox, scratchpad, federation)

---

## Architecture

`@koi/ipc-stack` is an **L3 meta-package** — it composes L2 packages with zero new business logic.

```
┌───────────────────────────────────────────────────────┐
│  @koi/ipc-stack  (L3)                                 │
│                                                       │
│  types.ts              ← IpcStackConfig / IpcBundle   │
│  presets.ts            ← local / distributed presets   │
│  config-resolution.ts  ← 3-layer merge + validation   │
│  ipc-stack.ts          ← createIpcStack() factory     │
│  index.ts              ← public API surface           │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Dependencies                                         │
│                                                       │
│  @koi/ipc-local         (L2)  in-memory mailbox       │
│  @koi/task-spawn        (L2)  single-task delegation  │
│  @koi/parallel-minions  (L2)  fan-out delegation      │
│  @koi/orchestrator      (L2)  DAG task board          │
│  @koi/workspace         (L2)  workspace isolation     │
│  @koi/scratchpad-local  (L2)  in-memory scratchpad    │
│  @koi/core              (L0)  SpawnFn, types          │
└───────────────────────────────────────────────────────┘

Nexus-backed IPC (ipc-nexus, scratchpad-nexus, federation)
is provided by @koi/nexus and injected via nexusProviders.
```

---

## Quick Start

### Minimal (local preset)

```typescript
import { createIpcStack } from "@koi/ipc-stack";

const { providers, middlewares, router } = createIpcStack({
  spawn: mySpawnFn,
});

// router is a local MailboxRouter for in-process agent messaging
// providers include task-spawn (agents get the "task" tool)
const runtime = await createKoi({ middleware: middlewares, providers });
```

### Fan-out delegation

```typescript
const { providers } = createIpcStack({
  spawn: mySpawnFn,
  delegation: { kind: "parallel-minions" },
});
// Agents get the "parallel_task" tool for fan-out/fan-in
```

### With orchestrator + workspace

```typescript
const { providers } = createIpcStack({
  spawn: mySpawnFn,
  delegation: { kind: "orchestrator", config: { maxConcurrency: 10 } },
  workspace: { backend: createGitWorktreeBackend({ repoPath: "." }) },
  scratchpad: {
    kind: "local",
    config: { groupId: myGroupId, authorId: myAgentId },
  },
});
// Agents get orchestrate/assign_worker/review_output/synthesize tools
// + workspace isolation + shared scratchpad
```

### With Nexus (via @koi/nexus)

```typescript
import { createNexusBackends } from "@koi/nexus";
import { createIpcStack } from "@koi/ipc-stack";

const nexus = createNexusBackends({ baseUrl, apiKey });

const { providers, middlewares } = createIpcStack({
  spawn: mySpawnFn,
  preset: "distributed",
  nexusProviders: [nexus.mailbox.provider, nexus.scratchpad.provider],
  nexusMiddlewares: [nexus.scratchpad.middleware],
});
```

---

## Presets

| Preset | Delegation | Local messaging | Use case |
|--------|-----------|----------------|----------|
| `"local"` (default) | task-spawn | yes (router) | Dev/test/single-node |
| `"distributed"` | parallel-minions | no (expect nexus injection) | Production multi-node |

Presets set defaults for delegation and messaging. User overrides always win.

---

## Key Types

| Type | Purpose |
|------|---------|
| `IpcStackConfig` | Combined config: preset + spawn + subsystem fields |
| `IpcBundle` | Return type — providers + middlewares + disposables + metadata |
| `IpcPreset` | `"local" \| "distributed"` |
| `IpcPresetSpec` | Partial config used in preset definitions |
| `ResolvedIpcMeta` | Introspection metadata (preset, kinds, counts) |

---

## Tools Provided to Agents

| Delegation kind | Tools attached |
|----------------|---------------|
| `task-spawn` | `task` — delegate single task to subagent |
| `parallel-minions` | `parallel_task` — fan-out tasks to multiple subagents |
| `orchestrator` | `orchestrate`, `assign_worker`, `review_output`, `synthesize` |

Workspace and scratchpad attach components (not tools) — `WORKSPACE` and `SCRATCHPAD` ECS tokens.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Presets don't create Nexus instances | Avoids overlap with `@koi/nexus` L3 bundle |
| `spawn` is required (not optional) | Delegation is the core value prop — fail fast if missing |
| Workspace errors throw (not silent) | User explicitly requested isolation — silent failure is dangerous |
| Arrays frozen before return | Runtime immutability matches `readonly` type contract |
| Federation not included | Inherently distributed — belongs in `@koi/nexus` |
