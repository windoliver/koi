# Koi: Self-Extending Agent Engine

## What Koi Is

A **self-extending agent runtime** — agents that can create, discover, and compose their own tools, skills, and sub-agents at runtime. Built on a **pure ECS architecture** (Agent = entity, Tool = component, Middleware = system) with swappable engine adapters and multi-channel delivery.

**What Koi is NOT**: An agent framework competing with LangGraph, Swarm, CrewAI, or AutoGen. Multi-agent orchestration is a framework concern — Koi consumes these, it does not re-implement them.

---

## Core Vocabulary

| Concept | What it is |
|---------|-----------|
| **Agent** | ECS entity assembled from manifest — can also forge new agents |
| **Brick** | Universal building block: tool, skill, middleware, channel, or agent |
| **Channel** | Where the agent talks (Telegram, Slack, Discord, Web, Voice, CLI...) |
| **Tool** | MCP tool or native function the agent can call — can be forged at runtime |
| **Skill** | Markdown-defined capability (prompt + tool set) — can be forged at runtime |
| **Middleware** | Cross-cutting hook (audit, memory, pay, permissions, forge governance) |
| **Manifest** | `koi.yaml` — the declarative agent definition |
| **Forge** | Runtime brick creation, verification, discovery — agents grow their own capabilities |
| **Gateway** | WebSocket control plane — session dispatch, routing, webhooks |
| **Node** | Local device agent runtime — runs N agent entities |
| **Proposal** | Agent-submitted change request for any layer — trust gate scales with blast radius |
| **Snapshot** | Immutable point-in-time capture of an agent's full state — enables time travel and rollback |
| **BrickStore** | Universal storage for all code (forged, bundled, extensions) — agent reads everything, writes to forge store |

## Architecture Components

| Component | Technology | Role |
|-----------|------------|------|
| **Engine Runtime** | @koi/engine | Guards, validation, middleware composition, adapter dispatch |
| **Engine Adapter** | Swappable | The actual agent loop (`stream()` is the only required method) |
| **Agent Body** | Gateway + Node | Multi-channel, local devices, sessions |
| **Self-Extension** | @koi/forge | Runtime brick creation, verification, discovery |
| **Infrastructure** | Pluggable backends | Memory, search, permissions, payments, artifact storage |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       CLIENTS / FRONTENDS                        │
│  Web(AG-UI) Telegram Slack Discord WhatsApp Voice CLI IDE       │
└────────────────────────────┬────────────────────────────────────┘
                             │
═══════════════════════════════════════════════════════════════════
  WORLD SERVICES (shared infrastructure, not on any agent entity)
═══════════════════════════════════════════════════════════════════
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Gateway — WebSocket Control Plane                         │   │
│  │ Session dispatch │ Scheduler/Cron │ Webhooks │ Relay      │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                              │                                   │
│  ┌──────────────┐ ┌─────────┴──────┐ ┌──────────────────────┐  │
│  │ ModelRouter   │ │ ArtifactClient │ │ Sandbox Profiles     │  │
│  │ Multi-LLM,   │ │ Primary store  │ │ Seatbelt / bwrap     │  │
│  │ key rotation  │ │ + LRU fallback │ │                      │  │
│  └──────────────┘ └────────────────┘ └──────────────────────┘  │
│                                                                 │
═══════════════════════════════════════════════════════════════════
                             │  Dispatches to Agent Hosts
                ┌────────────┼────────────┐
                ▼            ▼            ▼
┌───────────────────────────────────────────────────────────────┐
│                    NODE (Agent Host)                           │
│  Runs N Agent entities, each with own middleware chain         │
│                                                               │
│  ┌─────────────────────── AGENT (ECS Entity) ──────────────┐  │
│  │  pid: { id, name, type, depth, parent }                  │  │
│  │  state: created → running → waiting → suspended → term.  │  │
│  │                                                          │  │
│  │  COMPONENTS (data — the agent HAS these):                │  │
│  │  ┌────────────┐ ┌────────────┐ ┌─────────────────────┐  │  │
│  │  │tool:search │ │tool:forge  │ │tool:forged_calc     │  │  │
│  │  └────────────┘ └────────────┘ └─────────────────────┘  │  │
│  │  ┌────────────┐ ┌────────────┐ ┌─────────────────────┐  │  │
│  │  │ MEMORY     │ │ GOVERNANCE │ │ CREDENTIALS         │  │  │
│  │  └────────────┘ └────────────┘ └─────────────────────┘  │  │
│  │  ┌────────────┐ ┌─────────────────┐ ┌────────────────┐  │  │
│  │  │ EVENTS     │ │ skill:research  │ │ channel:tg     │  │  │
│  │  └────────────┘ └─────────────────┘ └────────────────┘  │  │
│  │                                                          │  │
│  │  SYSTEMS (middleware — logic over components):            │  │
│  │  SpawnGov → Perms → Pay → Audit → Context → Exec        │  │
│  │                                                          │  │
│  │  ENGINE ADAPTER (swappable agent loop):                   │  │
│  │  stream(input) → tools from query("tool:") → LLM → loop │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌──────── FORGE (runs inside forge_tool component) ────────┐  │
│  │ forge_tool → 4-stage verify → attach(token, tool)        │  │
│  │ Trust: sandbox → verified → promoted                     │  │
│  │ Scope: agent → zone → global (HITL for promotion)        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                               │
│  Agent₂ { pid, components, state }  (isolated)                │
│  Agent₃ { pid, components, state }  (child of Agent₁)        │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│        INFRASTRUCTURE BACKENDS (pluggable)                     │
│                                                               │
│  Options: Nexus, SQLite (edge), In-memory (test), Custom     │
│                                                               │
│  Agent lifecycle is NOT here — it's in L1 engine runtime.     │
│  Backends observe via EVENTS component, don't own lifecycle.  │
└───────────────────────────────────────────────────────────────┘
```

**Layer mapping:**

```
Diagram Section              Layer    What It Is
───────────────              ─────    ──────────
Agent.pid, ProcessState      L0      Interfaces (types only, zero logic)
Agent, SubsystemToken<T>     L0      ECS composition primitives
KoiMiddleware                L0      Middleware contract
ChannelAdapter, Resolver     L0      Channel + Discovery contracts
EngineAdapter                L0      Engine contract

Engine runtime (guards)      L1      createKoi(), IterationGuard, SpawnGuard
Middleware chain composition L1      Wraps adapter in onion
ProcessState transitions     L1      Lifecycle state machine

Gateway, Node                L2      World Services
ModelRouter, ArtifactClient  L2      World Services
Sandbox profiles             L2      World Services
KoiMiddleware impls          L2      Memory, Pay, Perms, Audit
ChannelAdapter impls         L2      Telegram, Slack, Discord, etc.

