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
| **Snapshot** | Immutable point-in-time capture of a brick's state — enables version history, rollback, and provenance tracking |
| **ForgeStore** | Persistence backend for forged brick artifacts — save, search, update, remove with structured queries |

## Architecture Components

| Component | Technology | Role |
|-----------|------------|------|
| **Engine Runtime** | @koi/engine + @koi/engine-compose + @koi/engine-reconcile | Guards, validation, middleware composition, reconciliation, adapter dispatch |
| **Engine Adapter** | Swappable | The actual agent loop (`stream()` is the only required method) |
| **Agent Body** | Gateway + Node | Multi-channel, local devices, sessions |
| **Self-Extension** | @koi/forge | Runtime brick creation, verification, discovery |
| **Infrastructure** | Pluggable backends | Memory, search, permissions, payments, artifact storage |

### Linux → Koi Mental Model

Every Koi concept maps 1:1 to a Linux kernel equivalent:

| Linux | Koi | Where it lives |
|-------|-----|----------------|
| `task_struct` | `ProcessDescriptor` | L0 `@koi/core` — read-only snapshot assembled by agent-procfs |
| Process state (RUNNING/STOPPED/ZOMBIE) | `ProcessState` + `AgentCondition[]` | L0 type, L1 state machine (single authority via AgentRegistry) |
| `/proc/PID/status` | `agent-procfs` `/agents/<id>/descriptor` | L2 sidecar — 12+ virtual filesystem entries |
| `fork(2)` + `exec(2)` | `SpawnFn` | L0 contract → shared adapter in `@koi/execution-context` |
| `mqueue(7)` | `MailboxComponent` | L0 contract → `ipc-local` / `ipc-nexus` |
| `mmap(MAP_SHARED)` / `/dev/shm` | `ScratchpadComponent` | L0 contract → Nexus filesystem CAS |
| Signals (SIGTERM/SIGSTOP) | `AGENT_SIGNALS` (STOP/CONT/TERM/USR1/USR2) | L0 → routed through gateway → node → agent |
| `cgroups` | `GovernanceVariable` readings | Governance middleware (token budget, error rate, context limits) |
| `capabilities(7)` | `DelegationGrant` | HMAC-signed, monotonically attenuated, cascade-revocable |
| `systemd` | `SupervisionController` | L1 `@koi/engine` — unifies 5 scattered reconcilers |
| `/sys/` | Syscall table (7 contracts, versioned) | L0 — stable ordinals for multi-node compat |
| VFS | `FileSystemBackend` + Nexus Unified Namespace | Every domain concept is a path under `/agents/{id}/` |
| netfilter/iptables | `KoiMiddleware` with phase typing | INTERCEPT / OBSERVE / RESOLVE annotations |
| Device drivers | Engine adapters | L2 — `engine-claude`, `engine-loop`, etc. |
| Kernel modules | L2 feature packages | Independent, swappable, import only L0/L0u |

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
│  │  ┌────────────┐ ┌────────────┐ ┌─────────────────────┐  │  │
│  │  │ EVENTS     │ │ DELEGATION │ │ FILESYSTEM          │  │  │
│  │  └────────────┘ └────────────┘ └─────────────────────┘  │  │
│  │  ┌─────────────────┐ ┌────────────────┐                 │  │
│  │  │ skill:research  │ │ channel:tg     │                 │  │
│  │  └─────────────────┘ └────────────────┘                 │  │
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
│  │ Trust: sandbox ⇄ verified ⇄ promoted (bidirectional)     │  │
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
ProcessDescriptor            L0      Read-only agent snapshot (like /proc/PID/status)
KoiMiddleware (+ phase)      L0      Middleware contract with INTERCEPT/OBSERVE/RESOLVE
ChannelAdapter, Resolver     L0      Channel + Discovery contracts
EngineAdapter                L0      Engine contract
AgentRegistry                L0      Lifecycle contract (7th core contract)

