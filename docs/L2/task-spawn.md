# @koi/task-spawn

Lightweight task tool for zero-friction subagent spawning (Layer 2).

Injects a `task` tool via `ComponentProvider` that lets a parent agent delegate
work to subagent types. The spawn callback is provided by the consumer (L3/app),
keeping this package free of L1 engine imports.

## Why It Exists

Agents need to delegate work — research, code review, analysis — without the
parent knowing how spawning works. Before `task-spawn`, the parent would need
direct access to `@koi/engine` and `spawnChildAgent()`, violating layer rules.

`task-spawn` solves this by injecting a single `task` tool that the LLM calls
naturally, while the spawn/message mechanics are wired externally.

## What This Enables

```
┌─────────────────────────────────────────────────────────┐
│  Parent Agent (orchestrator)                            │
│                                                         │
│  "Use the task tool to delegate research to a worker"   │
│                                                         │
│  ┌──────────────────────────────────────────────┐       │
│  │ tool:task                                    │       │
│  │                                              │       │
│  │  1. Resolve agent type → manifest            │       │
│  │  2. Check for live copilot (idle?)           │       │
│  │     ├── idle copilot → message() path        │       │
│  │     └── busy / none → spawn() path           │       │
│  │  3. Return extracted output to parent        │       │
│  └──────────────────────────────────────────────┘       │
│                    │                                    │
│         ┌─────────┴─────────┐                           │
│         ▼                   ▼                           │
│  ┌─────────────┐   ┌──────────────┐                    │
│  │ message()   │   │  spawn()     │                    │
│  │ live copilot│   │  new worker  │                    │
│  └─────────────┘   └──────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

**Three key capabilities:**

1. **Dynamic AgentResolver** — Agents discovered at runtime from registries,
   catalogs, or file systems instead of a hardcoded map.
2. **Copilot routing** — Idle long-lived copilots receive messages directly;
   busy copilots fall through to fresh worker spawns.
3. **TTL-cached descriptors** — The LLM-facing tool descriptor rebuilds
   every 30 seconds, reflecting newly registered agent types without restarts.

## Quick Start

```typescript
import { createTaskSpawnProvider } from "@koi/task-spawn";

const provider = createTaskSpawnProvider({
  agents: new Map([
    ["researcher", { name: "researcher", description: "Research agent", manifest }],
  ]),
  spawn: async (request) => {
    const result = await spawnChildAgent(request.manifest, request.description);
    return { ok: true, output: result };
  },
});

const runtime = await createKoi({ manifest, adapter, providers: [provider] });
```

## Architecture

```
packages/task-spawn/src/
├── types.ts                        Interfaces, branded types, descriptor factory
├── config.ts                       Validation: validateTaskSpawnConfig
├── task-tool.ts                    Tool factory: createTaskTool
├── output.ts                       Result → string extraction
├── provider.ts                     ComponentProvider factory
├── registry-agent-resolver.ts      AgentResolver backed by AgentRegistry + catalog
├── mailbox-message-fn.ts           MessageFn backed by MailboxComponent IPC
├── index.ts                        Public re-exports
├── task-tool.test.ts               Unit tests (colocated)
├── config.test.ts                  Validation tests (colocated)
├── output.test.ts                  Output tests (colocated)
├── types.test.ts                   Type tests (colocated)
├── provider.test.ts                Provider tests (colocated)
├── registry-agent-resolver.test.ts Resolver tests (colocated)
├── mailbox-message-fn.test.ts      MessageFn tests (colocated)
└── __tests__/
    ├── e2e-copilot.test.ts   E2E: copilot routing through L1
    ├── e2e-pi.test.ts        E2E: pi adapter integration
    └── e2e-helpers.ts        Shared E2E utilities
```

**Layer compliance:**

```
@koi/task-spawn (L2)
  ├── @koi/core (L0)        ← types & contracts
  └── @koi/delegation (L0u) ← sendAndWait for mailbox IPC
```

## How It Works

### Agent Resolution

Two paths to discover agents:

| Method | When to use | Interface |
|--------|-------------|-----------|
| Static `agents` map | Known agent types at boot | `ReadonlyMap<string, TaskableAgent>` |
| `AgentResolver` | Dynamic catalogs, registries | `resolve()` + `list()` + optional `findLive()` |

The resolver's `list()` populates the `agent_type` enum in the tool descriptor,
so the LLM sees available agents as constrained choices.

### Copilot vs Worker Routing

When `config.message` and `resolver.findLive` are both provided:

```
execute({ description, agent_type })
  │
  ├─ findLive(agent_type) → LiveAgentHandle?
  │    ├─ handle.state === "idle"  → message(handle.agentId, description)
  │    ├─ handle.state === "busy"  → fall through to spawn
  │    └─ undefined                → fall through to spawn
  │
  └─ spawn({ manifest, description, signal })
