# @koi/handoff — Structured Context Relay Between Agents

Typed baton-pass protocol for multi-agent pipelines. When Agent A finishes phase 1 and needs to hand off to Agent B for phase 2, this package provides a `HandoffEnvelope` that packages results, artifacts, decisions, and warnings into a typed contract — then auto-injects a summary into the receiving agent's first model call via middleware.

---

## Why It Exists

Without structured handoff, agents communicate via chat messages. The receiving agent has no typed context — it must parse free text to understand what was done, what to do next, and what to watch out for.

```
  BEFORE                              AFTER
  ──────                              ─────

  Agent A ── "I'm done" ──▶ Agent B   Agent A ── HandoffEnvelope ──▶ Agent B
                                                  │
  ❌ No structured results             ✅ Typed results (JsonObject)
  ❌ No artifact references            ✅ URI-based artifact refs
  ❌ No decision trail                 ✅ DecisionRecord[] with reasoning
  ❌ No warnings propagated            ✅ Warnings accumulate through pipeline
  ❌ Agent B starts from scratch       ✅ Middleware auto-injects context
```

Benefits:

- **Zero-effort context injection** — middleware prepends a summary to the LLM's first turn; no prompt engineering needed
- **Full details on demand** — `accept_handoff` tool returns complete results, artifacts, decisions, and warnings
- **Pipeline-ready** — warnings and artifacts accumulate through A → B → C chains
- **Observable** — `HandoffEvent` union enables telemetry, UI, and orchestrator integration
- **Backend-swappable** — in-memory, SQLite, and Nexus backends shipped

---

## Architecture

`@koi/handoff` is an **L2 feature package** — it depends on `@koi/core` (L0) and L0u utilities (`@koi/sqlite-utils`, `@koi/nexus-client`). No L1 or peer L2 imports.

```
┌──────────────────────────────────────────────────────────┐
│  @koi/handoff  (L2)                                      │
│                                                          │
│  types.ts          ← Config types, tool descriptors      │
│  store.ts          ← HandoffStore interface + in-memory   │
│  sqlite-store.ts   ← SQLite backend (bun:sqlite)         │
│  nexus-store.ts    ← Nexus backend (JSON-RPC)            │
│  errors.ts         ← Shared error factories              │
│  validate.ts       ← Input + artifact validation         │
│  summary.ts        ← Generate prompt summary (~300 tok)  │
│  prepare-tool.ts   ← prepare_handoff tool factory        │
│  accept-tool.ts    ← accept_handoff tool factory         │
│  middleware.ts     ← HandoffMiddleware (context inject)   │
│  provider.ts       ← ComponentProvider (attaches tools)  │
│  index.ts          ← public API surface                  │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Dependencies                                            │
│                                                          │
│  @koi/core          (L0)  HandoffEnvelope, AgentId, etc. │
│  @koi/sqlite-utils  (L0u) openDb, mapSqliteError         │
│  @koi/nexus-client  (L0u) createNexusClient              │
│  crypto             (rt)  randomUUID for HandoffId        │
└──────────────────────────────────────────────────────────┘
```

---

## The Handoff Envelope

Every handoff is packaged into a `HandoffEnvelope` — the core data type defined in `@koi/core`:

```typescript
interface HandoffEnvelope {
  readonly id: HandoffId               // Branded string — unique per handoff
  readonly from: AgentId               // Sender agent
  readonly to: AgentId                 // Receiver agent
  readonly status: HandoffStatus       // "pending" | "injected" | "accepted" | "expired"
  readonly createdAt: number           // Unix timestamp (ms)
  readonly phase: {
    readonly completed: string         // What was done
    readonly next: string              // What to do next
  }
  readonly context: {
    readonly results: JsonObject       // Structured results (domain-specific)
    readonly artifacts: readonly ArtifactRef[]    // URI-based references
    readonly decisions: readonly DecisionRecord[] // Reasoning trail
    readonly warnings: readonly string[]          // Pitfalls to avoid
  }
  readonly delegation?: DelegationGrant // Optional capability delegation
  readonly metadata: JsonObject         // Extensible
}
```

### Status Lifecycle