Engine runtime (guards)      L1      @koi/engine: createKoi(), IterationGuard, SpawnGuard
Reconciliation controllers   L1      @koi/engine-reconcile: supervision, K8s-style convergence
Middleware chain composition L1      @koi/engine-compose: wraps adapter in onion
SupervisionController        L1      Unified health/timeout/governance/signals
ProcessState transitions     L1      Lifecycle state machine (single authority)

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
│                                      mcp, sandbox            │
│                                                              │
│  ComponentProvider impls attach components during assembly.   │
│  Forge creates new components AT RUNTIME.                    │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: ENGINE (3-package kernel runtime)                   │
│  @koi/engine:          createKoi(), guards, lifecycle FSM    │
│  @koi/engine-compose:  Middleware chain composition           │
│  @koi/engine-reconcile: K8s-style reconciliation controllers │
│  IterationGuard, LoopDetector, SpawnGuard                    │
│  SupervisionController (Erlang/OTP-style, parallel spawns)   │
│  ProcessState transitions (lifecycle state machine)          │
│  Middleware chain composition → EngineAdapter dispatch        │
├─────────────────────────────────────────────────────────────┤
│  Layer 0u: UTILITIES (pure functions, zero business logic)    │
│  29 packages: errors, validation, manifest, hash,            │
│  token-estimator, event-delivery, crypto-utils, edit-match,  │
│  nexus-client, dashboard-types, harness-scheduler, + more.   │
│  See scripts/layers.ts → L0U_PACKAGES for full list.         │
│  Depend on L0 + peer L0u only. Importable by L1 and L2.      │
├─────────────────────────────────────────────────────────────┤
│  Layer 0: KERNEL (@koi/core — types only)                    │
│  7 core contracts + extended contracts + ECS layer            │
│  Core: Middleware, Message, Channel, Resolver, Assembly,      │
│        Engine, AgentRegistry                                  │
│  Extended: ForgeStore, SnapshotStore, Delegation,             │
│           FileSystemBackend, SandboxExecutor, Config, ...     │
│  ECS: Agent, SubsystemToken<T>, ComponentProvider, Tool,      │
│       ProcessDescriptor                                       │
│  ZERO implementations                                        │
└─────────────────────────────────────────────────────────────┘
```

### Why 4 Layers? (plus L0-utilities)

| Property | Kernel (L0) | Utilities (L0u) | Engine (L1) | Features (L2) | Meta (L3) |
|----------|-------------|-----------------|-------------|----------------|-----------|
| **Contains** | 7 core contracts + extended contracts, ECS (types only) | Pure functions, error types, validation, hashing, session state | Guards, validation, dispatch, supervision, reconciliation | Channels, middleware, providers | Dependency bundles |
| **Dependencies** | Zero | @koi/core only | @koi/core + L0u | @koi/core + L0u | L0 + L0u + L1 + selected L2 |
| **Breakage scope** | All packages | Consumers only | Engine only | Own package only | None |
| **Can be swapped?** | Never | Yes (per package) | No (it IS the runtime) | Yes (per package) | Yes |
| **Analogy** | Kernel headers | libc / POSIX utilities | Kernel runtime (`__schedule()`) | Kernel modules (ext4, tcp) | Distro packages |

Engine *adapters* (Claude, Pi, Loop, custom) are swappable L2 packages. The engine *runtime* (guards, governance) is not — it IS the kernel runtime.

**L0-utility packages** (46 total — canonical list lives in `scripts/layers.ts` → `L0U_PACKAGES`):
`@koi/acp-protocol`, `@koi/channel-base`, `@koi/cli-commands`, `@koi/cli-render`, `@koi/crypto-utils`, `@koi/crystallize`, `@koi/dashboard-client`, `@koi/dashboard-types`, `@koi/delegation`, `@koi/delegation-nexus`, `@koi/edit-match`, `@koi/errors`, `@koi/event-delivery`, `@koi/execution-context`, `@koi/failure-context`, `@koi/file-resolution`, `@koi/forge-types`, `@koi/gateway-types`, `@koi/git-utils`, `@koi/harness-scheduler`, `@koi/hash`, `@koi/manifest`, `@koi/name-resolution`, `@koi/nexus-client`, `@koi/preset-resolver`, `@koi/resolve`, `@koi/sandbox-cloud-base`, `@koi/sandbox-wasm`, `@koi/scope`, `@koi/search-provider`, `@koi/session-repair`, `@koi/session-state`, `@koi/setup-core`, `@koi/shutdown`, `@koi/skill-scanner`, `@koi/snapshot-chain-store`, `@koi/sqlite-utils`, `@koi/task-board`, `@koi/test-utils`, `@koi/test-utils-contracts`, `@koi/test-utils-mocks`, `@koi/test-utils-store-contracts`, `@koi/token-estimator`, `@koi/validation`, `@koi/variant-selection`, `@koi/welford-stats`.
These contain pure utility functions with zero business logic. They depend on `@koi/core` + peer
L0u packages only, and are importable by both L1 and L2 packages. They do NOT define core
contracts — they provide shared implementations of common operations (error creation, schema
validation, hashing, token estimation, event delivery, etc.).

---

## Kernel Interfaces (L0)

`@koi/core` defines the complete contract surface. All properties `readonly`, all data immutable. See source files for exact type signatures — this section describes architectural intent, not verbatim types.

### Core Contracts (7)

| # | Contract | Source | Surface | Key Idea |
|---|----------|--------|---------|----------|
| 1 | **Middleware** | `middleware.ts` | 7 optional hooks + priority + phase | Sole interposition layer for model/tool calls. Onion composition with `wrapModelCall`, `wrapModelStream`, `wrapToolCall`. Phase annotation (INTERCEPT/OBSERVE/RESOLVE) for ordering semantics. |
| 2 | **Message** | `message.ts` | `ContentBlock` union, `InboundMessage`, `OutboundMessage` | Content blocks: text, file, image, button, custom. Inbound messages carry `senderId`, `timestamp`, and content blocks. |
| 3 | **Channel** | `channel.ts` | `ChannelAdapter` — connect, disconnect, send, onMessage | Where the agent talks. Capabilities-aware. Supports status notifications (`sendStatus`). |
| 4 | **Resolver** | `resolver.ts` | `discover()` + `load()` + optional `onChange()` | Generic `<TMeta, TFull>` discovery. `load()` returns `Result<TFull, KoiError>` (typed errors, not undefined). |
| 5 | **Assembly** | `assembly.ts` | `AgentManifest` — name, model, tools, channels, middleware, permissions, delegation | Declarative agent definition. YAML IS the agent. |
| 6 | **Engine** | `engine.ts` | `EngineAdapter` — `stream()` is the only required method | Swappable agent loop. `terminals` enable middleware interposition. `ComposedCallHandlers` passes middleware-wrapped calls back to the adapter including the `tools` descriptor list. |
| 7 | **AgentRegistry** | `lifecycle.ts` | CAS transitions + `watch()` + conditions | Agent lifecycle management. Single authority for ProcessState transitions. Conditions (Initialized, Ready, Healthy, Draining, Idle) are flags, not states. `registry-nexus` is the cross-node authority. |

### Extended Contracts

Additional L0 contracts for subsystems that need pluggable backends:

| Contract | Source | Purpose |
|----------|--------|---------|
| **ForgeStore** | `brick-store.ts` | Brick artifact persistence — save, load, search, remove, update with `Result<T, KoiError>` returns. Replaced the earlier `BrickStore` concept |
| **SnapshotStore** | `brick-snapshot.ts` | Per-brick version history and provenance. Records `created`, `updated`, `promoted`, `deprecated`, `quarantined` events. `BrickSnapshot` is per-brick (not per-agent) |
| **Delegation** | `delegation.ts` | Capability delegation with HMAC-signed grants, scope checking, and revocation registry |
| **FileSystemBackend** | `filesystem-backend.ts` | Cross-engine file operations (read, write, edit, list, search). Wrapped as Tool components by an L2 ComponentProvider |
| **SandboxExecutor** | `sandbox-executor.ts` | Code execution in isolation — the forge verification contract |
| **SandboxProfile** | `sandbox-profile.ts` | Platform-agnostic isolation policy (filesystem, network, resource limits per trust tier) |
| **SessionPersistence** | `session.ts` | Crash recovery — checkpoint, restore, recovery planning |
| **ConfigStore** | `config.ts` | Reactive configuration with typed sections, feature flags, and change listeners |
| **HealthMonitor** | `health.ts` | Runtime health tracking with degraded/unhealthy/healthy status |
| **TaskScheduler** | `scheduler.ts` | Cron-based task scheduling with persistence |
| **ContextCompactor** | `context.ts` | Context window management — compaction and token estimation |
| **EvictionPolicy** | `eviction.ts` | Agent eviction strategies (idle, LRU, priority-based) |
| **ModelProvider** | `model-provider.ts` | LLM provider abstraction with capabilities discovery |
| **ReconciliationController** | `reconciliation.ts` | K8s-style desired-state convergence — observe, diff, act loops |

### ECS Compositional Layer

The ECS layer is the architectural heart — `Agent` is the entity, `Tool` is a component, `Middleware` is a system.

```typescript
// Branded typed component keys — type-safe at zero runtime cost
type SubsystemToken<T> = string & { readonly __brand: T };

// Agent = ECS entity
interface Agent {
  readonly pid: ProcessId;       // id, name, type ("copilot"|"worker"), depth, parent
  readonly manifest: AgentManifest;
  readonly state: ProcessState;  // "created"|"running"|"waiting"|"suspended"|"terminated"
  readonly component: <T>(token: SubsystemToken<T>) => T | undefined;
  readonly has: (token: SubsystemToken<unknown>) => boolean;
  readonly query: <T>(prefix: string) => ReadonlyMap<SubsystemToken<T>, T>;
  readonly components: () => ReadonlyMap<string, unknown>;
}

// Tool = component with trust tier
interface Tool {
  readonly descriptor: ToolDescriptor;
  readonly trustTier: TrustTier;  // "sandbox" | "verified" | "promoted"
  readonly execute: (args: JsonObject) => Promise<unknown>;
}

