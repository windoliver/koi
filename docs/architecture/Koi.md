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
| 5 | **Everything is a Brick** | Tools, skills, middleware, channels, agents — all bricks, all forgeable |
| 6 | **Freedom within isolation** | Full creative freedom inside sandbox. OS-level sandbox is the safety net |
| 7 | **Trust before storage** | Every forged brick passes 4-stage verification (static → sandbox → self-test → trust) |
| 8 | **Scope controls blast radius** | Bricks start at `agent` scope. Promotion to `zone`/`global` requires HITL |
| 9 | **Functional cache** | Forged tools ARE cached functionality. Capabilities compound across sessions |

### Discovery

| # | Principle | Application |
|---|-----------|-------------|
| 10 | **Progressive disclosure** | ~10 tokens (name) → ~100 tokens (metadata) → ~5000 tokens (full implementation) |
| 11 | **First-wins resolver chain** | Local > Agent-forged > Zone-forged > Global-forged > Bundled |
| 12 | **Skills as Markdown** | `SKILL.md` with YAML frontmatter — zero-code agent extension |

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
| **Use Case** | Personal assistant, user-facing | Task execution, background jobs |

---

## Agent Capability Boundary

Agents can freely:
- Create tools, skills, and child agents via Forge
- Discover and compose existing bricks

Agents CANNOT (without HITL):
- Create middleware or world services
- Modify governance or credentials
- Touch other agents' components (process isolation is absolute)
- Promote bricks beyond `agent` scope

**Why no direct agent-to-agent communication**: If Agent A could write to Agent B's components, it would break process isolation. A compromised agent could modify another agent's tools, memory, or governance. All cross-agent interaction goes through audited infrastructure.

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

### Brick Taxonomy

No universal `Brick` interface in `@koi/core`. Bricks are typed by which core interface they implement.

| Brick Kind | Core Interface | Forgeable? | Min Trust |
|------------|---------------|------------|-----------|
| **Tool** | JSON Schema + function | Yes | `sandbox` |
| **Skill** | `SkillMetadata` | Yes | `sandbox` |
| **Agent** | `AgentManifest` | Yes | `sandbox` |
| **Composite** | Depends on composition | Yes | `sandbox` |
| **Middleware** | `KoiMiddleware` | Yes | `promoted` + HITL |
| **Channel** | `ChannelAdapter` | Yes | `promoted` + HITL |

### Brick Lifecycle

```
DRAFT → VERIFYING → ACTIVE → DEPRECATED
                      ↓
                    FAILED
```

### Storage & Discovery

Forged bricks stored as artifacts with tag convention:

```
forge:kind:tool              forge:scope:agent          forge:trust:sandbox
forge:created-by:<agentId>   forge:version:0.1.0        forge:usage-count:N
```

Discovery via `search_forge` → `ArtifactClient.search()` with tag filtering. Resolver chain: `LocalResolver → ForgeResolver:agent → ForgeResolver:zone → ForgeResolver:global` (first-wins).

Scope promotion rules: minimum `verified` for zone, minimum `promoted` for global.

### Forge Governance

| Depth | Forge Allowed | Scope Promotion |
|-------|--------------|-----------------|
| 0 (root) | All 6 primordial tools | agent → zone → global |
| 1 (sub-agent) | forge_tool, forge_skill, search_forge, promote_forge | agent → zone (with HITL) |
| 2+ (deeper) | search_forge only | None (read-only) |

```yaml
# koi.yaml — forge governance
forge:
  enabled: true
  maxForgeDepth: 1
  maxForgesPerSession: 5
  defaultScope: agent
  trustTier: sandbox
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

### Deployment Scenarios

| Scenario | Backend Mode | Runtime | Communication |
|----------|-------------|---------|---------------|
| **Cloud** | Server (HTTP) | Bun on server | HTTP REST |
| **Desktop** | Embedded | Bun local | HTTP localhost |
| **Edge device** | Embedded (lite) | Bun | HTTP localhost, minimal features |
| **Browser** | None (remote) | Browser JS | HTTP to cloud backend |

### Gateway / Node Split

```
Gateway (cloud)                          Node (desktop/edge)
├── WebSocket control plane              ├── Local agent execution
├── Channel registry                     ├── Local tools (filesystem, shell)
├── Session management                   ├── Sandbox profiles
├── Agent routing (session → pid)        ├── Bonjour/mDNS discovery
└── Scheduler, webhooks, relay           └── Connects to Gateway via WebSocket
```

Multiple Nodes can connect to a single Gateway. Middleware handles missing backend features gracefully — falls back to reduced capability rather than failing.