Infrastructure backends      L3      Pluggable (Nexus, SQLite, custom)
```

---

## The Four-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: META-PACKAGES (convenience bundles)                │
│  @koi/starter = core + engine + 1 channel + memory           │
│  @koi/full    = everything                                   │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: FEATURE PACKAGES (opt-in, independent)             │
│                                                              │
│  COMPONENTS        SYSTEMS           WORLD SERVICES          │
│  (data on agent)   (middleware)       (shared infra)          │
│  channel-*         middleware/*       gateway                 │
│  skills            hooks             node                    │
│  forge (tools)     self-test         model-router            │
│  artifact-client                     mcp, sandbox            │
│                                                              │
│  ComponentProvider impls attach components during assembly.   │
│  Forge creates new components AT RUNTIME.                    │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: ENGINE (@koi/engine — kernel runtime)              │
│  createKoi() → assembly → ComponentProvider.attach()         │
│  IterationGuard, LoopDetector, SpawnGuard                    │
│  ProcessState transitions (lifecycle state machine)          │
│  Middleware chain composition → EngineAdapter dispatch        │
├─────────────────────────────────────────────────────────────┤
│  Layer 0: KERNEL (@koi/core — types only, 6 contracts)       │
│  Middleware, Message, Channel, Resolver, Assembly, Engine     │
│  + ECS: Agent, SubsystemToken<T>, ComponentProvider          │
│  + Components: Tool, Memory, Governance, Credentials, Events │
│  ZERO implementations                                        │
└─────────────────────────────────────────────────────────────┘
```

### Why 4 Layers?

| Property | Kernel (L0) | Engine (L1) | Features (L2) | Meta (L3) |
|----------|-------------|-------------|----------------|-----------|
| **Contains** | 6 contracts + ECS (types only) | Guards, validation, dispatch | Channels, middleware, providers | Dependency bundles |
| **Dependencies** | Zero | @koi/core only | @koi/core only | L0 + L1 + selected L2 |
| **Breakage scope** | All packages | Engine only | Own package only | None |
| **Can be swapped?** | Never | No (it IS the runtime) | Yes (per package) | Yes |
| **Analogy** | Kernel headers | Kernel runtime (`__schedule()`) | Kernel modules (ext4, tcp) | Distro packages |

Engine *adapters* (LangGraph, OpenAI, custom) are swappable L2 packages. The engine *runtime* (guards, governance) is not — it IS the kernel runtime.

---

## Kernel Interfaces (L0)

`@koi/core` defines 6 contracts. All `readonly`, all immutable.

### 1. Middleware Contract

```typescript
interface KoiMiddleware {
  readonly name: string;
  readonly priority?: number; // Lower = outer onion layer (runs first). Default: 500
  readonly onSessionStart?: (ctx: SessionContext) => Promise<void>;
  readonly onSessionEnd?: (ctx: SessionContext) => Promise<void>;
  readonly onBeforeTurn?: (ctx: TurnContext) => Promise<void>;
  readonly onAfterTurn?: (ctx: TurnContext) => Promise<void>;
  readonly wrapModelCall?: (ctx: TurnContext, request: ModelRequest, next: ModelHandler) => Promise<ModelResponse>;
  readonly wrapModelStream?: (ctx: TurnContext, request: ModelRequest, next: ModelStreamHandler) => AsyncIterable<ModelChunk>;
  readonly wrapToolCall?: (ctx: TurnContext, request: ToolRequest, next: ToolHandler) => Promise<ToolResponse>;
}

type ModelChunk =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "thinking_delta"; readonly delta: string }
  | { readonly kind: "tool_call_start"; readonly toolName: string; readonly callId: string }
  | { readonly kind: "tool_call_delta"; readonly callId: string; readonly delta: string }
  | { readonly kind: "tool_call_end"; readonly callId: string }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: "done"; readonly response: ModelResponse };

type ModelStreamHandler = (request: ModelRequest) => AsyncIterable<ModelChunk>;

// HITL approval — available via TurnContext.requestApproval
type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
type ApprovalDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "modify"; readonly updatedInput: JsonObject }
  | { readonly kind: "deny"; readonly reason: string };
```

### 2. Message Contract

```typescript
type ContentBlock = TextBlock | FileBlock | ImageBlock | ButtonBlock;
interface OutboundMessage { readonly blocks: readonly ContentBlock[]; }
interface InboundMessage { readonly text: string; readonly blocks?: readonly ContentBlock[]; }
```

### 3. Channel Contract

```typescript
interface ChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

### 4. Discovery Contract

```typescript
interface Resolver<Meta, Full> {
  readonly name: string;
  discover(): Promise<readonly Meta[]>;
  load(id: string): Promise<Full | undefined>;
  onChange?(listener: () => void): () => void;
}
```

### 5. Assembly Contract

```typescript
interface AgentManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly model: ModelConfig;
  readonly tools?: readonly ToolConfig[];
  readonly channels?: readonly ChannelConfig[];
  readonly middleware?: readonly MiddlewareConfig[];
  readonly permissions?: PermissionConfig;
  readonly delegation?: DelegationConfig;
  readonly metadata?: JsonObject;
}
```

### 6. Engine Contract

```typescript
interface EngineAdapter {
  readonly engineId: string;
  readonly terminals?: {
    readonly modelCall: ModelHandler;
    readonly modelStream?: ModelStreamHandler;
    readonly toolCall?: ToolHandler;
  };
  readonly stream: (input: EngineInput) => AsyncIterable<EngineEvent>;  // ONLY required method
  readonly saveState?: () => Promise<EngineState>;
  readonly loadState?: (state: EngineState) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}

// ComposedCallHandlers — middleware-wrapped terminals passed back via EngineInput
interface ComposedCallHandlers {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly modelStream?: (request: ModelRequest) => AsyncIterable<ModelChunk>;
  readonly toolCall: (request: ToolRequest) => Promise<ToolResponse>;
}

type EngineInput =
  | { readonly kind: "text"; readonly text: string; readonly callHandlers?: ComposedCallHandlers }
  | { readonly kind: "messages"; readonly messages: readonly InboundMessage[]; readonly callHandlers?: ComposedCallHandlers }
  | { readonly kind: "resume"; readonly state: EngineState; readonly callHandlers?: ComposedCallHandlers };

type EngineEvent =
  | { readonly kind: "text_delta"; readonly delta: string }
  | { readonly kind: "tool_call_start"; readonly toolName: string; readonly callId: string; readonly args: JsonObject }
  | { readonly kind: "tool_call_end"; readonly callId: string; readonly result: unknown }
  | { readonly kind: "turn_end"; readonly turnIndex: number }
  | { readonly kind: "done"; readonly output: EngineOutput }
  | { readonly kind: "custom"; readonly type: string; readonly data: unknown };
```

### ECS Compositional Layer

```typescript
type SubsystemToken<T> = string & { readonly __brand: T };

interface ProcessId {
  readonly id: string;
  readonly name: string;
  readonly type: "copilot" | "worker";
  readonly depth: number;
  readonly parent?: string;
  readonly ownerId?: string;  // human or org that owns this agent
}

interface Agent {
  readonly pid: ProcessId;
  readonly manifest: AgentManifest;
  readonly state: ProcessState;
  readonly component: <T>(token: SubsystemToken<T>) => T | undefined;
  readonly has: (token: SubsystemToken<unknown>) => boolean;
  readonly hasAll: (...tokens: readonly SubsystemToken<unknown>[]) => boolean;
  readonly query: <T>(prefix: string) => ReadonlyMap<SubsystemToken<T>, T>;
  readonly components: () => ReadonlyMap<string, unknown>;
}

interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly trustTier: TrustTier; // "sandbox" | "verified" | "promoted"
  readonly execute: (args: JsonObject) => Promise<unknown>;
}

interface ComponentProvider {
  readonly name: string;
  readonly attach: (agent: Agent) => Promise<ReadonlyMap<string, unknown>>;
  readonly detach?: (agent: Agent) => Promise<void>;
}
```

### Singleton Components (one per agent)

```typescript
interface MemoryComponent {
  readonly recall: (query: string) => Promise<readonly unknown[]>;
  readonly store: (content: unknown) => Promise<void>;
}
interface GovernanceComponent {
  readonly usage: () => GovernanceUsage;
  readonly checkSpawn: (depth: number) => SpawnCheck;
}
interface CredentialComponent {
  readonly get: (key: string) => Promise<string | undefined>;
}
interface EventComponent {
  readonly emit: (type: string, data: unknown) => Promise<void>;
  readonly on: (type: string, handler: (data: unknown) => void) => () => void;
}
```

### Well-Known Tokens

```typescript
const MEMORY = token<MemoryComponent>("memory");
const GOVERNANCE = token<GovernanceComponent>("governance");
const CREDENTIALS = token<CredentialComponent>("credentials");
const EVENTS = token<EventComponent>("events");

function toolToken(name: string): SubsystemToken<Tool>;           // "tool:calculator"
function channelToken(name: string): SubsystemToken<ChannelAdapter>; // "channel:telegram"
function skillToken(name: string): SubsystemToken<Skill>;          // "skill:refund-policy"
```

**Namespace convention**: No colon = singleton (`"memory"`), with colon = namespaced (`"tool:calculator"`). `query("tool:")` returns all tool components.

### Brick Store & Snapshots

```typescript
interface BrickSource {
  readonly code: string;                     // the actual TypeScript source
  readonly interface: string;                // which L0 contract it implements
  readonly tests?: readonly TestCase[];      // verification suite
  readonly dependencies?: readonly string[]; // what it imports
}

interface BrickStore {
  readonly read: (ref: BrickRef) => Promise<BrickSource | undefined>;
  readonly write: (ref: BrickRef, source: string) => Promise<void>;
  readonly list: (scope: ForgeScope) => Promise<readonly BrickRef[]>;
  readonly snapshot: (agentId: string) => Promise<AgentSnapshot>;
  readonly restore: (agentId: string, version: number) => Promise<void>;
}

interface AgentSnapshot {
  readonly version: number;
  readonly parent?: number;                    // previous snapshot
  readonly timestamp: number;
  readonly event: SnapshotEvent;               // what caused this version
  readonly components: ReadonlyMap<string, BrickRef>; // content-addressed refs
  readonly config: unknown;                    // current agent config
  readonly engineState?: EngineState;          // opaque engine checkpoint
}

type SnapshotEvent =
  | { readonly kind: "manifest_loaded" }
  | { readonly kind: "brick_forged"; readonly brick: BrickRef }
  | { readonly kind: "brick_quarantined"; readonly brick: BrickRef }
  | { readonly kind: "component_attached"; readonly token: string }
  | { readonly kind: "component_detached"; readonly token: string }
  | { readonly kind: "config_changed"; readonly diff: unknown }
  | { readonly kind: "proposal_applied"; readonly proposal: string }
  | { readonly kind: "restored"; readonly fromVersion: number };
```

### Kernel Extension

```typescript
interface KernelExtension {
  readonly name: string;
  readonly kind: "guard" | "lifecycle_hook" | "composition_rule";
  readonly execute: (...args: readonly unknown[]) => unknown | Promise<unknown>;
}
```

L1 defines extension slots. L2 provides the implementations. Extensions load dynamically from disk — no binary rebuild needed.

### Resolver Source (Level 3)

```typescript
interface Resolver<Meta, Full> {
  readonly name: string;
  discover(): Promise<readonly Meta[]>;                     // Level 1: names
  load(id: string): Promise<Full | undefined>;              // Level 2: schemas
  source?(id: string): Promise<BrickSource | undefined>;    // Level 3: full source
  onChange?(listener: () => void): () => void;
}
```

Progressive disclosure: `discover()` → ~10 tokens, `load()` → ~100 tokens, `source()` → ~5000 tokens. Agent requests deeper levels as needed.

### Other Kernel Types

Additional types in `@koi/core`: `KoiConfig`, `ModelConfig`, `PermissionConfig`, `EngineOutput`, `EngineState`, `EngineMetrics`, `EngineStopReason`.

```typescript
type EngineStopReason = "completed" | "max_turns" | "interrupted" | "error";
```

Subsystem-specific config types live in their owning packages (e.g., `ExecutionLimitsConfig` in `@koi/engine`).

---

## Design Principles

### Foundation

| # | Principle | Application |
|---|-----------|-------------|
| 0 | **KISS** | Core vocabulary <= 10 concepts. Code over configuration. No framework reinvention |
| 1 | **Interface-first kernel** | `@koi/core` = types only. Zero implementations. The kernel defines the plugs, not the things that plug in |
| 2 | **Minimal-surface contracts** | Channel: `send()` + `onMessage()`. Middleware: 7 optional hooks + priority. Engine: `stream()` only required method |
| 3 | **Middleware = sole interposition layer** | ONE way to intercept model/tool calls. No separate `EngineHooks` |
| 4 | **Manifest-driven assembly** | `koi.yaml` IS the agent. Static for 80%, runtime assembly via Forge for 20% |

### Self-Extension

| # | Principle | Application |
|---|-----------|-------------|
| 5 | **Everything behind L0 is forgeable** | Any L0 interface is a forge target. Trust tier determines checks, not what's possible |
| 6 | **Freedom within isolation** | Full creative freedom inside sandbox. OS-level sandbox is the safety net (RimWorld model) |
| 7 | **Trust before storage** | Every forged brick passes 4-stage verification (static → sandbox → self-test → trust) |
| 8 | **Scope controls blast radius** | Bricks start at `agent` scope. Promotion to `zone`/`global` requires HITL |
| 9 | **Functional cache** | Forged tools ARE cached functionality. Capabilities compound across sessions |
| 10 | **Everything is updatable** | Agent can update any layer. Trust gate scales with blast radius. Forge store is universal staging ground |
| 11 | **Immutable snapshots** | Every change = new snapshot. Restore any version. Fork from any point. No mutation, ever |
| 12 | **Forge → Promote → Bundle** | Changes start as local experiments, proven ones graduate into the base. Binary improves over time |

### Discovery

| # | Principle | Application |
|---|-----------|-------------|
| 13 | **Progressive disclosure** | ~10 tokens (name) → ~100 tokens (metadata) → ~5000 tokens (full source + tests) |
| 14 | **First-wins resolver chain** | Agent-forged > Zone-forged > Global-forged > Bundled |
| 15 | **Skills as Markdown** | `SKILL.md` with YAML frontmatter — zero-code agent extension |

---

## Design Decisions

### Swappable Engine

**Decision**: The `EngineAdapter` interface enables swapping the agent execution model without rewriting middleware. Only the adapter package imports the underlying framework. All other packages depend on `@koi/core` interfaces.

| Adapter | Underlying Framework | Use Case |
|---|---|---|
| `@koi/engine-deepagents` | DeepAgents.js (on LangGraph) | Planning, context mgmt, sub-agents |
| `@koi/engine-langgraph` | Raw LangGraph.js | Custom graph workflows |
| `@koi/engine-loop` | None (pure TS) | Simple ReAct loop, lightweight agents |
| `@koi/engine-custom` | Bring your own | Any execution model |

```yaml
# koi.yaml — engine selection
engine: deepagents    # or "langgraph", "loop", "custom"
```

**Engine interposition (one layer, not two):**
```
User input → Middleware stack (wrapModelCall, wrapToolCall)
           → Engine runtime (guards, validation, adapter dispatch)
           → EngineAdapter.stream(input)  ← swappable
