# createServiceProvider — Generic Backend+Tools ComponentProvider Factory

Two pure L0 factory functions that eliminate the repeated pattern of wiring a backend and its tool factories into a `ComponentProvider`. Every L2 provider that follows the "backend + operations map + singleton token" pattern can be expressed as a config object instead of ~40 lines of boilerplate.

- `createServiceProvider<TBackend, TOperation>()` — for multi-tool providers with a shared backend
- `createSingleToolProvider()` — for single-tool providers (degenerate case)

---

## Why It Exists

Five providers in the Koi monorepo independently implemented the same attach/detach/caching logic:

```
FileSystemProvider   5 tools  + FILESYSTEM token  + scope + detach
WebhookProvider      2 tools  + WEBHOOK token
BrowserProvider     18 tools  + BROWSER token      + scope + detach + custom tools
TaskSpawnProvider    1 tool
ParallelMinions      1 tool
```

Each one built a `Map<string, unknown>` by iterating operations, calling factories, casting `toolToken()`, and optionally attaching a singleton. This amounted to ~400 lines of near-identical boilerplate across the codebase.

`createServiceProvider` extracts that shared skeleton. A new provider is ~8 lines of config instead of ~40 lines of Map construction.

---

## What This Enables

### Before vs After

```
WITHOUT createServiceProvider: every provider reimplements Map wiring
══════════════════════════════════════════════════════════════════════

  FileSystemProvider      WebhookProvider       BrowserProvider
  ┌──────────────────┐   ┌──────────────────┐  ┌──────────────────┐
  │ validate ops     │   │ validate ops     │  │ validate ops     │
  │ iterate factories│   │ iterate factories│  │ iterate factories│
  │ toolToken() cast │   │ toolToken() cast │  │ toolToken() cast │
  │ singleton token  │   │ singleton token  │  │ singleton token  │
  │ build Map        │   │ build Map        │  │ build Map        │
  │ cache result     │   │ cache result     │  │ cache result     │
  │ detach/dispose   │   │                  │  │ detach/dispose   │
  │──────────────────│   │──────────────────│  │──────────────────│
  │ scope wrapping   │   │ (nothing custom) │  │ custom tools     │
  │                  │   │                  │  │ scope wrapping   │
  └──────────────────┘   └──────────────────┘  └──────────────────┘
       ▲ duplicated           ▲ duplicated          ▲ duplicated


WITH createServiceProvider: shared factory, config-only consumers
═════════════════════════════════════════════════════════════════

                    createServiceProvider<T, Op>()
                ┌─────────────────────────────────┐
                │  ● validate (non-empty, no dupes)│
                │  ● iterate ops × factories       │
                │  ● toolToken() cast (internalized)│
                │  ● singleton token attachment     │
                │  ● Map construction + caching     │
                │  ● customTools hook (escape hatch)│
                │  ● detach callback                │
                └──────────┬──────────────────────┘
          ┌────────────────┼──────────────┐
          ▼                ▼              ▼
  ┌─────────────┐  ┌────────────┐  ┌────────────┐
  │ Filesystem  │  │ Webhook    │  │ Browser    │
  │ ~8 lines    │  │ ~6 lines   │  │ ~30 lines  │
  │ + scope     │  │ config only│  │ + custom   │
  └─────────────┘  └────────────┘  └────────────┘
   config-only      config-only     config+custom


                createSingleToolProvider()
                ┌────────────────────────┐
                │  ● single tool:name    │
                │  ● lazy cached         │
                └──────────┬─────────────┘
          ┌────────────────┼──────────────┐
          ▼                ▼              ▼
  ┌─────────────┐  ┌──────────────┐  ┌────────┐
  │ TaskSpawn   │  │ Parallel     │  │ Future │
  │ ~4 lines    │  │ Minions      │  │ single │
  │             │  │ ~4 lines     │  │ tools  │
  └─────────────┘  └──────────────┘  └────────┘
```

---

## Architecture

```
L0  @koi/core       createServiceProvider()      ◄── pure fn on L0 types
                    createSingleToolProvider()    ◄── pure fn on L0 types
                    ServiceProviderConfig<T,Op>   ◄── config interface
                    SingleToolProviderConfig      ◄── config interface
                    ComponentProvider             ◄── return type
                    SubsystemToken<T>             ◄── singleton token type
                    Tool, TrustTier               ◄── tool types
                    toolToken()                   ◄── branded constructor

L2  @koi/filesystem          createFileSystemProvider()  → calls createServiceProvider
    @koi/webhook-provider    createWebhookProvider()     → calls createServiceProvider
    @koi/tool-browser        createBrowserProvider()     → calls createServiceProvider
    @koi/task-spawn          createTaskSpawnProvider()    → calls createSingleToolProvider
    @koi/parallel-minions    createMinionsProvider()      → calls createSingleToolProvider
```