```
  pending ──────▶ injected ──────▶ accepted
     │                                 │
     │            (middleware           │
     │             injects summary)    (agent calls
     │                                  accept_handoff)
     │
     └──────────▶ expired
                  (passive TTL, default 24h)
```

| Transition | Triggered by | What happens |
|-----------|-------------|-------------|
| `pending → injected` | Middleware `wrapModelCall` | Summary prepended to first model request |
| `injected → accepted` | `accept_handoff` tool | Full context returned to agent |
| `pending → expired` | Passive TTL (default 24h) | Envelope becomes unavailable on read |

All transitions are **CAS (compare-and-swap)** — the transition only succeeds if the current status matches the expected `from` status.

---

## Three Integration Points

```
  ┌─────────────────────────────────────────────────────┐
  │  createHandoffStore()   ← shared between agents      │
  │         │                                            │
  │         ├── createHandoffProvider()   → registers     │
  │         │     tool:prepare_handoff                   │
  │         │     tool:accept_handoff                    │
  │         │                                            │
  │         └── createHandoffMiddleware() → intercepts    │
  │               wrapModelCall (1st turn: inject summary)│
  │               onBeforeTurn  (every turn: set metadata)│
  │               describeCapabilities (advertise handoff)│
  └─────────────────────────────────────────────────────┘
```

### Store — Shared State

The `HandoffStore` is the shared envelope registry. Both the sending and receiving agents reference the same store instance.

All methods return `Result<T, KoiError>` or `T | Promise<T>` per Koi async convention:

```typescript
interface HandoffStore {
  put(envelope): Result<void, KoiError> | Promise<Result<void, KoiError>>
  get(id): Result<HandoffEnvelope, KoiError> | Promise<Result<HandoffEnvelope, KoiError>>
  transition(id, from, to): Result<HandoffEnvelope, KoiError> | Promise<...>
  listByAgent(agentId): Result<readonly HandoffEnvelope[], KoiError> | Promise<...>
  findPendingForAgent(agentId): Result<HandoffEnvelope | undefined, KoiError> | Promise<...>
  remove(id): Result<boolean, KoiError> | Promise<...>
  removeByAgent(agentId): Result<void, KoiError> | Promise<...>
  bindRegistry(registry: AgentRegistry): void
  dispose(): void | Promise<void>
}
```

Three backends are available:

| Factory | Backend | Best for |
|---------|---------|----------|
| `createInMemoryHandoffStore()` | In-memory `Map` | Tests, same-process agents |
| `createSqliteHandoffStore({ dbPath })` | bun:sqlite WAL | Local dev, CLI, single-node |
| `createNexusHandoffStore({ baseUrl, apiKey })` | Nexus JSON-RPC | Multi-node, shared state |

### Provider — Tool Registration

`createHandoffProvider` is a `ComponentProvider` that registers both tools on the agent entity during assembly:

```
  Agent Entity
  ├── tool:prepare_handoff   ← sender packs an envelope
  └── tool:accept_handoff    ← receiver unpacks full context
```

### Middleware — Automatic Context Injection

`createHandoffMiddleware` returns a `KoiMiddleware` (priority 400) with three hooks:

| Hook | When | What |
|------|------|------|
| `onBeforeTurn` | Every turn | Sets `ctx.metadata.handoffId` and `ctx.metadata.handoffPhase` |
| `wrapModelCall` | First turn only | Prepends summary system message to model request |
| `describeCapabilities` | On query | Returns capability fragment advertising the handoff |

The middleware uses a **closure flag** for first-turn detection — after the first injection, subsequent model calls pass through unchanged.

---

## Tools

### `prepare_handoff`

Called by the **sending** agent to package work into an envelope.

```
  Input (JSON Schema):
  ┌────────────────────────────────────────────────────────┐
  │  to          string  (XOR)       Target agent ID       │
  │  capability  string  (XOR)       Resolve target by     │
  │                                  declared capability    │
  │  completed   string  (required)  What was done         │
  │  next        string  (required)  Instructions for next │
  │  results     object  (optional)  Structured results    │
  │  artifacts   array   (optional)  Artifact references   │
  │  decisions   array   (optional)  Decision records      │
  │  warnings    array   (optional)  Pitfalls to avoid     │
  └────────────────────────────────────────────────────────┘

  Output (direct handoff — using `to`):
  { handoffId: "hoff-abc123", status: "pending" }

  Output (capability-based — using `capability`):
  { handoffId: "hoff-abc123", status: "pending", resolvedTo: "deploy-agent" }
```