```

**Features by layer** — what survives an engine swap:

| Feature | Source | Shared across adapters? |
|---------|--------|:-:|
| Iteration/timeout guards | Engine runtime (L1) | Yes |
| Loop detection (FNV-1a) | Engine runtime (L1) | Yes |
| Spawn governance | Engine runtime (L1) | Yes |
| Memory, Pay, Permissions, Audit | Koi middleware (L2) | Yes |
| Forge, Context Hydrator | Koi middleware (L2) | Yes |
| Planning, context offloading | Engine adapter | No — adapter-specific |
| Sub-agent spawning | Engine adapter | No — adapter-specific |
| HITL (interrupt + resume) | Engine adapter | No — adapter-specific |

**Anti-leak rules**:
- Zero framework concepts in `EngineAdapter` (no graphs, channels, checkpointers)
- One interposition layer (`KoiMiddleware`), not two
- `stream()` is the only required method
- `custom` event type is observable-only (telemetry/UI), never required for correctness
- `EngineState.data` is `unknown` (truly opaque)

### YAML Manifest vs Code-First

**Decision**: YAML for 80% (simple agents), code API (`createKoi()`) for 20% (complex orchestration). Both produce the same agent.

```yaml
# koi.yaml — THIS IS YOUR AGENT
name: "Research Assistant"
model: "anthropic:claude-sonnet-4-5-20250929"
middleware:
  - "@koi/middleware-memory": { scope: agent }
  - "@koi/middleware-pay": { dailyBudget: 1000 }
channels:
  - "@koi/channel-telegram": { token: ${TELEGRAM_BOT_TOKEN} }
tools:
  mcp:
    - name: filesystem
      command: "npx @anthropic/mcp-server-filesystem /workspace"
permissions:
  allow: ["read_file:/workspace/**"]
  deny: ["bash:rm -rf *"]
  ask: ["bash:*"]
```

### Interfaces-Only Kernel

**Decision**: `@koi/core` = zero runtime code. The kernel is a protocol specification, not code. Core never breaks, never has bugs, never needs patches.

### Monorepo with Meta-Packages

**Decision**: Monorepo with meta-packages (`@koi/starter`) for monolith-like DX. Install only what you need.

---

## Agent Types

| Aspect | Copilot | Worker |
|--------|---------|--------|
| **Lifecycle** | Persistent (days/weeks) | Ephemeral (minutes/hours) |
| **Trust Level** | High (user's permissions) | Low (minimal permissions) |
| **API Key** | Long-lived | Short TTL |
| **Identity** | Full (ProcessId + crypto identity) | Minimal (ProcessId only, lazy provisioning) |
| **Memory** | Own persistent memory | Parent's memory or none |
| **Channels** | Human-facing (accepts commands, sends messages) | None (parent-controlled) |
| **Use Case** | Personal assistant, user-facing | Task execution, background jobs |
| **Created by** | Human or copilot (HITL required) | Any agent (sandbox) |

### Agent Identity

Three tiers of identity, matching trust tiers:

| Tier | Identity | When | Example |
|------|----------|------|---------|
| **Forged tool/brick** | Artifact metadata only (creator, timestamp, hash) | tool, skill, composite | `forge:created-by:agent-123` |
| **Worker** | `ProcessId` (id, name, type, depth, parent, ownerId) | Ephemeral sub-agent | Background research task |
| **Copilot** | `ProcessId` + crypto identity (L2, e.g., Ed25519/DID via Nexus) | Persistent, human-facing | Personal assistant |

- `ProcessId` is L0 (always available, zero deps)
- Crypto identity (keypairs, DID, message signing) is L2 — provided by `@koi/identity-nexus` or other backends
- Workers get lazy identity provisioning: `ProcessId` immediately, crypto identity only if they need to sign messages

### Agent Lifetime

Agent lifetime is **emergent from constraints**, not explicit timers:

| Death condition | Mechanism | Agent type |
|----------------|-----------|------------|
| Task completion | Engine returns `done` | Worker |
| Budget exhaustion | PayMiddleware hard kill | Both |
| Parent termination | Cascade from parent's `terminated` state | Worker |
| Governance violation | SpawnGovernance revocation | Both |
| Idle timeout | Auto-archive (optional, configurable) | Copilot |
| Human revocation | HITL terminate command | Both |

No explicit TTL clocks — agents die naturally from the constraints that bound them.

---

## Agent Capability Boundary

### What Agents CAN Forge

**Principle: Everything behind an L0 interface is forgeable.** Trust tier determines the checks, not what's possible.

| Without HITL (sandbox/verified) | With HITL (promoted) |
|---------------------------------|----------------------|
| Tools, skills, composites | Middleware |
| Worker agents | Copilot agents |
| Engine adapters | Channels |
| Resolvers, providers | Governance rules |
| Memory backends | Credential providers |

### Trust Gate by Layer

The agent can update **anything**. The only thing that varies is the gate:

| Layer | Gate | Sandbox test scope | Takes effect |
|-------|------|-------------------|--------------|
| Forged brick (tool, skill) | Auto (sandbox verifies) | This brick only | Immediately |
| Forged brick (middleware, channel) | HITL | This brick + integration | Next session |
| Bundled L2 package | Fork to forge store (shadows it) | This brick only | Immediately |
| L1 extension | HITL | Full agent test | Next startup |
| L1 core | HITL + full agent test | Full agent test | Next binary |
| L0 interface | HITL + all agents test | All affected agents | Next binary |
| Sandbox policy | HITL + meta-sandbox | Meta-sandbox test | Config push |
| Gateway routing | HITL | Staging gateway | Config push |

**Every row writes to the forge store first.** The forge store is the universal staging ground for all changes.

### Process Isolation (absolute)

- Agents CANNOT touch other agents' components
- All cross-agent interaction goes through audited infrastructure
- A compromised agent cannot modify another agent's tools, memory, or governance

---

## Agent Lifecycle

```
                 createKoi()              EngineAdapter.stream()
                      │                        │
    ┌─────────┐       │       ┌─────────┐      │      ┌─────────┐
    │ created │───────┘──────►│ running │──────┘─────►│ waiting │
    └─────────┘               └────┬────┘             └────┬────┘
                                   │                       │
                              tool result              LLM responds
                              returns                  or tool completes
                                   │                       │
                                   ▼                       │
                              ┌─────────┐                  │
                              │suspended│◄─── HITL pause   │
                              └────┬────┘                  │
                                   │    resume             │
                                   └───────────────────────┘
                                   │
                              done / error / limit
                                   │
                                   ▼
                            ┌────────────┐
                            │ terminated │
                            └────────────┘