// ProcessDescriptor = read-only snapshot (like Linux /proc/PID/status)
// Assembled by agent-procfs from existing subsystems — not stored as one object
interface ProcessDescriptor {
  readonly identity: ProcessId;              // pid, name, type, depth, parent, groupId
  readonly phase: ProcessState;              // created | running | waiting | suspended | terminated
  readonly conditions: readonly AgentCondition[];  // Initialized, Ready, Healthy, Draining, Idle
  readonly generation: number;               // CAS generation for optimistic concurrency
  readonly resources: ResourceSnapshot;      // token usage, context occupancy, cost, error rate
  readonly children: readonly AgentId[];     // child agent IDs
  readonly credentials: CredentialSnapshot;  // ownerId, zoneId
  readonly workspace: WorkspaceSnapshot;     // cwd, workspaceId
  readonly scheduling: SchedulingSnapshot;   // qos: "premium" | "standard" | "spot"
  readonly timestamps: TimestampSnapshot;    // createdAt, lastScheduledAt, lastCheckpoint
}

// ComponentProvider attaches components during assembly
interface ComponentProvider {
  readonly name: string;
  readonly attach: (agent: Agent) => Promise<ReadonlyMap<string, unknown>>;
  readonly detach?: (agent: Agent) => Promise<void>;
}
```

### Well-Known Tokens

```typescript
const MEMORY      = token<MemoryComponent>("memory");
const GOVERNANCE  = token<GovernanceComponent>("governance");
const CREDENTIALS = token<CredentialComponent>("credentials");
const EVENTS      = token<EventComponent>("events");
const DELEGATION  = token<DelegationComponent>("delegation");
const FILESYSTEM  = token<FileSystemBackend>("filesystem");
const MAILBOX     = token<MailboxComponent>("mailbox");         // IPC: mqueue(7) equivalent
const SCRATCHPAD  = token<ScratchpadComponent>("scratchpad");   // IPC: /dev/shm equivalent

function toolToken(name: string): SubsystemToken<Tool>;              // "tool:calculator"
function channelToken(name: string): SubsystemToken<ChannelAdapter>; // "channel:telegram"
function skillToken(name: string): SubsystemToken<SkillMetadata>;    // "skill:refund-policy"
```

**Namespace convention**: No colon = singleton (`"memory"`), with colon = namespaced (`"tool:calculator"`). `query("tool:")` returns all tool components.

### Singleton Components

One per agent, accessed via well-known tokens:

| Component | Token | Purpose |
|-----------|-------|---------|
| `MemoryComponent` | `MEMORY` | `recall(query)` → `MemoryResult[]` (content + score + metadata), `store(content)` |
| `GovernanceComponent` | `GOVERNANCE` | Usage tracking, spawn checking |
| `CredentialComponent` | `CREDENTIALS` | Secret retrieval by key |
| `EventComponent` | `EVENTS` | Pub/sub event bus (emit + subscribe) |
| `DelegationComponent` | `DELEGATION` | Capability grants with HMAC signing |
| `FileSystemBackend` | `FILESYSTEM` | Cross-engine file operations |
| `MailboxComponent` | `MAILBOX` | IPC inbox — async message passing between agents (Linux `mqueue` equivalent) |
| `ScratchpadComponent` | `SCRATCHPAD` | Shared memory / CAS store for handoffs and coordination (Linux `/dev/shm` equivalent) |

Additional ECS types: `SpawnLedger` (tree-wide spawn accounting), `ProcessAccounter` (cross-agent spawn counting), `ChildHandle` + `ChildLifecycleEvent` (monitoring child agents), `ProcessDescriptor` (read-only unified snapshot — see ECS section above).

### Scoped Component Views (Linux namespace model)

Different L2 consumers of the same singleton token often need **different permission scopes** — like Linux mount namespaces where each process sees a restricted view of the same kernel filesystem.

```
                    ┌──────────────────┐
                    │   Real Backend    │
                    │  (full access)    │
                    └────────┬─────────┘
                             │
                 ┌───────────┼───────────┐
                 ▼           ▼           ▼
          ┌───────────┐ ┌────────┐ ┌───────────┐
          │ Scoped    │ │ Scoped │ │ Scoped    │
          │ View A    │ │ View B │ │ View C    │
          └───────────┘ └────────┘ └───────────┘
              rw           ro          rw
           ./src       ~/.koi/skills  ./cache
```

**Pattern**: one real backend per token, pure proxy wrappers restrict the view per consumer. Same L0 interface in, same L0 interface out. L2 code is unchanged — `agent.component(FILESYSTEM)` returns a `FileSystemBackend`, it just doesn't know it's scoped.

**Tokens requiring scoped views:**

| Token | Scoping dimension | Example |
|-------|-------------------|---------|
| `FILESYSTEM` | Path root + read/write mode | code-mode gets rw to `./src`, skill-scanner gets ro to `~/.koi/skills` |
| `BROWSER` | URL allowlist + trust tier gating | Payment tool restricted to payment domains, e2e tool gets full navigation |
| `CREDENTIALS` | Key name pattern (glob filter) | Child agent gets `OPENAI_*` keys only, not parent's full vault |
| `MEMORY` | Agent namespace + read/write isolation | Child's `store()` doesn't pollute parent's `recall()` results |

**Tokens already scoped by design (no proxy needed):**

| Token | Why |
|-------|-----|
| `GOVERNANCE` | Each agent gets its own controller instance with independent quotas |
| `EVENTS` | Each agent gets its own stream (keyed by `streamId`) — isolation is built in |
| `DELEGATION` | Monotonic attenuation is the whole point — `grant()` can only narrow, never widen |

**Implementation**: Scoped view wrappers are pure L0u functions (`createScopedFs()`, `createScopedBrowser()`, etc.) that take the real backend + scope config and return the same interface. The resolver (L3) reads manifest config per tool declaration and creates scoped views at assembly time. No ECS model changes, no new tokens, no L2 code changes.

```yaml
# koi.yaml — resolver reads per-tool scope config
tools:
  - package: "@koi/code-mode"
    filesystem: { root: "./src", mode: "read-write" }
  - package: "@koi/skill-scanner"
    filesystem: { root: "~/.koi/skills", mode: "read-only" }
```

### Other Kernel Types

Additional types in `@koi/core`: `KoiConfig`, `FeatureFlags`, `ModelConfig`, `PermissionConfig`, `EngineOutput`, `EngineState`, `EngineMetrics`, `EngineStopReason`, `BrickKind` (6 values: tool, skill, agent, composite, middleware, channel), `BrickLifecycle`, `ForgeScope`, `TrustTier`.

Subsystem-specific config types live in their owning packages (e.g., `ExecutionLimitsConfig` in `@koi/engine`).

### Extension Point Recipes

How to expose each extension point. Every package follows the same patterns — no exceptions.

#### Exposing a Tool

```typescript
// 1. Create a ComponentProvider that returns a Map with toolToken() keys
import { toolToken, createSingleToolProvider } from "@koi/core";