Targeting:
- **Direct** (`to`): provide the exact agent ID — no registry needed
- **Capability-based** (`capability`): queries `registry.list({ phase: "running", capability })` and picks the first match. Requires `registry` in `HandoffConfig`
- Exactly one of `to` or `capability` must be provided (XOR — enforced at runtime)

Validation:
- `completed`, `next` are required non-empty strings
- Exactly one of `to` or `capability` must be non-empty
- Artifact URIs are validated (unsupported schemes → warnings, not errors)
- `HandoffId` generated via `crypto.randomUUID()`

### `accept_handoff`

Called by the **receiving** agent to unpack the full envelope.

```
  Input:
  ┌────────────────────────────────────────────────────────┐
  │  handoff_id  string  (required)  The envelope ID       │
  └────────────────────────────────────────────────────────┘

  Output (success):
  {
    handoffId: "hoff-abc123",
    from: "agent-a",
    completed: "...",
    next: "...",
    results: { ... },
    artifacts: [ ... ],
    decisions: [ ... ],
    warnings: [ ... ]
  }
```

Error responses:

| Code | When | Retryable |
|------|------|-----------|
| `NOT_FOUND` | Envelope doesn't exist | No |
| `ALREADY_ACCEPTED` | Status is already `accepted` | No |
| `TARGET_MISMATCH` | `envelope.to` doesn't match current agent | No |
| `EXPIRED` | Envelope has expired | No |

---

## Context Injection

When middleware injects a summary, the receiving agent's LLM sees this prepended to its first model request:

```
## Handoff Context
You are continuing work from agent `agent-a`.

### Completed Phase
Analyzed 500 research papers on distributed systems

### Your Task
Write a survey paper covering the top 5 themes

### Warnings
- Source X has been retracted — do not cite
- Budget constraint: keep under 10 pages

### Available Context
- 3 artifacts available
- 2 decision records
- Use `accept_handoff` tool with id="hoff-abc123" to retrieve full results and artifacts.
```

This summary is ~200-400 tokens — enough for the LLM to understand its task without overloading context. Full details (results, artifacts, decisions) are available on demand via `accept_handoff`.

---

## Events

All state transitions emit typed `HandoffEvent` values via the `onEvent` callback:

```typescript
type HandoffEvent =
  | { kind: "handoff:prepared"; envelope: HandoffEnvelope }
  | { kind: "handoff:injected"; handoffId: HandoffId }
  | { kind: "handoff:accepted"; handoffId: HandoffId; warnings: readonly string[] }
  | { kind: "handoff:expired";  handoffId: HandoffId }
```

Event sequence for a typical A → B handoff:

```
  Agent A calls prepare_handoff     → handoff:prepared
  Agent B's middleware injects       → handoff:injected
  Agent B calls accept_handoff      → handoff:accepted
```

For a 3-agent pipeline (A → B → C):

```
  handoff:prepared   (A prepares for B)
  handoff:injected   (B's middleware injects)
  handoff:accepted   (B accepts)
  handoff:prepared   (B prepares for C)
  handoff:injected   (C's middleware injects)
  handoff:accepted   (C accepts)
```

---

## Error Handling

Tools return typed error objects — never throw on expected failures:

```
  ┌──────────────────────────┐     ┌──────────────────┐     ┌──────────┐
  │ Expected error           │     │ Error code       │     │ Retryable│
  ├──────────────────────────┤     ├──────────────────┤     ├──────────┤
  │ Missing completed/next   │ ──> │ (validation msg) │ ──> │ No       │
  │ Both to + capability     │ ──> │ (validation msg) │ ──> │ No       │
  │ Neither to nor capability│ ──> │ (validation msg) │ ──> │ No       │
  │ No registry configured   │ ──> │ (error msg)      │ ──> │ No       │
  │ No agent with capability │ ──> │ (error msg)      │ ──> │ Yes*     │
  │ Registry lookup failed   │ ──> │ (error msg)      │ ──> │ Yes      │
  │ Envelope not found       │ ──> │ NOT_FOUND        │ ──> │ No       │
  │ Already accepted         │ ──> │ ALREADY_ACCEPTED │ ──> │ No       │
  │ Wrong target agent       │ ──> │ TARGET_MISMATCH  │ ──> │ No       │
  │ Envelope expired         │ ──> │ EXPIRED          │ ──> │ No       │
  │ Bad artifact URI         │ ──> │ (warning only)   │ ──> │ N/A      │
  └──────────────────────────┘     └──────────────────┘     └──────────┘

  * "No agent with capability" is retryable if the target agent hasn't started yet.
```

Artifact validation produces **warnings, not errors** — an unsupported URI scheme doesn't block the handoff, it's surfaced in the warnings array.

---

## API Reference

### Factory Functions

#### `createInMemoryHandoffStore(config?)`

Returns `HandoffStore`. In-memory `Map`-based. Process-lifetime only. Accepts optional `HandoffStoreConfig` with `ttlMs`.

#### `createSqliteHandoffStore(config)`

Returns `HandoffStore & { close(): void }`. Persistent SQLite backend via `bun:sqlite`. Config requires `dbPath` (string), optional `ttlMs`.

#### `createNexusHandoffStore(config)`

Returns `HandoffStore`. Persistent Nexus backend via JSON-RPC 2.0. Config requires `baseUrl` and `apiKey`, optional `basePath` and `ttlMs`.

#### `createHandoffStore(config?)` (deprecated)

Alias for `createInMemoryHandoffStore()`. Will be removed in a future release.

#### `createHandoffProvider(config)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.store` | `HandoffStore` | Shared envelope store |
| `config.agentId` | `AgentId` | This agent's ID |
| `config.registry` | `AgentRegistry` | Optional — enables capability-based handoff resolution and auto-cleanup on termination |
| `config.onEvent` | `(e: HandoffEvent) => void` | Optional event listener |

Returns `ComponentProvider`. Registers `tool:prepare_handoff` and `tool:accept_handoff`.

#### `createHandoffMiddleware(config)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.store` | `HandoffStore` | Shared envelope store |
| `config.agentId` | `AgentId` | This agent's ID |
| `config.onEvent` | `(e: HandoffEvent) => void` | Optional event listener |

Returns `KoiMiddleware` (name: `koi:handoff`, priority: 400).

#### `createPrepareTool(config)` / `createAcceptTool(config)`

Lower-level factories — use `createHandoffProvider` unless you need manual tool registration.

#### `resolveTarget(registry, capability)`

Standalone function that queries the registry for a running agent with the given capability. Returns `Promise<ResolveTargetResult>` — a discriminated union of `{ ok: true, agentId }` or `{ ok: false, message }`. Used internally by `prepare_handoff` when `capability` is provided; exported for programmatic use.

### Types

| Type | Description |
|------|-------------|
| `HandoffStore` | Envelope registry with CAS transitions and agent-scoped queries |
| `HandoffConfig` | Config for `createHandoffProvider` |
| `HandoffMiddlewareConfig` | Config for `createHandoffMiddleware` |
| `PREPARE_HANDOFF_DESCRIPTOR` | JSON Schema tool descriptor for `prepare_handoff` |
| `ACCEPT_HANDOFF_DESCRIPTOR` | JSON Schema tool descriptor for `accept_handoff` |

L0 types (from `@koi/core`):

| Type | Description |
|------|-------------|
| `HandoffId` | Branded `string` — unique envelope identifier |
| `HandoffEnvelope` | The typed baton — status, phase, context, artifacts, decisions, warnings |
| `HandoffStatus` | `"pending" \| "injected" \| "accepted" \| "expired"` |
| `HandoffEvent` | Discriminated union of lifecycle events |
| `DecisionRecord` | Agent reasoning trace (agentId, action, reasoning, timestamp) |
| `ArtifactRef` | URI-based artifact reference (id, kind, uri, mimeType) |
| `HandoffAcceptResult` | Discriminated union: success with warnings, or typed error |
| `HandoffAcceptError` | `NOT_FOUND \| ALREADY_ACCEPTED \| TARGET_MISMATCH \| EXPIRED` |
| `HandoffComponent` | ECS component interface for the handoff subsystem |