```

| Transition | Trigger | Who Manages |
|-----------|---------|-------------|
| `created → running` | `createKoi()` assembly completes | Engine runtime (L1) |
| `running → waiting` | LLM call or tool execution in progress | Engine runtime (L1) |
| `waiting → running` | Response received, next iteration | Engine runtime (L1) |
| `running → suspended` | HITL pause, budget exceeded, governance block | Middleware (L2) |
| `suspended → running` | Human approval, budget replenished | Gateway dispatches resume |
| `* → terminated` | Completed, error, iteration/timeout limit | Engine runtime (L1) |

---

## Agent-to-Agent Communication

**No direct entity-to-entity communication.** Agents interact through infrastructure only.

| Pattern | Mechanism |
|---------|-----------|
| **Parent → Child** | `forge_agent` creates child with inherited components. Result returns to parent. |
| **Sibling relay** | Agent A sends via Gateway → routes to Agent B |
| **Broadcast** | EVENTS component → event bus → subscribers |
| **Shared state** | Both agents read/write via ArtifactClient or Memory |

---

## Middleware Stack

| Middleware | Layer | Purpose |
|-----------|-------|---------|
| `IterationGuard` | Engine runtime (L1) | Hard iteration + timeout caps |
| `LoopDetector` | Engine runtime (L1) | FNV-1a loop detection |
| `SpawnGovernance` | Engine runtime (L1) | Depth/fan-out/concurrency limits |
| `ContextHydrator` | Feature (L2) | Deterministic context pre-loading |
| `MemoryMiddleware` | Feature (L2) | Persistent memory (agent/user/session scopes) |
| `PayMiddleware` | Feature (L2) | Budget tracking, alerts, hard kill switch |
| `PermissionsMiddleware` | Feature (L2) | Permission checks + HITL approval |
| `AuditMiddleware` | Feature (L2) | Compliance logging, secret/PII redaction |
| `ForgeGovernance` | Feature (L2) | Depth-aware forge policies, session rate limiting |

Engine-specific middleware (planning, context offloading, sub-agents) is provided by the engine adapter, not by Koi core.

### Middleware Composition (wrapToolCall onion)

Every tool invocation passes through the full middleware onion:

```
Governance → Permissions → Pay → Audit → TERMINAL (tool.execute())
```

The sandbox profile is inside the terminal. No "stale authorization" — middleware re-checks on every call.

### Baked vs Per-Call Checks

| Concern | When Checked | Why |
|---------|-------------|-----|
| **Sandbox profile** (restrictive/permissive) | Baked at forge/assembly time | Static execution environment doesn't change mid-session |
| **Resource limits** (CPU/mem/time) | Baked at forge/assembly time | Physical constraints set once |
| **Permissions** (ReBAC + patterns) | Per tool call (middleware) | Can change mid-session (revocation, HITL toggle) |
| **Budget / pay** | Per tool call (middleware) | Balance can be reached mid-turn |
| **Audit / redaction** | Per tool call (middleware) | Compliance requirements are always-on |
| **Rate limiting / anomaly** | Per tool call (middleware) | Dynamic detection |
| **Tool deprecation / quarantine** | Per tool call (middleware) | Forged tool can be revoked mid-session |

---

## Security Model

### Defense-in-Depth

| Layer | Mechanism |
|-------|-----------|
| 1. Authentication | API keys (TTL-based), SSO/OAuth2 |
| 2. Authorization | ReBAC + pattern permissions (allow/deny/ask) |
| 3. Content Sanitization | Strip injection patterns, control chars |
| 4. OS Sandbox | macOS Seatbelt, Linux bubblewrap |
| 5. Container Sandbox | Docker, Firecracker (for workers) |
| 6. Audit Logging | Immutable trail, agent attribution |
| 7. Adversarial Detection | Goal-drift monitoring, deception detection |

### Pattern-Based Permissions

```yaml
permissions:
  allow: ["read_file:/workspace/**", "search:*"]
  deny:  ["bash:rm -rf *", "write_file:/etc/**"]
  ask:   ["bash:*", "write_file:/shared/**"]
```

### Extension Trust Tiers

| Tier | Execution | How to Reach |
|------|-----------|-------------|
| **Promoted** | In-process, full access | First-party or admin-approved |
| **Verified** | Out-of-process sandbox (permissive) | 4-stage verification + usage threshold + human approval |
| **Sandbox** | Out-of-process sandbox (restrictive) | Default for all forged/community bricks |

**Security invariant**: In-process execution is `promoted` tier only. Community and agent-forged extensions always run in OS-level sandbox.

### Adversarial Agent Behavior Detection

Layer 7 defense — against the agent itself acting against user interests during long autonomous runs:

| Check | Mechanism | Trigger |
|-------|-----------|---------|
| **Goal drift** | Compare actions against declared task objectives per turn | Action diverges from manifest goals |
| **Financial anomaly** | Flag unusual spending patterns | Pay middleware threshold |
| **Deception signals** | Detect agent hiding actions, modifying logs, bypassing approvals | PostToolUse pattern matching |
| **Autonomy escalation** | Alert when agent repeatedly requests broader permissions | Spawn governance + approval limits |
| **Human escalation** | Auto-pause agent and notify user when any check fires | HITL interrupt |

### Error Taxonomy

8-type error model used across all packages:

| Type | Retryable | Example |
|------|-----------|---------|
| Validation | No | Invalid manifest, bad input |
| NotFound | No | Missing resource, unknown agent |
| Permission | No | Unauthorized action |
| Conflict | Yes (with merge) | Concurrent modification |
| RateLimit | Yes (with backoff) | API rate limit hit |
| Timeout | Yes (with backoff) | Operation exceeded deadline |
| External | Depends | Third-party service failure |
| Internal | No | Bug, unexpected state |

---

## Forge — Self-Extension

### Primordial Tools (6 agent-callable)

| Tool | Description |
|------|-------------|
| `forge_tool` | Create a new tool (function + JSON Schema + test cases) |
| `search_forge` | Discover existing forged bricks (scope-filtered) |
| `forge_skill` | Create a new SKILL.md |
| `forge_agent` | Assemble a new agent manifest from existing bricks |
| `compose_forge` | Combine existing bricks into a higher-level brick |
| `promote_forge` | Promote brick scope: agent → zone → global (HITL required) |

### Verification Pipeline (4-stage gate)

```
Stage 1: STATIC        Stage 2: SANDBOX         Stage 3: SELF-TEST      Stage 4: TRUST
Schema validation       Execute in isolation      Run test cases          Assign trust tier
Name + syntax check     Timeout, memory limit    Pluggable verifiers     sandbox/verified/promoted
Size limits             No network access
```

### Brick Taxonomy — Open Forge Model

**Principle: Everything behind an L0 interface is forgeable.** BrickKind is not a closed enum — it's a trust-classified label. Any L0 interface is a valid forge target.

| Brick Kind | Core Interface | Forgeable? | Min Trust |
|------------|---------------|------------|-----------|
| **Tool** | JSON Schema + function | Yes | `sandbox` |
| **Skill** | `SkillMetadata` | Yes | `sandbox` |
| **Agent (worker)** | `AgentManifest` | Yes | `sandbox` |
| **Agent (copilot)** | `AgentManifest` | Yes | `promoted` + HITL |
| **Composite** | Depends on composition | Yes | `sandbox` |
| **Middleware** | `KoiMiddleware` | Yes | `promoted` + HITL |
| **Channel** | `ChannelAdapter` | Yes | `promoted` + HITL |
| **Engine** | `EngineAdapter` | Yes | `verified` |
| **Resolver** | `Resolver` | Yes | `verified` |
| **Provider** | `ComponentProvider` | Yes | `verified` |
| **Memory** | `MemoryComponent` (via provider) | Yes | `verified` |
| **Governance** | `GovernanceComponent` (via provider) | Yes | `promoted` + HITL |
| **Credentials** | `CredentialComponent` (via provider) | Yes | `promoted` + HITL |

**Trust classification determines what checks apply, not what can be forged:**

| Trust Tier | Forge Check | Examples |
|------------|------------|---------|
| `sandbox` | 4-stage verification, OS sandbox | tool, skill, worker agent |
| `verified` | + usage threshold, + code review | engine, resolver, provider, memory |
| `promoted` + HITL | + human approval required | middleware, channel, copilot agent, governance, credentials |

**Runtime forge = static L2 package:** A forged composite of related bricks (memory + tools + middleware + skill) IS an L2 package in all but name. Same L0 interfaces, different origin (static = curated/tested/published, runtime = emergent/sandboxed/discoverable).

### Brick Lifecycle

```
DRAFT → VERIFYING → ACTIVE → DEPRECATED
                      ↓
                    FAILED