// Simple (one tool):
export function createMyProvider(config: MyConfig): ComponentProvider {
  return createSingleToolProvider({
    name: "my-package",
    toolName: "my_tool",          // → toolToken("my_tool") = "tool:my_tool"
    createTool: () => createMyTool(config),
  });
}

// Multi-tool: return Map with multiple toolToken() entries from attach()
```

Linux equivalent: loading a kernel module that registers device nodes.

#### Exposing a Skill

```typescript
// Skills attach alongside tools via extras in the same ComponentProvider
import { skillToken } from "@koi/core";
import type { SkillComponent } from "@koi/core";

const MY_SKILL: SkillComponent = {
  name: "my-skill",
  description: "When and how to use my-tool effectively",
  content: "# My Skill\n\nMarkdown teaching guide...",
  tags: ["my-domain"],
} as const satisfies SkillComponent;

// Attach via extras:
createSingleToolProvider({
  name: "my-package",
  toolName: "my_tool",
  createTool: () => createMyTool(config),
  extras: [[skillToken("my-skill") as string, MY_SKILL]],  // ← skill rides with tool
});
```

Linux equivalent: man pages installed alongside the binary.

#### Exposing Middleware

```typescript
// Factory function + config type. No tokens — middleware uses name field.
import type { KoiMiddleware } from "@koi/core";

export function createMyMiddleware(config: MyMiddlewareConfig): KoiMiddleware {
  return {
    name: "my-middleware",
    priority: 200,             // lower = outer (runs first)
    phase: "INTERCEPT",        // INTERCEPT | OBSERVE | RESOLVE
    async wrapToolCall(ctx, req, next) {
      // ... intercept, then call next(req)
      return next(req);
    },
  };
}
```

Passed to `createKoi()` as array. Linux equivalent: netfilter chain rule.

#### Exposing a Channel

```typescript
// Factory returning ChannelAdapter, using createChannelAdapter<E> helper from @koi/channel-base
import { createChannelAdapter } from "@koi/channel-base";

export function createMyChannel(config: MyChannelConfig): ChannelAdapter {
  return createChannelAdapter<MyPlatformEvent>({
    name: "my-channel",
    capabilities: MY_CAPABILITIES,
    platformConnect: async () => { /* ... */ },
    platformDisconnect: async () => { /* ... */ },
    platformSend: async (message) => { /* ... */ },
    onPlatformEvent: (handler) => { /* ... */ },
  });
}
```

Registered via `channelToken("my-channel")`. Linux equivalent: device driver with `/dev/` entry.

#### Building an L3 Bundle

```typescript
// ZERO new logic. Compose L0 + L1 + L2, return ready-to-use bundle.
export function createMyBundle(config: MyBundleConfig): MyBundle {
  const middleware = [
    createPermissionsMiddleware(config.permissions),
    createAuditMiddleware(config.audit),
    // ... compose from L2 packages
  ];
  const providers = [
    createMyToolProvider(config.tools),
    // ... compose ComponentProviders
  ];
  return { middleware, providers };
}
```

Presets ("open" / "standard" / "strict") are encouraged. Linux equivalent: distro meta-package.

#### Quick Reference

| I want to expose... | I create... | Token function | Discovered via | Linux ≈ |
|---------------------|-------------|----------------|----------------|---------|
| Tool | `ComponentProvider` → `toolToken()` | `toolToken(name)` | `agent.query("tool:")` | `insmod` + `/dev/` |
| Skill | `SkillComponent` → `skillToken()` | `skillToken(name)` | `agent.query("skill:")` | `man` page |
| Middleware | `create*Middleware()` factory | none (`name` field) | Array to `createKoi()` | netfilter rule |
| Channel | `create*Channel()` factory | `channelToken(name)` | `agent.query("channel:")` | device driver |
| L3 Bundle | Composition factory | none | Direct import | distro meta-package |
| Forged brick | Forge → ForgeStore → ForgeResolver | auto (`toolToken`/`skillToken`) | Resolver chain | `modprobe` |

---

## Design Principles

### Foundation

| # | Principle | Application |
|---|-----------|-------------|
| 0 | **KISS** | Core vocabulary <= 10 concepts. Code over configuration. No framework reinvention |
| 1 | **Interface-first kernel** | `@koi/core` = types only. Zero implementations. The kernel defines the plugs, not the things that plug in |
| 2 | **Minimal-surface contracts** | Channel: `send()` + `onMessage()` + `sendStatus()`. Middleware: 7 optional hooks + priority. Engine: `stream()` only required method. Extended contracts follow same principle |
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
| 13 | **Bidirectional trust** | Trust is earned AND lost. Bricks demote on health failure, not just promote on success (Red Queen) |
| 14 | **Fitness-driven selection** | Runtime health signals (success rate, latency, error rate) determine which bricks survive (natural selection) |
| 15 | **Supervision over restart** | Erlang/OTP-style supervision trees manage crash recovery — not naive "try previous snapshot" |

### Discovery

| # | Principle | Application |
|---|-----------|-------------|
| 16 | **Progressive disclosure** | ~10 tokens (name) → ~100 tokens (metadata) → ~5000 tokens (full source + tests) |
| 17 | **First-wins resolver chain** | Agent-forged > Zone-forged > Global-forged > Bundled |
| 18 | **Skills as Markdown** | `SKILL.md` with YAML frontmatter — zero-code agent extension |

---

## Design Decisions

### Swappable Engine

**Decision**: The `EngineAdapter` interface enables swapping the agent execution model without rewriting middleware. Only the adapter package imports the underlying framework. All other packages depend on `@koi/core` interfaces.

| Adapter | Underlying Framework | Use Case |
|---|---|---|
| `@koi/engine-claude` | Anthropic Claude API | Claude-native tool use, HITL approval bridge, streaming |
| `@koi/engine-pi` | Inflection Pi API | Pi-specific conversation style |
| `@koi/engine-loop` | None (pure TS) | Simple ReAct loop, lightweight agents |

```yaml
# koi.yaml — engine selection
engine: claude    # or "pi", "loop"
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
  - "@koi/middleware-audit": { scope: agent }
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

**Decision**: `@koi/core` = types-only kernel. The sole runtime code is branded type constructors (zero-logic identity casts for `SubsystemToken<T>`) and pure data constants derived from type definitions (e.g., `VALID_TRANSITIONS`, `RETRYABLE_DEFAULTS`). The kernel is a protocol specification, not an implementation.

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
| **Worker** | `ProcessId` (id, name, type, depth, parent) | Ephemeral sub-agent | Background research task |
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

### One State Machine, Not Four

**Before**: 4 independent state machines (engine ProcessState, harness HarnessPhase, verified-loop implicit, scheduler TaskStatus) — uncoordinated. **After**: One state machine owned by `AgentRegistry`. L2 packages use `registry.transition()` — no private state machines.

```
ProcessState:  created → running → waiting → suspended → terminated
                                     ↑
AgentConditions (flags, not states):  Initialized, Ready, Healthy,
                                      Draining, BackgroundWork, Idle
```

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

### Unified Supervision (systemd model)