Both factories live in `@koi/core` (L0). They are permitted as pure functions operating only on L0 types — no external imports, no side effects, no I/O.

---

## How It Works

### createServiceProvider — Assembly Flow

```
createServiceProvider(config)
         │
         ▼
  ┌─────────────────────────────────┐
  │ 1. Validate                     │
  │    operations.length > 0?       │──── throws if empty
  │    no duplicates?               │──── throws if dupes
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 2. Return ComponentProvider     │
  │    { name, priority?, attach }  │
  └──────────────┬──────────────────┘
                 │
                 │  attach(agent) called by createKoi during assembly
                 ▼
  ┌─────────────────────────────────┐
  │ 3. Check cache                  │
  │    cached? → return cached Map  │──── fast path (default: on)
  └──────────────┬──────────────────┘
                 │ cache miss
                 ▼
  ┌─────────────────────────────────┐
  │ 4. Build component Map          │
  │                                 │
  │  entries = []                   │
  │                                 │
  │  if singletonToken:             │
  │    entries += [TOKEN, backend]  │
  │                                 │
  │  for op in operations:          │
  │    tool = factories[op](        │
  │      backend, prefix, trustTier │
  │    )                            │
  │    entries += [toolToken, tool]  │
  │                                 │
  │  if customTools:                │
  │    entries += customTools(      │
  │      backend, agent             │
  │    )                            │
  │                                 │
  │  return new Map(entries)        │
  └─────────────────────────────────┘
```

### Component Map Structure

```
┌────────────────────────────────────────────────────┐
│  ReadonlyMap<string, unknown>                       │
│                                                     │
│  Key                         Value                  │
│  ─────────────────────────── ──────────────────────│
│  "subsystem:filesystem"      FileSystemBackend      │  ◄── singletonToken
│  "tool:fs_read"              Tool { execute, ... }  │  ◄── from factories
│  "tool:fs_write"             Tool { execute, ... }  │
│  "tool:fs_edit"              Tool { execute, ... }  │
│  "tool:fs_list"              Tool { execute, ... }  │
│  "tool:fs_search"            Tool { execute, ... }  │
│                                                     │
└────────────────────────────────────────────────────┘

This Map is returned by attach() and merged into the Agent entity.
Other code queries tools via agent.query<Tool>("tool:").
```

---

## Quick Start

### Multi-Tool Provider (createServiceProvider)

```typescript
import { createServiceProvider, FILESYSTEM } from "@koi/core";
import type { FileSystemBackend, Tool, TrustTier } from "@koi/core";

// 1. Define your tool factories
const TOOL_FACTORIES = {
  read:   (b: FileSystemBackend, p: string, t: TrustTier): Tool => createFsReadTool(b, p, t),
  write:  (b: FileSystemBackend, p: string, t: TrustTier): Tool => createFsWriteTool(b, p, t),
  list:   (b: FileSystemBackend, p: string, t: TrustTier): Tool => createFsListTool(b, p, t),
} as const;

type FsOperation = keyof typeof TOOL_FACTORIES;

// 2. Create the provider — 8 lines
export function createFileSystemProvider(config: {
  readonly backend: FileSystemBackend;
  readonly operations?: readonly FsOperation[];
}): ComponentProvider {
  return createServiceProvider({
    name: `filesystem:${config.backend.name}`,
    singletonToken: FILESYSTEM,
    backend: config.backend,
    operations: config.operations ?? ["read", "write", "list"],
    factories: TOOL_FACTORIES,
    trustTier: "verified",
    prefix: "fs",
  });
}

// 3. Wire into runtime
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku" } },
  adapter: createPiAdapter({ model: "anthropic:claude-haiku-4-5-20251001", ... }),
  providers: [createFileSystemProvider({ backend: myBackend })],
});
```

### Single-Tool Provider (createSingleToolProvider)

```typescript
import { createSingleToolProvider } from "@koi/core";

export function createTaskSpawnProvider(config: TaskSpawnConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "task-spawn",
    toolName: "task",
    createTool: () => createTaskTool(config),
  });
}
```

---

## API Reference

### createServiceProvider\<TBackend, TOperation\>