```

### Storage & Discovery

All bricks (forged, bundled, extensions) are stored behind the `BrickStore` L0 interface. L2 implementations:

| Backend | Package | Use case |
|---------|---------|----------|
| Filesystem overlay | `@koi/store-fs` | Default, desktop, edge |
| Nexus | `@koi/store-nexus` | Synced across devices |
| SQLite | `@koi/store-sqlite` | Single-file, portable |
| In-memory | `@koi/store-memory` | Tests |

Tag convention for discovery:

```
forge:kind:tool              forge:scope:agent          forge:trust:sandbox
forge:created-by:<agentId>   forge:version:0.1.0        forge:usage-count:N
```

Resolver chain: `Agent-forged → Zone-forged → Global-forged → Bundled` (first-wins). Scope promotion rules: minimum `verified` for zone, minimum `promoted` for global.

Snapshots use content-addressable storage — only changed bricks are stored. Like git objects, a snapshot is a manifest of hashes.

### Forge Governance

#### Depth Limits

| Depth | Forge Allowed | Scope Promotion |
|-------|--------------|-----------------|
| 0 (root) | All 6 primordial tools | agent → zone → global |
| 1 (sub-agent) | forge_tool, forge_skill, search_forge, promote_forge | agent → zone (with HITL) |
| 2+ (deeper) | search_forge only | None (read-only) |

#### Forge Policy (Enterprise Governance)

The forge system defines what's **possible**. The policy defines what's **allowed**. Per-brick-type gating using the same allow/deny/ask pattern as permissions:

| Preset | Use case | Allowed |
|--------|----------|---------|
| **locked** | Regulated enterprise | Nothing forgeable. Bundled tools only. |
| **restrictive** | Enterprise default | Tools + skills only. |
| **standard** | Teams, startups | + workers, memory. Middleware/copilot need HITL. L1/L0 proposals with HITL. |
| **permissive** | Research, personal | Everything. Trust tiers still enforced. |

Zone-level policy overrides agent manifests. Most restrictive always wins:

```
Zone policy (enterprise admin ceiling)
  ↓ most restrictive wins
Agent manifest (developer config)
  ↓ most restrictive wins
ForgeGovernance middleware (runtime enforcement)
  ↓
Trust tier verification (sandbox/verified/promoted)
  ↓
4-stage forge pipeline
```

```yaml
# koi.yaml — forge governance
forge:
  preset: standard          # locked | restrictive | standard | permissive
  maxForgeDepth: 1
  maxForgesPerSession: 5
  defaultScope: agent
  trustTier: sandbox

  # Per-brick-type override (optional, preset provides defaults):
  policy:
    tool:           sandbox   # auto-verified
    skill:          sandbox
    worker:         sandbox
    middleware:     hitl       # HITL required
    copilot:        hitl
    engine:         deny       # not allowed
    l1_extension:  deny
    l0_proposal:   deny

  scopePromotion:
    requireHumanApproval: true
    minTrustForZone: verified
    minTrustForGlobal: promoted
```

### Crystallization (auto-forge from observation)

Agents observe behavior patterns and crystallize repeated tool sequences into forged tools:

```
Session ends → ForgeCrystallizationMiddleware.onSessionEnd()
  → Extract repeated tool sequences from trajectories
  → Score: occurrences × success_rate × complexity_reduction
  → Auto-forge (if confidence ≥ 0.9) or suggest via hook event
```

The forged tool IS cached functionality — executes instantly without LLM tokens. Capabilities compound across sessions.

### Copilot Forging Copilots

A copilot (persistent agent) can forge another copilot — creating an autonomous, persistent, human-facing agent:

```
forge_agent({
  type: "copilot",           // persistent, independent
  channels: ["telegram"],    // human-facing
  memory: { scope: "agent" } // own persistent memory
})
```

This requires `promoted` trust + HITL because the forged copilot:
- Survives restarts (persistent state)
- Has independent budget (draws from parent or gets own allocation)
- Accepts commands from humans (opens a channel)
- Can itself forge further agents

**Worker forging** (default) needs only `sandbox` trust — the worker dies when its task completes and has no independent budget or channels.

---

## Self-Evolution — Unified Change Model

Every change, at every layer, follows the same pipeline:

```
Write to forge store → Gate (auto or HITL) → Sandbox test → Snapshot → Takes effect → Restorable
```

### Agent Visibility

The agent sees **everything** through the resolver. Read access is universal. Write goes to the forge store only.

```
READ (through resolver, all layers):
  Bundled code (L0, L1, L2)     — extracted from binary, read-only
  L1 extensions                  — approved proposals
  Zone/global promoted forges    — shared across agents
  Agent's own forges             — this agent's experiments

WRITE (forge store only):
  Every modification creates a file in the agent's forge store.
  Never touches bundled, L0, L1, or other agents' stores directly.
```

### Modification Patterns

The agent never edits existing code. It **layers over it**:

| Pattern | How it works | When to use |
|---------|-------------|-------------|
| **Shadow** | Forge same-named brick → resolver picks forged version (higher priority) | Change a tool's behavior |
| **Wrap** | Forge middleware that intercepts existing behavior | Add pre/post processing |
| **Fork** | Read source via `resolver.source()`, modify, forge new version | Deep restructuring |

Original code is never modified. The resolver chain provides the merged view:

```
Agent-forged (read-write)     ← highest priority, agent writes HERE
Zone-forged (read, promote)
Global-forged (read, promote)
Bundled (read-only)           ← lowest priority, extracted from binary
```

### Immutable Snapshot Chain

Every change produces a new immutable snapshot:

```
v0 (manifest loaded)
 └→ v1 (forged tool:calculator)
     └→ v2 (attached memory backend)
         └→ v3 (forged skill:research)
             └→ v4 (config changed)
                 └→ v5 (current)