`SupervisionController` in L1 unifies 5 previously scattered reconcilers (supervision, health, timeout, governance, agent-monitor) into one:

- Receives signals from gateway (STOP/CONT/TERM — like POSIX signals)
- Manages health checks, timeouts, governance limits
- Handles cascading termination (parent dies → children die)
- Controls warm worker pool — reuse idle agents
- Deterministic shutdown: SIGTERM → drain → checkpoint → respond

---

## Agent-to-Agent Communication

**No direct entity-to-entity communication.** Agents interact through 3 IPC primitives (like POSIX), routed through infrastructure.

### Three IPC Primitives

| Primitive | Linux equivalent | Koi component | Multi-node |
|-----------|-----------------|---------------|------------|
| **Mailbox** | `mqueue(7)` | `MailboxComponent` | Nexus IPC (`/agents/{id}/mailbox/`) |
| **Spawn** | `fork(2)` + `exec(2)` | `SpawnFn` | `Node.dispatch()` via registry |
| **Scratchpad** | `/dev/shm` / filesystem | `ScratchpadComponent` (CAS) | Nexus `/groups/{groupId}/scratch/` |

Coordination patterns (long-running, task-spawn) **use** these primitives — they're not primitives themselves.

### Communication Patterns

| Pattern | Mechanism |
|---------|-----------|
| **Parent → Child** | `SpawnFn` creates child with inherited components. Result returns to parent. |
| **Sibling relay** | Agent A sends via `MailboxComponent` → Gateway routes to Agent B |
| **Handoff** | Write to `ScratchpadComponent` — persist + authorize + notify in one operation |
| **Broadcast** | EVENTS component → event bus → subscribers |
| **Shared state** | Both agents read/write via `ScratchpadComponent` or Memory |
| **Stigmergy** (#254, planned) | Agents leave traces in the environment (forge store, snapshots) that influence other agents' behavior — indirect coordination like ant pheromone trails |

```
Stigmergic coordination (planned, #254):

Agent₁ forges tool:parser-v2 → writes to forge store
  ↓ (artifact exists in shared scope)
Agent₂ discovers tool:parser-v2 via resolver → uses it
  ↓ (usage count increases, fitness score rises)
Agent₃ observes high-fitness brick → adopts it
  ↓ (positive feedback loop)
Brick promoted to zone scope → all agents benefit

No messages exchanged. No coordination protocol.
The environment IS the coordination medium.
```

---

## Middleware Stack

### Phase Annotations (netfilter model)

Every middleware declares a phase — like Linux netfilter chains — for ordering semantics:

```
Phase       Priority  Purpose                            Examples
─────────   ────────  ────────                           ────────
INTERCEPT   100-200   Gate/block before execution        permissions, exec-approvals, delegation, governance, pay
OBSERVE     300-375   Read-only observation after exec   audit, pii, sanitize, guardrails
RESOLVE     220-420   Transform/adapt data               tool-squash, compactor, context-editing
```

### Middleware Table

| Middleware | Layer | Phase | Purpose |
|-----------|-------|-------|---------|
| `IterationGuard` | Engine runtime (L1) | INTERCEPT | Hard iteration + timeout caps |
| `LoopDetector` | Engine runtime (L1) | INTERCEPT | FNV-1a loop detection |
| `SpawnGovernance` | Engine runtime (L1) | INTERCEPT | Depth/fan-out/concurrency limits |
| `ContextHydrator` | Feature (L2) | RESOLVE | Deterministic context pre-loading |
| `MemoryMiddleware` | Feature (L2) | RESOLVE | Persistent memory (agent/user/session scopes) |
| `PayMiddleware` | Feature (L2) | INTERCEPT | Budget tracking, alerts, hard kill switch |
| `PermissionsMiddleware` | Feature (L2) | INTERCEPT | Permission checks + HITL approval |
| `AuditMiddleware` | Feature (L2) | OBSERVE | Compliance logging, secret/PII redaction |
| `ForgeGovernance` | Feature (L2) | INTERCEPT | Depth-aware forge policies, session rate limiting |

Engine-specific middleware (planning, context offloading, sub-agents) is provided by the engine adapter, not by Koi core.

### Middleware Composition (wrapToolCall onion)

Every tool invocation passes through the full middleware onion:

```
INTERCEPT: Governance → Permissions → Pay → RESOLVE: Context → OBSERVE: Audit → TERMINAL (tool.execute())
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
| 3. Capability tokens (#252, planned) | Unforgeable, attenuable, delegatable (seL4/Fuchsia model) |
| 4. Content Sanitization | Strip injection patterns, control chars |
| 5. OS Sandbox | macOS Seatbelt, Linux bubblewrap |
| 6. Container Sandbox | Docker, Firecracker (for workers) |
| 7. Audit Logging | Immutable trail, agent attribution |
| 8. Adversarial Detection | Goal-drift monitoring, deception detection |

### Capability-Based Security (#252)

```
Current: permission = (subject, action, resource) checked per call
Implemented: capability = unforgeable token granting specific rights

┌──────────────┐     delegate      ┌──────────────┐
│  Parent Agent │───────────────────│  Child Agent  │
│  cap: full-fs │  attenuate to:   │  cap: read-fs │
│               │  read-only +     │  /workspace/** │
│               │  /workspace/**   │               │
└──────────────┘                   └──────────────┘

Properties:
  • Unforgeable — cannot be created, only delegated from a holder
  • Attenuable — can be narrowed (read+write → read-only) but never widened
  • Revocable — parent can revoke at any time via RevocationRegistry
  • Composable — multiple capabilities combine via intersection
```

**Implemented in `@koi/capability-verifier` (L2).** This replaces ambient authority
(checking "is this agent allowed?") with capability authority (the token IS the
permission). Aligns with seL4/UCAN/Fuchsia capability principles.

**`CapabilityProof` discriminated union** — three proof kinds:
- `hmac-sha256` — HMAC-SHA256 digest for root→engine internal auth (shared secret)
- `ed25519` — Ed25519 signature for agent-to-agent delegation chains (public key embedded)
- `nexus` — reserved for Nexus-issued tokens (v2, interface defined, no implementation yet)

**Session-scoped revocation** — `CapabilityToken.scope.sessionId` binds each token to a
session. When a session terminates, all tokens for that session become invalid without
modifying the registry. The verifier checks `VerifyContext.activeSessionIds` (a
`ReadonlySet<SessionId>`) on every call. Parent death = all child tokens invalid.

**Delegation chain integrity** — `verifyChain()` traverses the full `root → leaf` chain,
checking: each `chainDepth` matches position, child scope ⊆ parent scope (monotonic
attenuation), child `expiresAt` ≤ parent `expiresAt`. Batch revocation via optional
`RevocationRegistry.isRevokedBatch()` avoids N+1 async lookups for deep chains.

**Hybrid HMAC/Ed25519 signing:**
- Root→engine tokens: HMAC-SHA256 (shared secret, high-throughput)
- Agent-to-agent delegation: Ed25519 keypair (cryptographically unforgeable, no shared secret)

**Optional `requiresPoP?: boolean`** field reserved on `CapabilityToken` for v2
Proof-of-Possession challenge/response (not yet implemented).

See also: **Scoped Component Views** — the Linux namespace model for infrastructure
tokens (FILESYSTEM, BROWSER, CREDENTIALS, MEMORY) where each L2 consumer receives a
restricted proxy of the same backend.

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
Stage 1: STATIC           Stage 2: SANDBOX         Stage 3: SELF-TEST      Stage 4: TRUST
Schema validation          Execute in isolation      Run test cases          Assign trust tier
Bun.Transpiler.scan()      Timeout, memory limit    Pluggable verifiers     sandbox/verified/promoted
Name + syntax check        No network access        Health tracking starts
Size limits
```

Stage 1 uses Bun's native transpiler for zero-overhead syntax validation before any sandbox execution. Stage 3 pluggable verifiers enable custom verification logic per brick kind. After Stage 4, runtime health tracking (#251) monitors ongoing fitness.

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

### Brick Composition Algebra (#255, planned)

Bricks compose via category-theoretic operations — composition is type-safe and associative:

```
SEQUENTIAL:   brick_A >>> brick_B        (output of A feeds input of B)
PARALLEL:     brick_A ||| brick_B        (run both, merge results)
CONDITIONAL:  brick_A <|> brick_B        (try A, fallback to B)
LIFTING:      lift(tool) → middleware    (wrap a tool as middleware)

Properties (must hold for all compositions):
  (A >>> B) >>> C  ≡  A >>> (B >>> C)    associativity
  id >>> A         ≡  A                  left identity
  A >>> id         ≡  A                  right identity
```

This allows the forge to build complex bricks from simple ones with guaranteed composability. A composite brick's trust tier = minimum of its components' tiers.

### Brick Lifecycle

```
                          fitness signals
                          ┌──────────┐
                          ▼          │
DRAFT → VERIFYING → ACTIVE ─── DEPRECATED
              │        │ ▲
              ▼        │ │ remediation
           FAILED      ▼ │
                   QUARANTINED
                   (auto-demoted on
                    health failure)
```

`QUARANTINED` is set automatically when runtime health tracking detects repeated failures (see #259 bidirectional trust). Quarantined bricks can be remediated and returned to `ACTIVE`, or permanently `DEPRECATED`.

### Storage & Discovery

All forged brick artifacts are stored behind the `ForgeStore` L0 interface, with version history tracked by `SnapshotStore`. L2 implementations:

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

Each `BrickArtifact` carries a `contentHash` (SHA-256 hex digest) for integrity verification. `BrickSnapshot` records provenance with `BrickRef` + `BrickSource` tracking.

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

### The Evolution Loop

Koi's self-evolution is modeled on biological evolution: variation (forge), selection (fitness signals), inheritance (snapshots), and adaptation (bidirectional trust). The full loop:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SELF-EVOLUTION LOOP                                │
│                                                                      │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐  │
│   │  FORGE   │────►│ VERIFY   │────►│  DEPLOY  │────►│ OBSERVE  │  │
│   │ (vary)   │     │ (gate)   │     │ (select) │     │ (signal) │  │
│   └──────────┘     └──────────┘     └──────────┘     └─────┬────┘  │
│        ▲                                                     │      │
│        │           ┌──────────────────────────────────────────┘      │
│        │           │                                                 │
│        │           ▼                                                 │
│        │     ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│        │     │ FITNESS  │────►│ PROMOTE  │────►│  BUNDLE  │        │
│        │     │ (score)  │     │ or DEMOTE│     │ (absorb) │        │
│        │     └──────────┘     └─────┬────┘     └──────────┘        │
│        │                            │                                │
│        │    ┌───────────────────────┼───────────────────┐           │
│        │    ▼                       ▼                   ▼           │
│   ┌──────────┐           ┌──────────────┐      ┌────────────┐      │
│   │QUARANTINE│           │  CRYSTALLIZE │      │ DEPRECATE  │      │
│   │(isolate) │           │(auto-forge)  │      │ (retire)   │      │
│   └──────────┘           └──────────────┘      └────────────┘      │
│                                                                      │
│   Theory: autopoiesis + Red Queen + punctuated equilibrium           │
│   Issues: #249-#261                                                  │
└─────────────────────────────────────────────────────────────────────┘
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

### Bidirectional Trust Lifecycle

Trust is **earned AND lost**. Unlike traditional systems where promotion is one-way, Koi bricks can be demoted based on runtime health signals (Red Queen hypothesis — you must keep running just to stay in place):

```
                    HITL approve        usage threshold
                   ┌───────────┐       ┌───────────┐
                   │           ▼       │           ▼
              ┌─────────┐  ┌──────────┐  ┌──────────┐
              │ SANDBOX │  │ VERIFIED │  │ PROMOTED │
              └────┬────┘  └────┬─────┘  └────┬─────┘
                   ▲            ▲              │
                   │            │              │
                   │     health failure        │
                   │     ┌─────┘    ┌──────────┘
                   │     │          │ trust score decay
                   │     ▼          ▼
              ┌────┴──────────────────┐
              │     QUARANTINED       │
              │  (auto-demotion on    │
              │   health failure)     │
              └───────────────────────┘
                        │
              remediation + re-verify
                        │
                        ▼
                   back to SANDBOX
                   (must re-earn trust)

Trust score = f(success_rate, latency_p99, error_rate, usage_count)
Decay: score decays over time without positive signals
Demotion trigger: score < tier_threshold for sustained period
```

This ensures the system never accumulates stale promoted bricks — every brick must continuously prove its fitness. Implemented via #259 (bidirectional trust demotion) and #251 (fitness signals).

### Fitness Signals & Natural Selection (#251)

Bricks compete for survival based on runtime fitness — the system is a market, not a museum:

```
┌──────────────────────────────────────────────────────────────────┐
│                   BRICK FITNESS SIGNALS                           │
│                                                                   │
│  Per-brick health tracking (HealthMonitor):                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ success_rate│  │ latency_p99 │  │ error_rate  │              │
│  │ (calls/ok)  │  │ (ms)        │  │ (calls/err) │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          ▼                                        │
│                  ┌──────────────┐                                 │
│                  │ FITNESS SCORE│ = weighted composite             │
│                  └──────┬───────┘                                 │
│                         │                                         │
│              ┌──────────┼──────────┐                              │
│              ▼          ▼          ▼                              │
│         score > 0.9  0.5–0.9   score < 0.5                       │
│         ┌────────┐ ┌────────┐ ┌────────────┐                    │
│         │PROMOTE │ │ ACTIVE │ │ QUARANTINE │                    │
│         │candidate│ │ (ok)   │ │ + DEMOTE   │                    │
│         └────────┘ └────────┘ └────────────┘                    │
│                                                                   │
│  When multiple bricks serve same purpose:                         │
│  → highest fitness wins resolver priority (natural selection)     │
│  → low-fitness bricks deprecated automatically                   │
│  → crystallization detects repeated patterns, forges optimized    │
│    replacements (punctuated equilibrium, #258)                   │
└──────────────────────────────────────────────────────────────────┘
```

### Immutable Snapshot Chain

Every brick change produces a new immutable `BrickSnapshot` via the `SnapshotStore`. Snapshots are per-brick (not per-agent), tracking individual brick provenance and version history.

```
brick:calculator
  snap-0 (created, source: forged, by: agent-123)
   └→ snap-1 (updated — new implementation)
       └→ snap-2 (promoted — scope: agent → zone)
           └→ snap-3 (quarantined — fitness < threshold)
               └→ snap-4 (updated — bug fixed, back to active)
```

Snapshot events: `created`, `updated`, `promoted`, `deprecated`, `quarantined`. Each snapshot records the `BrickSource` (forged, bundled, imported, composed), the actor, and a `BrickRef` with content hash.

Operations on the chain:

```
record(snap)    → append a new snapshot
get(snapId)     → retrieve a specific snapshot
latest(brickId) → most recent snapshot for a brick
history(brickId)→ full chain from creation to now
list(query)     → search snapshots by brick, event type, time range
```

Snapshots are append-only — quarantine doesn't delete history, it adds a new snapshot event. Like git, you can always see the full provenance chain.

### Graduation Pipeline

Changes start as local experiments. Proven ones graduate into the base:

```
FORGE (instant, local, zero cost)
  → Agent shadows tool:search with v2. Only this agent affected.

OBSERVE (runtime, automatic)
  → Health tracking starts immediately after deploy.
  → Fitness score computed from success rate, latency, error rate.

PROMOTE (fitness-gated + HITL for zone/global)
  → Agent: "tool:search-v2 has 98% success over 500 calls, promote?"
  → Fitness score must exceed tier threshold
  → Human approves → available to zone/all agents

DEMOTE (automatic on health failure)
  → Fitness score drops below threshold → auto-quarantine
  → Snapshot records the demotion event
  → Agent falls back to previous version via resolver chain

BUNDLE (next binary release)
  → CI collects proven promoted forges, absorbs into base packages.
  → Builds new binary. Ships via self-update.

CLEAN (forge layer thins out)
  → Graduated forges removed from forge store — they're in bundled now.
  → Only active experiments remain.
```

The binary is a snapshot of "everything proven so far." The forge layer is where evolution happens.

### Demand-Triggered Forge (#258)

Not all forging is agent-initiated. The system also forges in response to environmental pressure (punctuated equilibrium):

```
Environmental trigger              System response
─────────────────────              ───────────────
Tool call fails repeatedly    →    Auto-forge fallback tool
New API version detected      →    Crystallize adapter update
Usage pattern crystallizes    →    Auto-forge optimized composite
Brick quarantined             →    Trigger replacement search
```

The crystallization middleware observes tool sequences and auto-forges when confidence is high enough. Combined with fitness signals, this creates a system that adapts to changing conditions without explicit human intervention.

### Supervision Trees (#257)

Agent crash recovery uses Erlang/OTP-style supervision, not naive snapshot restoration:

```
┌────────────────────────────────────────────────────────┐
│              SUPERVISION TREE                            │
│                                                          │
│              ┌──────────────┐                            │
│              │  SUPERVISOR  │ (one_for_one strategy)     │
│              │  max_restarts│                            │
│              │  per_period  │                            │
│              └──────┬───────┘                            │
│           ┌─────────┼─────────┐                          │
│           ▼         ▼         ▼                          │
│     ┌──────────┐┌──────────┐┌──────────┐                │
│     │ Agent₁   ││ Agent₂   ││ Agent₃   │                │
│     │ (worker) ││ (worker) ││ (copilot)│                │
│     └──────────┘└──────────┘└──────────┘                │
│                                                          │
│  Restart strategies:                                     │
│  ─────────────────                                       │
│  one_for_one : only crashed child restarts               │
│  one_for_all : all children restart (consistent state)   │
│  rest_for_one: crashed + all started after it restart    │
│                                                          │
│  Escalation:                                             │
│  ───────────                                             │
│  Child fails → supervisor restarts (up to max_restarts)  │
│  Supervisor exhausts budget → escalate to parent         │
│  Root supervisor exhausts → system enters degraded mode  │
│                                                          │
│  Recovery flow:                                          │
│  ──────────────                                          │
│  Agent crashes → supervisor catches                      │
│    → restore from latest healthy snapshot                 │
│    → re-attach components                                │
│    → quarantine offending brick if identified             │
│    → resume from last checkpoint                         │
│    → if repeated: escalate + circuit break               │
└────────────────────────────────────────────────────────┘
```

This replaces the naive "try previous snapshot" approach with structured fault tolerance. The supervision tree provides:
- **Isolation**: one child's failure doesn't take down siblings
- **Budget-based escalation**: local recovery before global intervention
- **Automatic quarantine**: identify and isolate the offending brick
- **Graceful degradation**: system operates in reduced capacity, doesn't hard-crash

### Reconciliation Controllers (#253)

K8s-inspired desired-state reconciliation ensures the system converges to its intended configuration:

```
┌─────────────────────────────────────────────────────────┐
│             RECONCILIATION LOOP                           │
│                                                           │
│   ┌──────────────┐         ┌──────────────┐              │
│   │ DESIRED STATE│         │ ACTUAL STATE │              │
│   │ (manifest +  │         │ (registry +  │              │
│   │  config)     │         │  runtime)    │              │
│   └──────┬───────┘         └──────┬───────┘              │
│          │                        │                       │
│          └────────┬───────────────┘                       │
│                   ▼                                       │
│          ┌──────────────┐                                │
│          │     DIFF     │  desired vs actual              │
│          └──────┬───────┘                                │
│                 │                                         │
│       ┌─────────┼─────────┐                              │
│       ▼         ▼         ▼                              │
│   missing    drifted   extra                             │
│   component  config    component                         │
│       │         │         │                              │
│       ▼         ▼         ▼                              │
│   attach()  update()  detach()                           │
│                                                           │
│   Loop runs continuously via AgentRegistry.watch()        │
│   Convergence, not scripted steps                         │
└─────────────────────────────────────────────────────────┘
```

Reconciliation controllers react to registry events and drive the system toward desired state. This is the same pattern that makes Kubernetes self-healing — the system doesn't follow a script, it converges to a declaration.

### Unified Governance (#261)

All governance concerns (spawn limits, forge budgets, trust thresholds, resource quotas) converge into a single homeostatic controller:

```
┌─────────────────────────────────────────────────────────┐
│            GOVERNANCE CONTROLLER                          │
│            (homeostasis — maintaining equilibrium)         │
│                                                           │
│   Inputs (sensors):              Outputs (actuators):     │
│   ┌───────────────┐             ┌───────────────┐        │
│   │ spawn count   │────────────►│ spawn limits  │        │
│   │ forge budget  │────────────►│ forge quota   │        │
│   │ trust scores  │────────────►│ trust gates   │        │
│   │ resource usage│────────────►│ resource caps │        │
│   │ error rates   │────────────►│ circuit break │        │
│   └───────────────┘             └───────────────┘        │
│                                                           │
│   The controller maintains system-wide invariants:        │
│   • Total spawns ≤ tree capacity (SpawnLedger)           │
│   • Forge rate ≤ session budget                           │
│   • Trust never exceeds evidence                          │
│   • Resources never exceed allocation                     │
│                                                           │
│   Single source of truth, not scattered middleware.       │
│   Middleware reads from governance, doesn't own policy.   │
└─────────────────────────────────────────────────────────┘
```

### Proposal Interface (planned)

The proposal system for L0/L1 changes is planned but not yet implemented in `@koi/core`. When implemented, it will formalize the trust gate for cross-layer modifications:

- `Proposal` — identifies target layer, change kind, deploy mode, and approval status
- `ProposalGate` — submit/review interface for HITL approval workflows

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

7 optional hooks on `KoiMiddleware`, ordered by `priority` (lower = outer), with a `phase` annotation for semantic grouping:

| Hook | Hook type | Signature |
|------|-----------|-----------|
| `onSessionStart` | Session lifecycle | `(ctx: SessionContext) => Promise<void>` |
| `onSessionEnd` | Session lifecycle | `(ctx: SessionContext) => Promise<void>` |
| `onBeforeTurn` | Turn lifecycle | `(ctx: TurnContext) => Promise<void>` |
| `onAfterTurn` | Turn lifecycle | `(ctx: TurnContext) => Promise<void>` |
| `wrapModelCall` | Onion interposition | `(ctx, req, next) => Promise<ModelResponse>` |
| `wrapModelStream` | Onion interposition | `(ctx, req, next) => AsyncIterable<ModelChunk>` |
| `wrapToolCall` | Onion interposition | `(ctx, req, next) => Promise<ToolResponse>` |

Lifecycle hooks (`onSession*`, `onBefore/AfterTurn`) run sequentially. Onion hooks (`wrap*`) compose as nested middleware chains with double-call detection.

**Phase annotation** (`phase: "INTERCEPT" | "OBSERVE" | "RESOLVE"`) — declares the middleware's role in the chain. INTERCEPT gates execution (runs BEFORE), OBSERVE reads results (runs AFTER), RESOLVE transforms data. Governance runs before autonomous actions; context-arena runs after (respects pinned messages); audit sees everything.

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

┌─────────────────────────────────────────────────────────────────────┐
│                  RESEARCH ISSUE DEPENDENCIES                         │
│                                                                      │
│  FOUNDATIONS (implement first):                                      │
│  ┌─────────────────┐    ┌─────────────────┐                         │
│  │ #249 Watch      │    │ #250 Content-   │                         │
│  │ Semantics       │    │ Addressed       │                         │
│  │ (etcd/K8s)      │    │ BrickId         │                         │
│  └────────┬────────┘    │ (git/Nix/IPFS)  │                         │
│           │             └────────┬────────┘                         │
│           │                      │                                   │
│  SELECTION LAYER (depends on foundations):                            │
│           │                      │                                   │
│           ▼                      ▼                                   │
│  ┌─────────────────┐    ┌─────────────────┐                         │
│  │ #253 Reconcil-  │    │ #251 Fitness    │                         │
│  │ iation Control- │    │ Signals         │                         │
│  │ lers (K8s)      │    │ (natural        │                         │
│  └────────┬────────┘    │  selection)     │                         │
│           │             └────────┬────────┘                         │
│           │                      │                                   │
│  ADAPTATION LAYER (depends on selection):                            │
│           │                      │                                   │
│           ▼                      ▼                                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │ #257 Supervision│    │ #259 Bidirection│    │ #258 Demand-    │  │
│  │ Trees           │    │ Trust Demotion  │    │ Triggered Forge │  │
│  │ (Erlang/OTP)    │    │ (Red Queen)     │    │ (punctuated eq.)│  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
│                                                                      │
│  INDEPENDENT (can implement in any order):                           │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐       │
│  │ #252 Capability │ │ #254 Stigmergic │ │ #255 Brick      │       │
│  │ Tokens          │ │ Coordination    │ │ Composition     │       │
│  │ (seL4/Fuchsia)  │ │ (ant colonies)  │ │ Algebra         │       │
│  └─────────────────┘ └─────────────────┘ │ (category thy.) │       │
│                                           └─────────────────┘       │
│  ┌─────────────────┐ ┌─────────────────┐                            │
│  │ #260 Required   │ │ #261 Unified    │                            │
│  │ Test Cases      │ │ Governance      │                            │
│  │ (CDGP auto-gen) │ │ (homeostasis)   │                            │
│  └─────────────────┘ └─────────────────┘                            │
│                                                                      │
│  Theory basis:                                                       │
│  ────────────                                                        │
│  #249,#253     — distributed systems (etcd watch, K8s reconcile)    │
│  #250          — content-addressable storage (git, Nix, IPFS)       │
│  #251,#258,#259— biological evolution (fitness, punctuated eq.)     │
│  #252          — capability-based security (seL4, Fuchsia)          │
│  #254          — emergent coordination (stigmergy, ant colonies)    │
│  #255          — formal composition (category theory, monoids)      │
│  #257          — fault tolerance (Erlang/OTP supervision)           │
│  #260          — program synthesis (CDGP, counterexample-driven)    │
│  #261          — homeostasis (biological equilibrium maintenance)   │
└─────────────────────────────────────────────────────────────────────┘
```

### Placement by Workstream

| Issue | Workstream | Layer Impact |
|-------|------------|-------------|
| #249 Universal watch | WS1 Kernel | L0 (contract) + L1 (implementation) |
| #250 Content-addressed BrickId | WS1 Kernel | L0 (type change) |
| #251 Fitness signals | WS3 Forge | L2 (HealthMonitor + forge governance) |
| #252 Capability tokens | WS4 Security | L0 (contract) + L2 (implementation) |
| #253 Reconciliation controllers | WS1 Kernel | L1 (controllers) |
| #254 Stigmergic coordination | WS3 Forge | L2 (middleware) |
| #255 Brick composition algebra | WS3 Forge | L0 (type) + L2 (implementation) |
| #257 Supervision trees | WS1 Kernel | L1 (supervisor runtime) |
| #258 Demand-triggered forge | WS3 Forge | L2 (crystallization middleware) |
| #259 Bidirectional trust demotion | WS3 Forge | L2 (health → trust pipeline) |
| #260 Required test cases | WS3 Forge | L0 (contract) + L2 (CDGP generator) |
| #261 Unified governance | WS1 Kernel | L1 (controller) + L2 (middleware) |

### Unifying Insight

All 12 issues derive from one insight: **interfaces are all you need**. Every L0 contract is a composable expression that can evaluate itself. The research roadmap extends this from static composition (current) to dynamic, fitness-driven, self-healing composition (target):

```
CURRENT:  manifest → assembly → static components → run
TARGET:   manifest → assembly → observe → adapt → evolve → converge
```

The system doesn't just assemble agents — it grows them, tests them under selection pressure, and converges toward optimal configurations. The binary improves itself.