```typescript
function createServiceProvider<TBackend, TOperation extends string>(
  config: ServiceProviderConfig<TBackend, TOperation>,
): ComponentProvider
```

**Config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Provider name for debugging |
| `singletonToken` | `SubsystemToken<TBackend>` | `undefined` | Registers backend under this token |
| `backend` | `TBackend` | `undefined` | Backend instance passed to factories |
| `operations` | `readonly TOperation[]` | required | Operations to include (non-empty) |
| `factories` | `Record<TOperation, Factory>` | required | `(backend, prefix, trustTier) => Tool` |
| `trustTier` | `TrustTier` | `"verified"` | Trust tier for all tools |
| `prefix` | `string` | `""` | Prefix for tool names (`{prefix}_{op}`) |
| `priority` | `number` | `undefined` | Assembly priority (lower = higher) |
| `cache` | `boolean` | `true` | Cache Map after first attach |
| `customTools` | `(backend, agent) => [key, value][]` | `undefined` | Extra entries appended to Map |
| `detach` | `(backend) => Promise<void>` | `undefined` | Cleanup callback |

**Throws:**
- `Error` if `operations` is empty
- `Error` if `operations` contains duplicates

### createSingleToolProvider

```typescript
function createSingleToolProvider(
  config: SingleToolProviderConfig,
): ComponentProvider
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Provider name |
| `toolName` | `string` | required | Tool name (without `tool:` prefix) |
| `createTool` | `() => Tool` | required | Factory called once on first attach |
| `priority` | `number` | `undefined` | Assembly priority |

---

## Design Decisions

### Why L0?

Both factories are pure functions that operate only on L0 types (`ComponentProvider`, `Tool`, `SubsystemToken`, `TrustTier`, `Agent`). They have zero imports from any `@koi/*` package. This keeps them available to all L2 packages without introducing cross-dependencies.

### Why cache by default?

Most providers create the same tools regardless of which agent attaches. Caching avoids re-creating identical tool instances on each `attach()`. The Scheduler provider is the exception — it creates per-agent components — and uses `cache: false`.

### Why throw on empty operations?

An empty operations list is always a programmer error. Failing fast at construction time (not at `attach()` time) makes the error visible immediately and prevents silent misconfiguration.

### Why customTools instead of a more general hook?

Browser needs 6 tools with non-standard factory signatures (navigate takes a security config, evaluate uses a different trust tier, upload/trace are driver-optional). Rather than complicating the standard factory signature, `customTools` is an escape hatch that appends extra entries to the Map after standard tools are built.

### Why not unify Scheduler?

The Scheduler provider creates a per-agent `SchedulerComponent` at attach time (pinned to `agent.pid.id`). This fundamentally doesn't fit a static-backend model. Forcing it through `createServiceProvider` would require `backend: undefined as unknown` and a `customTools` that rebuilds everything — worse than the original.

---

## Full Assembly Path

```
User code                 L1 Engine                   L0 Factory
─────────────────────    ──────────────────────────   ─────────────────────

createFileSystem
Provider({
  backend,
  operations: [
    "read", "write"
  ],
})
  │
  ├─ scope wrap?
  │
  └─► createService
      Provider({
        name, backend,
        operations,
        factories,
        trustTier,
        prefix: "fs",
        singletonToken:
          FILESYSTEM,
        detach: ...
      })
        │
        └─► returns ──────► ComponentProvider
                              │
                              │    createKoi({ providers: [...] })
                              │              │
                              │              ▼
                              │    ┌──────────────────────┐
                              │    │  AgentEntity.assemble │
                              │    │                      │
                              ├───►│  provider.attach(    │
                              │    │    agent              │
                              │    │  )                    │
                              │    │         │             │
                              │    │         ▼             │
                              │    │  Map {                │
                              │    │   FILESYSTEM → backend│
                              │    │   tool:fs_read → Tool │
                              │    │   tool:fs_write→ Tool │
                              │    │  }                    │
                              │    │         │             │
                              │    │         ▼             │
                              │    │  merged into          │
                              │    │  agent.components     │
                              │    └──────────────────────┘
                              │              │
                              │              ▼
                              │    ┌──────────────────────┐
                              │    │  Middleware Chain      │
                              │    │                      │
                              │    │  wrapToolCall(req)    │
                              │    │    │                  │
                              │    │    ▼                  │
                              │    │  tool = agent.query   │
                              │    │    <Tool>("tool:")    │
                              │    │  tool.execute(args)   │
                              │    └──────────────────────┘
                              │              │
                              │              ▼
                              │    ┌──────────────────────┐
                              │    │  Engine (Pi adapter)  │
                              │    │  LLM ◄──► tools      │
                              │    └──────────────────────┘
```

---

## Consumer Patterns

### Pattern A: Simple config (Webhook)

No scope, no special cases. Pure config pass-through.

```typescript
export function createWebhookProvider(config: WebhookProviderConfig): ComponentProvider {
  return createServiceProvider({
    name: "webhook",
    singletonToken: WEBHOOK,
    backend: config.webhookComponent,
    operations: config.operations ?? OPERATIONS,
    factories: TOOL_FACTORIES,
    trustTier: config.trustTier ?? "verified",
    prefix: config.prefix ?? DEFAULT_PREFIX,
  });
}
```

### Pattern B: Backend wrapping (Filesystem)

Scope proxy wraps the backend before passing to the factory.

```typescript
export function createFileSystemProvider(config: FileSystemProviderConfig): ComponentProvider {
  const backend = config.scope !== undefined
    ? createScopedFileSystem(config.backend, config.scope)
    : config.backend;

  return createServiceProvider({
    name: `filesystem:${backend.name}`,
    singletonToken: FILESYSTEM,
    backend,
    operations: config.operations ?? OPERATIONS,
    factories: TOOL_FACTORIES,
    prefix: config.prefix ?? DEFAULT_PREFIX,
    detach: async (b) => { if (b.dispose) await b.dispose(); },
  });
}
```

### Pattern C: Custom tools hook (Browser)

Standard tools go through factories. Navigate, evaluate, upload, and trace tools have non-standard signatures — handled by `customTools`.

```typescript
export function createBrowserProvider(config: BrowserProviderConfig): ComponentProvider {
  const standardOps = operations.filter((op) => STANDARD_OPS.has(op));

  return createServiceProvider({
    name: `browser:${backend.name}`,
    singletonToken: BROWSER,
    backend,
    operations: standardOps,
    factories: TOOL_FACTORIES,
    prefix,
    customTools: (b) =>
      createCustomToolEntries(operations, b, prefix, trustTier, compiledSecurity),
    detach: async (b) => { if (b.dispose) await b.dispose(); },
  });
}
```

### Pattern D: Single tool (TaskSpawn)

Degenerate case — one tool, no backend, no singleton.

```typescript
export function createTaskSpawnProvider(config: TaskSpawnConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "task-spawn",
    toolName: "task",
    createTool: () => createTaskTool(config),
  });
}
```

---

## Adding a New Provider

To add a new L2 service provider:

1. **Define tool factories** in your package — one per operation:
   ```typescript
   const TOOL_FACTORIES = {
     search: createSearchTool,
     index:  createIndexTool,
   } as const;
   type SearchOp = keyof typeof TOOL_FACTORIES;
   ```

2. **Define a singleton token** in `@koi/core` (if your backend needs to be queryable):
   ```typescript
   export const SEARCH = subsystemToken<SearchBackend>("search");
   ```

3. **Create your provider factory**:
   ```typescript
   export function createSearchProvider(config: SearchProviderConfig): ComponentProvider {
     return createServiceProvider<SearchBackend, SearchOp>({
       name: `search:${config.backend.name}`,
       singletonToken: SEARCH,
       backend: config.backend,
       operations: config.operations ?? OPERATIONS,
       factories: TOOL_FACTORIES,
       prefix: config.prefix ?? "search",
     });
   }
   ```

4. **Wire into createKoi**:
   ```typescript
   providers: [createSearchProvider({ backend: mySearchBackend })]
   ```

That's it. Validation, caching, token casting, and Map construction are handled by the factory.

---

## Layer Compliance

- [x] `createServiceProvider` and `createSingleToolProvider` live in `@koi/core` (L0)
- [x] Zero imports from any `@koi/*` package — only imports from `./ecs.js` (same package)
- [x] No function bodies that depend on external state — pure data construction
- [x] All config properties are `readonly`
- [x] Returns `ReadonlyMap` — consumers cannot mutate the component Map
- [x] L2 consumers import only from `@koi/core` — no peer L2 imports

---

## Related

- Issue: #358
- Tests: `packages/core/src/create-service-provider.test.ts` (24 tests, 100% coverage)
- Tests: `packages/core/src/create-single-tool-provider.test.ts` (8 tests, 100% coverage)
- E2E: `packages/engine/src/__tests__/e2e-service-provider.test.ts` (9 tests, real LLM)
- Analogy: `@koi/channel-base` does the same for channels — `createChannelAdapter()` extracts shared channel plumbing