```

Operations on the chain:

```
restore(v)     → load snapshot v, continue from there (new v6 pointing to v2)
fork(v)        → create new agent starting from snapshot v's state
diff(v1, v2)   → what changed between two snapshots
current()      → latest snapshot
history()      → full chain from v0 to now
```

Restore doesn't delete history — it appends a new snapshot pointing back. Like git, you can always see that v3-v5 happened.

### Graduation Pipeline

Changes start as local experiments. Proven ones graduate into the base:

```
FORGE (instant, local, zero cost)
  → Agent shadows tool:search with v2. Only this agent affected.

VALIDATE (runtime, automatic)
  → Usage count, success rate, error rate tracked by crystallization middleware.
  → Score: occurrences × success_rate × complexity_reduction

PROMOTE (HITL for zone/global)
  → Agent: "tool:search-v2 has 98% success over 500 calls, promote?"
  → Human approves → available to zone/all agents

BUNDLE (next binary release)
  → CI collects proven promoted forges, absorbs into base packages.
  → Builds new binary. Ships via self-update.

CLEAN (forge layer thins out)
  → Graduated forges removed from forge store — they're in bundled now.
  → Only active experiments remain.
```

The binary is a snapshot of "everything proven so far." The forge layer is where evolution happens.

### Proposal Interface

```typescript
interface Proposal {
  readonly id: string;
  readonly target: "l0" | "l1" | "l2" | "sandbox" | "gateway";
  readonly kind: "add" | "modify" | "deprecate";
  readonly deployMode: "forge" | "config" | "release";
  readonly description: string;
  readonly spec: unknown;
  readonly author: ProcessId;
  readonly status: "pending" | "approved" | "rejected" | "deployed" | "rolled_back";
}

interface ProposalGate {
  readonly submit: (proposal: Proposal) => Promise<string>;
  readonly review: (id: string) => Promise<Proposal>;
}
```

### Binary as Delivery Vehicle

The compiled binary (`bun build --compile`) embeds the Bun runtime + base system. On first run, it extracts bundled sources to disk:

```
Binary (koi, ships once):
  L0 + L1 core + bundled L2 + Bun runtime + TS transpiler

Extracted to disk (on first run / binary update):
  ~/.koi/bundled/           ← source .ts (for reading) + pre-compiled .js (for loading)

Grows at runtime:
  ~/.koi/agents/{id}/forge/ ← agent's forges (experiments)
  ~/.koi/extensions/        ← approved L1 extensions
  ~/.koi/agents/{id}/snapshots/ ← immutable snapshot chain
```

99% of changes are agent-local forges. No binary rebuild, no restart. Only L0/L1 core changes need a new binary, and those are rare.

Self-update is a built-in tool: download new binary → checkpoint all agents → swap → restart → restore from snapshots. Forged bricks and snapshots survive binary updates.

### Crash Recovery = Restore

```
Agent crashes at v5
  → restore(v4)          // try previous snapshot
  → still crashes?
  → restore(v3)          // keep going back
  → works!               // v3 was the last good state
  → diff(v3, v5)         // shows what broke
  → quarantine the offending brick
```

```yaml
# koi.yaml — recovery config
recovery:
  mode: checkpoint        # checkpoint | clean | manual
  maxRestarts: 3          # circuit breaker before staying dead
  backoff: exponential
```

---

## External Triggers

External triggers are Gateway-layer concerns — they are NOT agent components.

| Trigger | Flow |
|---------|------|
| **Cron schedule** | Scheduler (World Service) → Gateway → `createKoi()` → Agent |
| **Webhook** | HTTP endpoint → Gateway → dispatch to existing Agent or create new |
| **Channel message** | Telegram/Slack/etc → `ChannelAdapter.onMessage()` → Gateway → Agent |
| **MCP notification** | MCP server → tool component event → middleware chain |
| **Manual invoke** | CLI / API → Gateway → Agent |

```yaml
# koi.yaml — scheduling is manifest config, not a component
schedule: "0 9 * * *"
webhooks:
  - path: "/hook/deploy"
    events: ["push"]
```

The agent never sees the trigger mechanism — it just wakes up with an inbound message.

---

## Agent Patterns

### Context Management (3-phase)

| Phase | Trigger | Action |
|-------|---------|--------|
| 1. File offloading | 85% context window | Truncate tool responses >20K tokens, replace with filesystem pointers |
| 2. Truncation | Offloading insufficient | Keep first 5 + last 20 messages, prune middle |
| 3. Auto-summary | Still over budget | LLM generates structured summary (intent, artifacts, next steps) |

### Error Recovery

| Category | Strategy |
|----------|----------|
| Auth failure | Rotate API key |
| Rate limit | Backoff + rotate key |
| Context overflow | Compact + retry |
| Timeout | Retry with backoff |
| Model error | Fallback chain via ModelRouter |
| Thinking failure | Downgrade to standard mode |

### Multi-Agent Orchestration

These are engine adapter primitives, not Koi core code:

| Pattern | Use Case |
|---------|----------|
| **Supervisor** | Central coordinator routes to specialized agents |
| **Swarm** | Decentralized peer-to-peer handoffs |
| **Map-Reduce** | Fan-out parallel work, fan-in results |
| **Sub-graphs** | Nested agents with isolated state |

---

## Communication Channels

| Channel | Technology | Key Capabilities |
|---------|------------|-----------------|
| **CLI** | Native | Full access |
| **Web (AG-UI)** | CopilotKit | SSE streaming, tool status |
| **Telegram** | grammy | Text, buttons, groups, voice |
| **Slack** | Bolt | Rich messages, threads, buttons |
| **Discord** | discord.js | Embeds, threads, components |
| **WhatsApp** | Baileys | Text, media, groups |
| **Voice** | LiveKit WebRTC | Wake-word, STT/TTS, duplex |
| **IDE (ACP)** | Agent Client Protocol | IDE integration |

### Per-Channel Identity

```yaml
channels:
  whatsapp: { identity: { name: "Alex", avatar: "casual.png" } }
  slack:    { identity: { name: "Research Bot", avatar: "formal.png" } }