---

## Examples

### 1. Basic Two-Agent Handoff

```typescript
import { agentId } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
  createHandoffStore,
  createHandoffProvider,
  createHandoffMiddleware,
} from "@koi/handoff";

// Shared store — the link between agents
const store = createHandoffStore();

// Agent A: can prepare handoffs (sender)
const runtimeA = await createKoi({
  manifest: { name: "researcher", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 10 }),
  providers: [
    createHandoffProvider({ store, agentId: agentId("researcher") }),
  ],
});

// Agent B: receives handoffs via middleware + accepts via tool
const runtimeB = await createKoi({
  manifest: { name: "writer", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 10 }),
  providers: [
    createHandoffProvider({ store, agentId: agentId("writer") }),
  ],
  middleware: [
    createHandoffMiddleware({ store, agentId: agentId("writer") }),
  ],
});

// Run Agent A — LLM calls prepare_handoff
await collectEvents(runtimeA.run({ kind: "text", text: "Analyze the data and hand off to writer" }));

// Run Agent B — middleware auto-injects context, LLM calls accept_handoff
await collectEvents(runtimeB.run({ kind: "text", text: "Continue the work from the handoff" }));
```

### 2. With Event Listening

```typescript
import type { HandoffEvent } from "@koi/core";

function onHandoffEvent(event: HandoffEvent): void {
  switch (event.kind) {
    case "handoff:prepared":
      console.log(`📦 ${event.envelope.from} → ${event.envelope.to}`);
      break;
    case "handoff:injected":
      console.log(`💉 Context injected for ${event.handoffId}`);
      break;
    case "handoff:accepted":
      console.log(`✅ Accepted ${event.handoffId} (${event.warnings.length} warnings)`);
      break;
  }
}

const store = createHandoffStore();

createHandoffProvider({ store, agentId: id, onEvent: onHandoffEvent });
createHandoffMiddleware({ store, agentId: id, onEvent: onHandoffEvent });
```

### 3. Three-Agent Pipeline

```typescript
const store = createHandoffStore();
const onEvent = (e: HandoffEvent) => console.log(e.kind);

// Agent A: Researcher → prepares for Architect
const runtimeA = await createKoi({
  manifest: { name: "researcher", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 5 }),
  providers: [createHandoffProvider({ store, agentId: agentId("researcher"), onEvent })],
});

// Agent B: Architect → accepts from A, prepares for Builder
const runtimeB = await createKoi({
  manifest: { name: "architect", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 5 }),
  providers: [createHandoffProvider({ store, agentId: agentId("architect"), onEvent })],
  middleware: [createHandoffMiddleware({ store, agentId: agentId("architect"), onEvent })],
});

// Agent C: Builder → accepts from B
const runtimeC = await createKoi({
  manifest: { name: "builder", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 5 }),
  providers: [createHandoffProvider({ store, agentId: agentId("builder"), onEvent })],
  middleware: [createHandoffMiddleware({ store, agentId: agentId("builder"), onEvent })],
});

// Run pipeline sequentially
await collectEvents(runtimeA.run({ kind: "text", text: "Research and hand off to architect" }));
await collectEvents(runtimeB.run({ kind: "text", text: "Design and hand off to builder" }));
await collectEvents(runtimeC.run({ kind: "text", text: "Build based on the architecture" }));

// Events emitted: prepared → injected → accepted → prepared → injected → accepted
// Warnings accumulate: A's warnings flow through B into C
```

### 4. Capability-Based Handoff

Instead of hardcoding `to: "deploy-agent"`, let the tool resolve the target at runtime by capability:

```typescript
// Agent A doesn't know which agent handles deployment — it just knows the capability
// The LLM calls: prepare_handoff({ capability: "deployment", completed: "...", next: "..." })

const store = createHandoffStore();
const registry = myAgentRegistry; // must contain running agents with capabilities

const runtimeA = await createKoi({
  manifest: { name: "builder", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createLoopAdapter({ modelCall, maxTurns: 5 }),
  providers: [
    createHandoffProvider({ store, agentId: agentId("builder"), registry }),
  ],
});

// Target agent must declare capabilities in its manifest:
// manifest: { name: "deployer", capabilities: ["deployment", "rollback"], ... }

// When builder calls prepare_handoff({ capability: "deployment", ... }):
//   1. Tool queries registry.list({ phase: "running", capability: "deployment" })
//   2. First matching agent (e.g. "deployer") is selected
//   3. Response includes resolvedTo: "deployer" so the LLM knows who received it
```

The `resolveTarget` function is also exported for programmatic use outside the tool:

```typescript
import { resolveTarget } from "@koi/handoff";

const result = await resolveTarget(registry, "code-review");
if (result.ok) {
  console.log(`Found reviewer: ${result.agentId}`);
}
```

### 5. With Registry Cleanup (Production)

```typescript
createHandoffProvider({
  store,
  agentId: id,
  registry: myAgentRegistry, // watches for agent termination
  onEvent,
});

// When an agent terminates, all its envelopes are automatically removed
// from the store via registry.watch() → removeByAgent()
```

---

## Store Backends

```
                  ┌─────────────────┐
                  │  Which store?   │
                  └────────┬────────┘
                           │
               ┌───────────┼───────────┐
               ▼           ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ InMemory │ │  SQLite  │ │  Nexus   │
        │          │ │          │ │          │
        │ Tests &  │ │ Local    │ │ Remote   │
        │ same     │ │ dev &    │ │ prod &   │
        │ process  │ │ single   │ │ multi    │
        │          │ │ node     │ │ node     │
        └──────────┘ └──────────┘ └──────────┘
```

| Concern | InMemory | SQLite | Nexus |
|---------|----------|--------|-------|
| Persistence | None (process lifetime) | Disk file | Remote server |
| Setup | Zero config | `dbPath` | `baseUrl` + `apiKey` |
| Concurrency | Single process | WAL mode | Multi-node via HTTP |
| TTL | Passive (check-on-read) | Passive + startup cleanup | Passive (check-on-read) |
| CAS transitions | In-memory compare-and-swap | SQL `WHERE status = ?` | Read-compare-write |
| Best for | Tests, same-process agents | Local dev, CLI, single-node | Multi-node, shared state |

### SQLite Backend

```typescript
import { createSqliteHandoffStore } from "@koi/handoff";

const store = createSqliteHandoffStore({
  dbPath: "./handoffs.db",  // or ":memory:" for tests
  ttlMs: 86_400_000,        // optional, default 24h
});

// Close when done
store.close();
```

Features: WAL mode, prepared statements, 3 targeted indexes, startup TTL cleanup, atomic CAS via `UPDATE ... WHERE status = ?`.

### Nexus Backend

```typescript
import { createNexusHandoffStore } from "@koi/handoff";

const store = createNexusHandoffStore({
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY,
  basePath: "/handoffs",     // optional, default "/handoffs"
  ttlMs: 86_400_000,         // optional, default 24h
});
```

Features: JSON-RPC 2.0 transport, glob + parallel reads for queries, injectable `fetch` for testing.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    HandoffEnvelope, HandoffEvent, AgentId, Tool, etc.   │
                                                         │
L0u @koi/sqlite-utils ──────────────────────────────────┤
    openDb, mapSqliteError, wrapSqlite                   │
                                                         │
L0u @koi/nexus-client ──────────────────────────────────┤
    createNexusClient                                    │
                                                         │
L2  @koi/handoff ◄───────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ crypto.randomUUID() is a runtime built-in
```

- [x] `@koi/core/handoff.ts` has zero imports from other `@koi/*` packages
- [x] `@koi/core/handoff.ts` has no function bodies (except branded `handoffId()` cast)
- [x] No vendor types (LangGraph, OpenAI, etc.) in any file
- [x] Runtime source imports from `@koi/core` (L0) and L0u utilities only — `@koi/engine` and `@koi/engine-loop` are devDependencies (E2E tests)
- [x] All interface properties are `readonly`
- [x] All array parameters are `readonly T[]`
- [x] All store methods return `Result<T, KoiError>` or `T | Promise<T>`