```

This enables long-lived copilots to accumulate context across interactions while
busy copilots don't block — the parent gets a fresh worker instead.

### TTL-Cached Descriptors

The tool descriptor (including agent_type enum) is cached and refreshed every
`DEFAULT_DESCRIPTOR_TTL_MS` (30 seconds). This means:

- New agent types registered in a catalog appear within 30 seconds
- No per-call overhead from `resolver.list()`
- The `get descriptor()` getter always returns the cached version

## Configuration

```typescript
interface TaskSpawnConfig {
  readonly agents?: ReadonlyMap<string, TaskableAgent>;
  readonly agentResolver?: AgentResolver;
  readonly spawn: SpawnFn;
  readonly defaultAgent?: string;
  readonly maxDurationMs?: number;     // default: 300_000 (5 min)
  readonly message?: MessageFn;
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `agents` | One of `agents` / `agentResolver` | Static map of agent types |
| `agentResolver` | One of `agents` / `agentResolver` | Dynamic resolver with `resolve()` + `list()` |
| `spawn` | Yes | Callback to create a new worker agent |
| `message` | No | Callback to message a live copilot agent |
| `defaultAgent` | No | Fallback agent_type when LLM omits it |
| `maxDurationMs` | No | Timeout per task (default 5 min) |

Validation via `validateTaskSpawnConfig()` returns `Result<TaskSpawnConfig, KoiError>`.

## API Reference

### Factories

| Function | Returns | Purpose |
|----------|---------|---------|
| `createTaskSpawnProvider(config)` | `ComponentProvider` | Attaches `tool:task` to an agent |
| `createTaskTool(config)` | `Promise<Tool>` | Creates the task tool directly |
| `createTaskToolDescriptor(summaries)` | `ToolDescriptor` | Builds descriptor with agent_type enum |
| `createMapAgentResolver(agents)` | `AgentResolver` | Wraps a static map as a resolver |
| `createRegistryAgentResolver(catalog, registry)` | `AgentResolver` | Wraps catalog + live AgentRegistry with `findLive()` |
| `createMailboxMessageFn(config)` | `MessageFn` | Creates MessageFn backed by MailboxComponent IPC |
| `validateTaskSpawnConfig(config)` | `Result<TaskSpawnConfig, KoiError>` | Validates unknown input |

### Types

| Type | Purpose |
|------|---------|
| `TaskableAgent` | Agent with name, description, manifest |
| `TaskableAgentSummary` | Lightweight summary for enum generation |
| `LiveAgentHandle` | Agent ID + state (`"idle"` / `"busy"`) |
| `AgentResolver` | Dynamic lookup: `resolve()`, `list()`, optional `findLive()` |
| `TaskSpawnRequest` | Input to `spawn()`: description, manifest, signal |
| `TaskSpawnResult` | `{ ok: true, output }` or `{ ok: false, error }` |
| `SpawnFn` | `(request) => Promise<TaskSpawnResult>` |
| `TaskMessageRequest` | Input to `message()`: agentId, description, signal |
| `MessageFn` | `(request) => Promise<TaskSpawnResult>` |
| `TaskSpawnConfig` | Full configuration object |

### Type Guards

| Function | Purpose |
|----------|---------|
| `isTaskSpawnSuccess(result)` | Narrows to `{ ok: true, output }` |
| `isTaskSpawnFailure(result)` | Narrows to `{ ok: false, error }` |

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MAX_DURATION_MS` | `300_000` | 5-minute task timeout |
| `DEFAULT_DESCRIPTOR_TTL_MS` | `30_000` | 30-second descriptor cache TTL |
| `TASK_TOOL_DESCRIPTOR` | `ToolDescriptor` | Base descriptor (no agent enum) |

## Examples

### Static Agent Map

```typescript
const config: TaskSpawnConfig = {
  agents: new Map([
    ["researcher", { name: "researcher", description: "Web research", manifest: researcherManifest }],
    ["coder", { name: "coder", description: "Code generation", manifest: coderManifest }],
  ]),
  spawn: mySpawnFn,
  defaultAgent: "researcher",
};
```

### Dynamic AgentResolver

```typescript
const resolver: AgentResolver = {
  async resolve(agentType) {
    return await catalog.findAgent(agentType);
  },
  async list() {
    return await catalog.listAgents();
  },
};

const config: TaskSpawnConfig = { agentResolver: resolver, spawn: mySpawnFn };
```

### Copilot Routing with Live Registry (recommended)

Use the built-in factory functions that wire `AgentRegistry` and `MailboxComponent`:

```typescript
import { createRegistryAgentResolver, createMailboxMessageFn } from "@koi/task-spawn";

// Wraps a static catalog with live agent discovery from the registry
const resolver = createRegistryAgentResolver(agentCatalog, agentRegistry);

// Creates a MessageFn backed by mailbox IPC (send → wait for response)
const messageFn = createMailboxMessageFn({
  mailbox,
  senderId: parentAgentId,
  timeoutMs: 30_000,
});

const config: TaskSpawnConfig = {
  agentResolver: resolver,
  spawn: mySpawnFn,
  message: messageFn,
};
```

The resolver's `findLive()` queries the registry for:
- **Idle agents**: `phase: "waiting"` + `condition: "Ready"` → routes via `message()`
- **Busy agents**: `phase: "running"` → falls through to `spawn()`
- **No match**: `suspended` / `terminated` / none → falls through to `spawn()`

### Copilot Routing with Custom State Check

```typescript
const resolver: AgentResolver = {
  resolve: (type) => registry.getAgent(type),
  list: () => registry.listAgents(),
  findLive: (type) => {
    const live = registry.findRunning(type);
    if (live === undefined) return undefined;
    return { agentId: live.id, state: live.isProcessing ? "busy" : "idle" };
  },
};

const config: TaskSpawnConfig = {
  agentResolver: resolver,
  spawn: mySpawnFn,
  message: async (req) => {
    const result = await sendToAgent(req.agentId, req.description, req.signal);
    return { ok: true, output: result };
  },
};
```

## Testing

```bash
# Unit tests (74 pass)
bun test --cwd packages/task-spawn

# E2E tests (requires ANTHROPIC_API_KEY)
E2E_TESTS=1 bun test packages/task-spawn/src/__tests__/e2e-copilot.test.ts
E2E_TESTS=1 bun test packages/task-spawn/src/__tests__/e2e-pi.test.ts
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| task-tool.test.ts | 18 | Task tool factory, copilot routing, TTL refresh, timeout |
| config.test.ts | 28 | Config validation (happy path, edge cases, error messages) |
| output.test.ts | 4 | Output extraction (success, failure, empty) |
| types.test.ts | 16 | Descriptor factory, type guards, map resolver |
| provider.test.ts | 4 | ComponentProvider integration |
| registry-agent-resolver.test.ts | 8 | Registry-backed resolver: resolve, list, findLive states |
| mailbox-message-fn.test.ts | 5 | Mailbox MessageFn: happy path, timeout, abort, send fail |
| e2e-copilot.test.ts | 3 (gated) | Full L1 copilot routing round-trip |
| e2e-pi.test.ts | 3 (gated) | Pi adapter integration |

Overall source coverage: **98.7%** (100% function coverage).

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Spawn callback injected, not imported | Keeps L2 free of L1 engine imports |
| `AgentResolver` over static map | Enables registry/catalog-backed discovery without code changes |
| `LiveAgentHandle` with state field | Busy copilots fall through to spawn instead of blocking |
| 30s descriptor TTL | Balances freshness with per-call overhead (no list() on every execute) |
| `Result<T, E>` for validation | Expected failures return typed errors, never throw |
| `extractOutput()` as separate module | Single responsibility; easy to extend output formatting |

## Layer Compliance

```
@koi/task-spawn (L2)
  ├── @koi/core              (L0)  ✓
  ├── @koi/core/assembly     (L0)  ✓
  ├── @koi/core/ecs          (L0)  ✓
  ├── @koi/core/common       (L0)  ✓
  ├── @koi/core/errors       (L0)  ✓
  └── @koi/delegation        (L0u) ✓  ← sendAndWait for mailbox IPC

  ✗ @koi/engine   — not imported (correct)
  ✗ @koi/node     — not imported (correct)
  ✗ peer L2       — not imported (correct)
```

Verify:
```bash
grep -r "from.*@koi/engine" packages/task-spawn/src/*.ts   # expect: no matches
grep -r "from.*@koi/node" packages/task-spawn/src/*.ts     # expect: no matches
```