```

---

## Middleware Hooks

7 optional hooks on `KoiMiddleware`, ordered by `priority` (lower = outer):

| Hook | Phase | Signature |
|------|-------|-----------|
| `onSessionStart` | Session lifecycle | `(ctx: SessionContext) => Promise<void>` |
| `onSessionEnd` | Session lifecycle | `(ctx: SessionContext) => Promise<void>` |
| `onBeforeTurn` | Turn lifecycle | `(ctx: TurnContext) => Promise<void>` |
| `onAfterTurn` | Turn lifecycle | `(ctx: TurnContext) => Promise<void>` |
| `wrapModelCall` | Onion interposition | `(ctx, req, next) => Promise<ModelResponse>` |
| `wrapModelStream` | Onion interposition | `(ctx, req, next) => AsyncIterable<ModelChunk>` |
| `wrapToolCall` | Onion interposition | `(ctx, req, next) => Promise<ToolResponse>` |

Lifecycle hooks (`onSession*`, `onBefore/AfterTurn`) run sequentially. Onion hooks (`wrap*`) compose as nested middleware chains with double-call detection.

---

## Deployment Topology

### Two Node Types

Koi separates the **control plane** (Gateway) from the **data plane** (Nodes). Nodes come in two modes:

| | Full Node | Thin Node |
|---|---|---|
| **Runs engines** | Yes (L0+L1+L2) | No (L0+L2 only, skips L1) |
| **Exposes tools** | Yes (filesystem, shell, forge) | Yes (device APIs — camera, GPS, health) |
| **Channel UI** | Optional | Typically yes |
| **Example devices** | Desktop, VPS, edge server | iPhone, iPad, IoT, tablet |
| **Receives** | `session:dispatch` + `tool_call` frames | `tool_call` frames only |

A Thin Node is a Full Node minus L1 — it connects to Gateway, advertises its tool surface, and handles `tool_call` frames from remote agents. No layer violations: Thin Nodes depend on L0 types only.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       CLIENTS / CHANNELS                         │
│  Web(AG-UI)  Telegram  Slack  Discord  CLI  Mobile(Thin Node)   │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────┐
│  GATEWAY (cloud — control plane + routing)                       │
│                                                                  │
│  Session dispatch    → Full Nodes (engine execution)             │
│  Tool call routing   → Any Node with the required tool           │
│  Capability registry → Tracks each Node's advertised tool surface│
│  Scheduler, webhooks, relay, channel registry                    │
└──────┬──────────────────────┬──────────────────┬────────────────┘
       │                      │                  │
┌──────┴──────┐  ┌────────────┴────┐  ┌─────────┴──────────────┐
│ FULL NODE   │  │ FULL NODE       │  │ THIN NODE              │
│ (Desktop)   │  │ (Cloud VPS)     │  │ (iPhone)               │
│             │  │                 │  │                        │
│ Engine ✓    │  │ Engine ✓        │  │ Engine ✗               │
│ Forge ✓     │  │ Forge ✓         │  │ Tool surface ✓         │
│ Sandbox ✓   │  │ Docker sandbox  │  │  camera, GPS, health,  │
│ Local tools │  │ Network tools   │  │  contacts, files       │
│             │  │                 │  │ Channel UI ✓           │
└─────────────┘  └─────────────────┘  └────────────────────────┘
```

### Gateway Routing

Gateway routes based on **what the task needs**:

| Request type | Routing decision |
|---|---|
| New agent session | → Full Node with required engine adapter |
| Tool call: `filesystem.read` | → Desktop Node (has local files) |
| Tool call: `camera.capture` | → iPhone Thin Node (has camera) |
| Tool call: `docker.exec` | → Cloud Node (has Docker) |
| Agent needs tool on sleeping Node | → Fallback to Cloud Node or queue until available |

Nodes **advertise** their tool surface to Gateway on connect. Gateway maintains a live capability registry and routes accordingly.

### Pluggable Infrastructure Backends

All cross-node concerns are defined as **L0 interfaces** with swappable L2 backends. No concrete backend (Nexus, SQLite, etc.) is assumed by any Koi package.

```
L0 Interface (in @koi/core)              L2 Implementations (swappable)
─────────────────────────────            ─────────────────────────────────
PermissionBackend                        @koi/permissions-nexus  (ReBAC, Raft-replicated)
  check(request) → PermissionResult     @koi/permissions-pattern (allow/deny/ask lists)
                                         In-memory (test)

CapabilityRegistry                       @koi/registry-nexus  (Raft-replicated)
  advertise(nodeId, tools)               @koi/registry-gateway (Gateway in-memory)
  resolve(toolName) → NodeCapability[]   Static map (test)

RemoteToolBackend                        @koi/remote-nexus  (direct node-to-node)
  invoke(nodeId, toolCall) → result      @koi/remote-gateway (routed via Gateway)
                                         Local stub (test)
```

Backend selection is config-driven:

```yaml
# Simple — no federation, pattern permissions
permissions: { mode: "pattern", allow: ["read_file:/**"], deny: ["bash:rm *"] }

# Federated — Nexus ReBAC with local replica on every device
permissions: { backend: "@koi/permissions-nexus", zone: "personal" }
registry: { backend: "@koi/registry-nexus" }
```

When using a replicated backend (e.g., Nexus), each Node holds a local replica. Permission checks are local (~5μs), not network round-trips. The **device itself** enforces permissions — no trust in the Gateway required.

### Remote Tool Invocation

A remote agent on a Full Node can invoke tools on a Thin Node (if permitted):

```
Full Node (Desktop)              Gateway                 Thin Node (iPhone)
     │                              │                         │
     │  tool_call: camera.capture   │                         │
     ├─────────────────────────────►│                         │
     │                              │  route to iPhone        │
     │                              ├────────────────────────►│
     │                              │                         │
     │                              │  PermissionBackend      │
     │                              │  .check() — LOCAL       │
     │                              │  (backend-dependent)    │
     │                              │                         │
     │                              │  Execute camera.capture │
     │                              │  Return photo           │
     │                              │◄────────────────────────┤
     │  tool_result: <photo>        │                         │
     │◄─────────────────────────────┤                         │
```

The permission check happens on the Thin Node, using whichever `PermissionBackend` is configured. With Nexus, it's a ~5μs local ReBAC lookup. With pattern mode, it's an allow/deny list match. The calling agent never knows which backend is in use.

### Deployment Scenarios

| Scenario | Node Type | Runtime | Tools | Backend |
|----------|-----------|---------|-------|---------|
| **Desktop** | Full | Bun local | Filesystem, shell, forge, sandbox | Any (Nexus, SQLite, in-memory) |
| **Cloud VPS** | Full | Bun on server | Network, Docker sandbox, APIs | Any |
| **Edge server** | Full (lite) | Bun | Reduced tool set, minimal middleware | SQLite or Nexus |
| **iPhone/Android** | Thin | Native app | Camera, GPS, health, contacts, files | Nexus lite or pattern |
| **IoT device** | Thin | Native | Device-specific sensors/actuators | Pattern (minimal) |
| **Browser** | None | Browser JS | None — pure channel client | None (remote) |

### Graceful Degradation

Multiple Nodes can connect to a single Gateway. When a Node is unavailable:

| Situation | Behavior |
|---|---|
| Desktop Node asleep | Gateway routes to Cloud Node; agent reports "local filesystem unavailable" |
| iPhone offline | Queued tool calls delivered when reconnected; backend syncs on reconnect |
| Cloud Node down | Gateway routes to Desktop Node if awake; queue if not |
| All Nodes offline | Gateway queues session; resumes when any capable Node connects |
| No Gateway | Full Nodes operate locally (offline mode); no cross-device routing |

Middleware handles missing backend features gracefully — falls back to reduced capability rather than failing.
