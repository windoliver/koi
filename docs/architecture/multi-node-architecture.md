# Multi-Node Agent Architecture

How the multi-node packages connect: registry, events, IPC, pay, memory, node, and gateway.

---

## Concepts

| Concept | What it is |
|---------|-----------|
| **Node** | A running Koi process. One machine can run one node. Multiple nodes form a cluster. Comes in two modes: **Full** (hosts agents + tools) or **Thin** (tools only, no agents). |
| **Full Node** | A node that hosts agents. Has `dispatch()`, `terminate()`, capacity management, checkpointing, memory monitoring. Runs engines. |
| **Thin Node** | A node that exposes tools only. No agents, no engines. Example: a Raspberry Pi exposing `camera.capture` to the cluster. |
| **Gateway** | WebSocket control plane. Nodes connect to it. Routes tool calls between nodes, manages sessions, tracks node capabilities. Does NOT create agents — just routes frames. |
| **Agent** | A single AI entity with a manifest, tools, and middleware. Runs inside a full node. Has a lifecycle: created → running → waiting → terminated. |
| **Registry** | A shared process table. Tracks which agents are alive, on which node, in what state. Consumed by `@koi/node` (L2). |
| **Event** | An immutable fact that something happened. Has a type, timestamp, sequence number, and payload. Once appended, never modified. |
| **Stream** | An ordered sequence of events, identified by a streamId (e.g., `agent:worker-1`). Append-only. Like a single-topic log. |
| **EventBackend** | The L0 contract for durable event streams. Append events, read ranges, subscribe for real-time delivery, dead-letter failed deliveries. |
| **Projection** | Current state derived by folding (replaying) all events in a stream through a pure function. Not stored — computed on demand or cached in memory. |
| **Fold** | A pure function: `(state, event) → newState`. Applied sequentially to every event in a stream to produce the current projection. Deterministic — same events always produce same state. |
| **Nexus** | A remote distributed filesystem accessed via JSON-RPC 2.0. Supports `read`, `write`, `delete`, `glob`. Shared across nodes. The transport layer. |
| **L0 Contract** | A TypeScript interface in `@koi/core`. Zero logic, zero deps. Defines what a component can do, not how. |
| **L1 Engine** | The kernel runtime (`@koi/engine`). Agent assembly, middleware composition, guards. Doesn't know which L2 is plugged in. |
| **L2 Package** | A feature package that consumes/implements L0 contracts. Swappable via dependency injection. Imports only from L0 and L0u utilities, never from L1 or peer L2. |
| **DI** | Dependency injection. L2 receives L0 contracts through constructor/factory params. Codes against the interface, caller picks the implementation. |
| **CAS** | Compare-and-swap. Optimistic concurrency: "update this only if the current generation/sequence matches what I expect." Fails with CONFLICT if stale. |
| **Manifest** | A YAML file that declares WHAT an agent is: name, model, tools, channels, middleware, permissions. The agent's "birth certificate." Does not declare infrastructure wiring. |
| **Mailbox** | An agent's inbox for receiving messages from other agents. L0 contract: `send()`, `onMessage()`, `list()`. Agents use it for request/response, events, and cancellation. |
| **IPC** | Inter-process communication. Agent-to-agent messaging. One agent sends a message to another agent's mailbox by agentId. Polling-based delivery with exponential backoff. |
| **PayLedger** | L0 contract for credit management. `getBalance()`, `canAfford()`, `transfer()`, `reserve()`, `commit()`, `release()`, `meter()`. Tracks spending across sessions. |
| **CostCalculator** | Interface in middleware-pay. Computes USD cost from model + token counts. `calculate(model, inputTokens, outputTokens) → number`. Pluggable per-model rates. |
| **MemoryComponent** | L0 contract for agent memory. `recall(query, options?) → MemoryResult[]`, `store(content, options?) → void`. Plus `MEMORY` ECS token. Tier-aware: results carry hot/warm/cold + decayScore. |
| **MemoryFact** | Internal to memory-fs. Atomic fact with id, category, status (active/superseded), relatedEntities, lastAccessed, accessCount, causalParents/Children. Never deleted — superseded facts form a history chain. |
| **NodeFrame** | Wire protocol between nodes and gateway. Kinds: `node:handshake`, `node:capabilities`, `node:heartbeat`, `tool_call`, `tool_result`, `agent:message`, etc. |
| **GatewayFrame** | Wire protocol between clients and gateway. Kinds: `request`, `response`, `event`, `ack`, `error`. |

---

## Manifest vs. code — wiring table

```
┌───────────────────────────┬────────────┬─────────────────────────────┐
│ Package                   │ In manifest│ How it's wired              │
├───────────────────────────┼────────────┼─────────────────────────────┤
│ @koi/gateway              │ No         │ createGateway(config, deps) │
│                           │            │ Standalone server process   │
│ @koi/node                 │ No         │ createNode(config,          │
│                           │            │   { registry? })            │
│                           │            │ mode: "full" or "thin"      │
│ registry-nexus            │ No         │ createNode(config,{registry})│
│ registry-event-sourced    │ No         │ createNode(config,{registry})│
│ events-nexus              │ No         │ injected into registry-     │
│                           │            │ event-sourced as dependency │
│ ipc-nexus                 │ No         │ createKoi({providers:       │
│                           │            │   [ipcNexusProvider]})      │
│                           │            │ Optional: registry param    │
│                           │            │   enables ipc_discover tool │
│ @koi/filesystem           │ No         │ Code: createKoi({providers: │
│                           │            │   [fsProvider]})            │
│                           │            │ createFileSystemProvider({  │
│                           │            │   backend, retriever?,     │
│                           │            │   scope? })                │
│                           │            │                            │
│                           │            │ Backend implementations:   │
│                           │            │   Local: Bun.file() based  │
│                           │            │   Nexus: filesystem-nexus  │
│                           │            │     (#673) JSON-RPC ops    │
│                           │            │                            │
│                           │            │ Tools exposed to agent:    │
│                           │            │   fs_read, fs_write,       │
│                           │            │   fs_edit, fs_list,        │
│                           │            │   fs_search (grep),        │
│                           │            │   fs_semantic_search (#666)│
│                           │            │                            │
│                           │            │ With Nexus backend, free:  │
│                           │            │   semantic search (indexes │
│                           │            │     on write via search-   │
│                           │            │     nexus Retriever)       │
│                           │            │   per-file permissions     │
│                           │            │     (NexusScopeEnforcer +  │
│                           │            │     ReBAC tuples)          │
│                           │            │   cross-agent sharing      │
│                           │            │     (delegation #671 writes│
│                           │            │     tuples → enforcer)     │
│                           │            │   shared across nodes      │
│                           │            │                            │
│                           │            │ Security (4 layers, auto): │
│                           │            │   1. scope: root + rw/ro   │
│                           │            │   2. enforcer: per-file    │
│                           │            │      ReBAC via Nexus       │
│                           │            │   3. permissions: tool deny│
│                           │            │   4. governance: policy    │
│                           │            │                            │
│                           │            │ L3 bundle (#673):          │
│                           │            │ createNexusWorkspaceStack()│
│                           │            │   wires all of the above   │
│                           │            │   in one call.             │
│                           │            │                            │
│ memory-fs                 │ Yes        │ Code: createKoi({providers: │
│                           │            │   [memoryProvider]})       │
│                           │            │ OR via context-arena (L3)  │
│                           │            │ baseDir: caller decides    │
│                           │            │                            │
│                           │            │ Manifest (for skill +      │
│                           │            │ memory hydration):         │
│                           │            │ context:                   │
│                           │            │   sources:                 │
│                           │            │   - kind: skill            │
│                           │            │     name: memory           │
│                           │            │   - kind: memory           │
│                           │            │     query: "user context"  │
│ context-arena             │ Hybrid     │ L3 bundle. Auto-wires:     │
│                           │            │   memory-fs provider       │
│                           │            │   tool-squash (priority220)│
│                           │            │   compactor   (priority225)│
│                           │            │   ctx-editing (priority250)│
│                           │            │   context hydrator   
@koi/middleware-preference      │
│                           │            │                            │
│                           │            │ Manifest controls:         │
│                           │            │   middleware:              │
│                           │            │   - name: context-arena   │
│                           │            │     options:              │
│                           │            │       preset: balanced    │
│                           │            │       contextWindowSize:  │
│                           │            │         200000            │
│                           │            │                            │
│                           │            │ Code provides (runtime):   │
│                           │            │   summarizer (LLM fn)     │
│                           │            │   sessionId               │
│                           │            │   getMessages (fn)        │
│                           │            │   memoryFs config         │
│                           │            │   hydrator config         │
│                           │            │ Gap: no search wiring     │
│                           │            │   (retriever/indexer not  │
│                           │            │    passed to memory-fs)   │
│                           │            │   See issue #664          │
│ agent-procfs              │ No         │ Sidecar — NOT in createKoi │
│                           │            │ createProcFs(config?)      │
│                           │            │ createAgentMounter({       │
│                           │            │   registry, procFs,         │
│                           │            │   agentProvider })          │
│                           │            │ Watches registry events.   │
│                           │            │ Auto-mounts 7 entries per  │
│                           │            │ agent. No backend. In-mem. │
│                           │            │ Consumes:                  │
│                           │            │   AgentRegistry (L0) watch │
│                           │            │   Agent entity (L0) ECS    │
│                           │            │                            │
│ scheduler                 │ No         │ Sidecar — NOT in createKoi │
│                           │            │ createScheduler(config,    │
│                           │            │   store, queueBackend)     │
│                           │            │ Cron (croner, IANA tz).    │
│                           │            │ Delay, retry, dead-letter. │
│                           │            │ Queue backend: local heap  │
│                           │            │   + SQLite (dev) or Nexus  │
│                           │            │   scheduler API (prod).    │
│                           │            │ Nexus dispatches via IPC.  │
│                           │            │                            │
│ scheduler-provider        │ No         │ createKoi({providers:      │
│                           │            │   [schedulerProvider]})     │
│                           │            │ Wraps TaskScheduler (L0).  │
│                           │            │ 9 tools (agent-scoped):    │
│                           │            │   submit, cancel, schedule,│
│                           │            │   unschedule, pause,       │
│                           │            │   resume, query, stats,    │
│                           │            │   history.                 │
│                           │            │ Agent sees only own tasks. │
│                           │            │                            │
│ middleware-pay             │ Yes        │ createKoi({middleware:      │
│                           │            │   [payMiddleware]})         │
│                           │            │ OR manifest: middleware:    │
│                           │            │   [{name: "pay"}]          │
│ pay-nexus                 │ No         │ Backend for PayLedger (L0). │
│                           │            │ createNexusPayLedger()     │
│                           │            │ Injected into middleware-  │
│                           │            │ pay (or future consumers)  │
│ middleware-permissions     │ Yes        │ manifest: permissions:     │
│                           │            │   { allow, deny, ask }     │
│                           │            │ Backend: pattern (default) │
│                           │            │   or Nexus ReBAC (code)    │
│ @koi/scope                │ Yes        │ manifest: scope:           │
│                           │            │   { filesystem, browser,   │
│                           │            │     credentials, memory }  │
│                           │            │ Wraps raw backends with    │
│                           │            │ scoped boundaries          │
│ permissions-nexus          │ No         │ Backend for PermissionBack-│
│                           │            │ end + ScopeEnforcer (L0).  │
│                           │            │ Injected into middleware-  │
│                           │            │ permissions or scope.      │
│ delegation                │ No         │ DelegationManager created  │
│                           │            │ in code. Middleware wired  │
│                           │            │ via governance bundle.     │
│                           │            │                            │
│                           │            │ DelegationComponentProvider │
│                           │            │ (planned #671):            │
│                           │            │ Tools exposed to agent:    │
│                           │            │   delegation_grant         │
│                           │            │   delegation_revoke        │
│                           │            │   delegation_list          │
│                           │            │                            │
│                           │            │ onGrant/onRevoke hooks on  │
│                           │            │ DelegationManager — DI     │
│                           │            │ seam for Nexus bridge.     │
│                           │            │ Consumer: governance (L3). │
│                           │            │                            │
│                           │            │ Spawn: auto-attenuated     │
│                           │            │ grant from parent → child. │
│                           │            │ Co-pilot: explicit grant.  │
│ @koi/governance (L3)      │ Hybrid     │ createGovernanceStack()    │
│                           │            │ bundles up to 8 middleware.│
│                           │            │ Manifest: permissions +    │
│                           │            │   scope sections.          │
│                           │            │ Code: backends, handlers.  │
│                           │            │                            │
│ verified-loop             │ No         │ Orchestrator — wraps L1.   │
│ (L0u)                     │            │ createVerifiedLoop(config) │
│                           │            │ External verification loop │
│                           │            │ Each iteration: fresh Koi  │
│                           │            │   runtime, clean context.  │
│                           │            │ PRD file = task list.      │
│                           │            │ Gate = objective check.    │
│                           │            │ Learnings = rolling journal│
│                           │            │ Stuck-loop: skip after 3   │
│                           │            │   consecutive gate fails.  │
│                           │            │ Consumer injects:          │
│                           │            │   RunIterationFn (engine)  │
│                           │            │   VerificationFn (gate)    │
│                           │            │   iterationPrompt (prompt) │
│                           │            │ Zero external deps.        │
└───────────────────────────┴────────────┴─────────────────────────────┘

Manifest-visible packages:
  middleware-pay — middleware section
  middleware-permissions — permissions section (allow/deny/ask rules)
  @koi/scope — scope section (filesystem/browser/credentials/memory)
  memory-fs — context.sources declares skill + memory hydration
  context-arena — manifest declares context sources, code wires the bundle
  @koi/governance — bundles security middleware, manifest provides rules

Manifest context.sources (5 kinds):
  kind: text       — static text injected into system prompt
  kind: file       — file content loaded at session start
  kind: memory     — recall memories matching a query at session start
  kind: skill      — load skill behavioral instructions from agent components
  kind: tool_schema— include tool schemas in context

The skill injection chain (10 steps):
  1. createMemoryProvider attaches SkillComponent via skillToken("memory")
  2. Engine assembles agent — component map has key "skill:memory"
  3. Manifest declares: context.sources: [{ kind: skill, name: memory }]
  4. Context hydrator (L2 middleware) queries agent.query("skill:")
  5. Finds "skill:memory" → extracts .content (behavioral instructions)
  6. wrapModelCall() prepends as system message on EVERY model request
  Without the manifest context.sources declaration, the skill is attached
  but never injected into the prompt. Both are needed.

All others are code-level wiring.
Gateway is a standalone server — nodes connect to it.
Registry/events are invisible infra consumed by @koi/node.
IPC is wired as a ComponentProvider — attaches mailbox + tools to the agent.
pay-nexus is the backend — injected into middleware-pay (or future consumers) via DI.
```

---

## Overall system diagram

```
                        ┌─────────────────────────────────┐
                        │          GATEWAY (L2)            │
                        │        @koi/gateway              │
                        │                                  │
                        │  Node registry (who's connected) │
                        │  Tool routing (affinity, capacity)│
                        │  Session management (resume, TTL)│
                        │  Frame dedup + backpressure      │
                        │  Webhook ingestion               │
                        │  Signal routing:                 │
                        │    signalAgent → agent:signal    │
                        │    signalGroup → agent:signal_   │
                        │      group (fan-out to nodes)    │
                        │    waitForAgent → agent:status   │
                        └──────┬──────────────┬────────────┘
                               │ WebSocket    │ WebSocket
                               │              │
              ┌────────────────┘              └────────────────┐
              │                                                │
              ▼                                                ▼
┌──────────────────────────────┐          ┌──────────────────────────────┐
│      FULL NODE (L2)          │          │      THIN NODE (L2)          │
│      @koi/node               │          │      @koi/node               │
│      mode: "full"            │          │      mode: "thin"            │
│                              │          │                              │
│  Agent host:                 │          │  No agents.                  │
│    dispatch, terminate       │          │  No engines.                 │
│    capacity, memory monitor  │          │  Tools only.                 │
│  Checkpoint + recovery       │          │                              │
│  Agent inbox (100-msg ring)  │          │  Exposes local tools         │
│  Delivery manager (retry)    │          │  to the cluster.             │
│  Status reporter             │          │                              │
│  Signals (via gateway):      │          │                              │
│    STOP/CONT/TERM/USR1/USR2 │          │                              │
│    Process groups + fan-out  │          │                              │
│  Filesystem (per-agent):     │          │                              │
│    local or Nexus backend    │          │                              │
│    scoped root + rw/ro mode  │          │                              │
│    fs_semantic_search (#666) │          │                              │
│  Tool resolver               │ tool_call│  Tool resolver               │
│                              │◄─────────│                              │
│  ┌────────────────────────┐  │ via GW   │  ┌────────────────────────┐  │
│  │ Agent 1 (createKoi)    │  │          │  │ camera.capture         │  │
│  │ Agent 2 (createKoi)    │  │          │  │ sensor.read            │  │
│  │ Agent 3 (createKoi)    │  │          │  │ gpio.toggle            │  │
│  └───────────┬────────────┘  │          │  └────────────────────────┘  │
│              │               │          │                              │
└──────────────┼───────────────┘          └──────────────────────────────┘
               │
               │ Each agent is assembled from L2 middleware + providers.
               │ The AUTONOMOUS LAYER (#684, #687, #688) adds:
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  AUTONOMOUS LAYER (L2 middleware + providers, bundled in L3)             │
│                                                                          │
│  ┌─ Thread + Persistence (#684) ───────────────────────────────────────┐ │
│  │ ThreadStore (L0 contract, SQLite or Nexus backend)                  │ │
│  │ Auto-checkpoint at turn boundaries                                  │ │
│  │ Engine inbox: queue modes (collect, steer, followup, interrupt)     │ │
│  │ Pinned messages survive compaction                                  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Agent Lifecycle (#687) ────────────────────────────────────────────┐ │
│  │ "idle" ProcessState: agent alive between tasks, accepting messages  │ │
│  │ Worker pool: acquire(type) → reuse warm agent, evict after TTL     │ │
│  │ Auto-create copilot: recurring task → persistent agent + thread    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Autonomous Middleware (#684) ──────────────────────────────────────┐ │
│  │ Always injected, idle by default, zero overhead on "hello"         │ │
│  │ Agent self-escalates via plan_autonomous() tool                    │ │
│  │ task_complete() + verified-loop gates for objective verification   │ │
│  │ Context bridge: pinned resume messages across sessions             │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Delegation ────────────────────────────────────────────────────────┐ │
│  │ parallel-minions: fan-out N tasks (best-effort/fail-fast/quorum)   │ │
│  │ task-spawn:       single task + copilot routing (findLive/spawn)   │ │
│  │ orchestrator:     DAG board + dependency tracking + maxConcurrency │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Forge Evolution (#688) ────────────────────────────────────────────┐ │
│  │ forge_agent/tool: LLM creates bricks → 4-stage verification       │ │
│  │ Fitness tracking: successRate² × recency × usage × latency        │ │
│  │ Variant selection: N implementations per capability, pick by score │ │
│  │ Demand detection: capability_gap → auto-forge new agent/tool      │ │
│  │ Demotion/quarantine: bad variant → lower trust → stop using       │ │
│  │ ForgeAgentResolver: catalog query → variant select → instantiate  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  Bundled by @koi/autonomous (L3):                                        │
│    createAutonomousStack({ preset: "minimal"|"standard"|"verified"|     │
│      "full", threadStore, gates?, parallelConfig?, taskSpawnConfig? })   │
│    Returns: { middleware[], providers[], dispose() }                      │
│    Follows same pattern as @koi/governance presets.                       │
└──────────────────────────────────────────────────────────────────────────┘

Agents run via createKoi (L1).
Nodes run via createNode (L2).
Gateway routes frames between nodes.
Neither createKoi nor createNode call each other — the caller wires them.
The autonomous layer is middleware + providers injected into createKoi.
It does NOT modify L1 or the node — it composes on top via standard hooks.
```

---

## The packages + contracts

```
L0 CONTRACTS (interfaces in @koi/core, zero logic)
══════════════════════════════════════════════════

  ┌──────────────────────────────────────────────────────────────┐
  │ EventBackend                                                 │
  │ "Append-only durable event streams with subscriptions"       │
  │  append, read, subscribe, deadLetter                         │
  └──────────────────────────────┬───────────────────────────────┘
                                 │ consumed by: registry-event-sourced
                                 │
  ┌──────────────────────────────┼───────────────────────────────┐
  │ AgentRegistry                │                               │
  │ "Agent lifecycle management" │                               │
  │  register, lookup, list,     │                               │
  │  transition, watch, rebuild  │                               │
  │  + groupId on RegistryEntry  │                               │
  │  + list({ groupId }) filter  │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ consumed by: @koi/node,
                 │               │   registry-nexus,
                 │               │   registry-event-sourced,
                 │               │   ipc-nexus (optional, for ipc_discover),
                 │               │   group-operations (L1, for signalGroup)
  ┌──────────────┼───────────────┼───────────────────────────────┐
  │ MailboxComponent             │                               │
  │ "Agent-to-agent messaging"   │                               │
  │  send, onMessage, list       │                               │
  │  + MAILBOX token (ECS)       │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ consumed by: ipc-nexus
                 │               │
  ┌──────────────┼───────────────┼───────────────────────────────┐
  │ PayLedger                    │                               │
  │ "Credit management and       │                               │
  │  usage metering"             │                               │
  │  getBalance, canAfford,      │                               │
  │  transfer, reserve, commit,  │                               │
  │  release, meter              │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ implemented by: pay-nexus
                 │               │ consumed by: middleware-pay (meter/getBalance/canAfford)
                 │               │   (future: agent tools for transfer/reserve)
                 │               │
  ┌──────────────┼───────────────┼───────────────────────────────┐
  │ MemoryComponent              │                               │
  │ "Agent long-term memory"     │                               │
  │  recall(query, options?)     │                               │
  │  store(content, options?)    │                               │
  │  + MEMORY token (ECS)        │                               │
  │                              │                               │
  │  MemoryResult: content,      │                               │
  │    score?, tier? (hot/warm/  │                               │
  │    cold), decayScore?,       │                               │
  │    lastAccessed?,            │                               │
  │    causalParents/Children?   │                               │
  │                              │                               │
  │  MemoryStoreOptions:         │                               │
  │    category?, relatedEntities│                               │
  │    reinforce?, causalParents?│                               │
  │                              │                               │
  │  MemoryRecallOptions:        │                               │
  │    tierFilter?, limit?,      │                               │
  │    graphExpand?, maxHops?    │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ implemented by: memory-fs
                 │               │ consumed by: middleware-compactor
                 │               │   (fact extraction before compaction)
                 │               │
  ┌──────────────┼───────────────┼───────────────────────────────┐
  │ PermissionBackend            │                               │
  │ "Authorization decisions"    │                               │
  │  check(query) →              │                               │
  │    allow | deny | ask        │                               │
  │  checkBatch?(queries)        │                               │
  │                              │                               │
  │  PermissionQuery:            │                               │
  │    principal, action,        │                               │
  │    resource, context?        │                               │
  │                              │                               │
  │  Three-way decision:         │                               │
  │    allow — proceed           │                               │
  │    deny  — blocked + reason  │                               │
  │    ask   — prompt human      │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ implemented by:
                 │               │   middleware-permissions (pattern globs)
                 │               │   permissions-nexus (Nexus ReBAC)
                 │               │ consumed by: middleware-permissions
                 │               │
  ┌──────────────┼───────────────┼───────────────────────────────┐
  │ ScopeEnforcer                │                               │
  │ "Subsystem access control"   │                               │
  │  checkAccess(request) →      │                               │
  │    boolean                   │                               │
  │                              │                               │
  │  ScopeAccessRequest:         │                               │
  │    subsystem (filesystem |   │                               │
  │      browser | credentials | │                               │
  │      memory)                 │                               │
  │    operation, resource,      │                               │
  │    context?                  │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ implemented by:
                 │               │   @koi/scope (local boundaries)
                 │               │   permissions-nexus (Nexus ReBAC)
                 │               │ consumed by: enforced backends
                 │               │   in @koi/scope
                 │               │
  ┌──────────────┼───────────────┼───────────────────────────────┐
  │ DelegationComponent          │                               │
  │ "Agent-to-agent permission   │                               │
  │  grants at runtime"          │                               │
  │  grant(scope, to, ttl?)      │                               │
  │  revoke(id, cascade?)        │                               │
  │  verify(id, toolId)          │                               │
  │  list()                      │                               │
  │  + DELEGATION token (ECS)    │                               │
  │                              │                               │
  │  DelegationScope:            │                               │
  │    permissions (allow/deny)  │                               │
  │    resources? (glob patterns)│                               │
  │                              │                               │
  │  Monotonic attenuation:      │                               │
  │    child scope ≤ parent      │                               │
  │    HMAC-SHA256 signed grants │                               │
  │    chain depth limits        │                               │
  └──────────────┬───────────────┼───────────────────────────────┘
                 │               │ implemented by: @koi/delegation
                 │               │ gap: no provider attaches it
                 │               │   to agents yet (issue #644)

  ┌──────────────────────────────────────────────────────────────┐
  │ ComponentProvider (L0 — ECS assembly contract)               │
  │ "How packages plug capabilities into an agent"               │
  │                                                              │
  │  interface ComponentProvider {                                │
  │    name: string                                              │
  │    priority?: number  // lower = higher precedence           │
  │    attach(agent) → Map<string, unknown>                      │
  │    detach?(agent) → void                                     │
  │  }                                                           │
  │                                                              │
  │  attach() returns a Map with three kinds of entries:         │
  │                                                              │
  │  ┌─────────────┬──────────────────┬────────────────────────┐ │
  │  │ Kind        │ Key pattern      │ Auto-loaded?           │ │
  │  ├─────────────┼──────────────────┼────────────────────────┤ │
  │  │ Singleton   │ MEMORY, MAILBOX  │ Backend instance.      │ │
  │  │ component   │ (ECS token)      │ Not visible to LLM.    │ │
  │  ├─────────────┼──────────────────┼────────────────────────┤ │
  │  │ Tools       │ tool:memory_store│ YES — auto-discovered  │ │
  │  │             │ tool:ipc_send    │ via agent.query("tool:")│ │
  │  │             │                  │ injected into every     │ │
  │  │             │                  │ ModelRequest.tools.     │ │
  │  │             │                  │ LLM can call them.      │ │
  │  ├─────────────┼──────────────────┼────────────────────────┤ │
  │  │ Skills      │ skill:memory     │ NO — attached but NOT   │ │
  │  │             │ skill:ipc        │ injected into prompt    │ │
  │  │             │                  │ unless manifest declares│ │
  │  │             │                  │ context.sources:        │ │
  │  │             │                  │   [{kind:skill,         │ │
  │  │             │                  │     name:memory}]       │ │
  │  └─────────────┴──────────────────┴────────────────────────┘ │
  │                                                              │
  │  Priority tiers (ascending, lower = wins):                   │
  │    AGENT_FORGED: 0                                           │
  │    ZONE_FORGED: 10                                           │
  │    GLOBAL_FORGED: 50                                         │
  │    BUNDLED: 100 (default)                                    │
  │                                                              │
  │  Existing providers in codebase:                             │
  │    createMemoryProvider  (memory-fs)                         │
  │      → MEMORY + memory_store/recall/search + skill:memory    │
  │    createIpcNexusProvider (ipc-nexus)                        │
  │      → MAILBOX + ipc_send/ipc_list + optional ipc_discover   │
  │    createSquashProvider  (tool-squash, via context-arena)    │
  │    createGovernanceProvider (engine-internal)                │
  └──────────────────────────────────────────────────────────────┘


L1 ENGINE (@koi/engine — agent runtime, depends on L0 only)
═══════════════════════════════════════════════════════════

  ┌──────────────────────────────────────────────────────────────┐
  │ createKoi(manifest, adapter, { providers?, middleware? })     │
  │ "Single-agent runtime: assembly, middleware, guards"         │
  │                                                              │
  │  1. Assembly — providers attach to agent:                    │
  │     AgentEntity.assemble(pid, manifest, providers)           │
  │     → sorts providers by priority (ascending)                │
  │     → calls provider.attach(agent) for each                  │
  │     → first-write-wins: earliest provider owns each key      │
  │     → agent now has components + tools + skills in ECS map   │
  │                                                              │
  │  2. Tool auto-discovery — compose.ts:                        │
  │     agent.query("tool:") → finds ALL tool components         │
  │     → maps to ToolDescriptor[]                               │
  │     → injected into ModelRequest.tools on every call         │
  │     → LLM sees tools, can call them. AUTOMATIC.              │
  │                                                              │
  │  3. Tool execution — defaultToolTerminal:                    │
  │     LLM calls tool → agent.component(toolToken(id))          │
  │     → tool.execute(input) → result back to LLM              │
  │                                                              │
  │  4. Skill injection — requires manifest + hydrator:          │
  │     Skills sit in ECS map as skill:* components              │
  │     NOT auto-injected. Context hydrator middleware reads      │
  │     manifest context.sources, queries agent.query("skill:"), │
  │     prepends matching skill .content as system message.       │
  │                                                              │
  │  L1 has ZERO knowledge of MailboxComponent or MemoryComponent│
  │  It just calls attach() on each ComponentProvider.            │
  │  Returns KoiRuntime with run() → AsyncIterable<EngineEvent>. │
  └──────────────────────────────────────────────────────────────┘


PROCESS CONTROL (L0 types + L1 utilities — PR #640)
═══════════════════════════════════════════════════

POSIX-inspired signal vocabulary for agent lifecycle control.
Signals, process groups, wait semantics, and exit codes.

Signal vocabulary (L0 — @koi/core ecs.ts)
─────────────────────────────────────────

  ```
  AGENT_SIGNALS = {
    STOP: "stop",   // pause at next turn boundary → "suspended"
    CONT: "cont",   // resume from "suspended" → "running"
    TERM: "term",   // graceful shutdown — abort + grace period + force
    USR1: "usr1",   // application-defined (notify only, no state change)
    USR2: "usr2",   // application-defined (notify only, no state change)
  } as const

  type AgentSignal = "stop" | "cont" | "term" | "usr1" | "usr2"
  ```

Process groups (L0 — @koi/core ecs.ts)
───────────────────────────────────────

  ```
  type AgentGroupId = Brand<string, "AgentGroupId">
  function agentGroupId(id: string): AgentGroupId

  // groupId appears on:
  //   RegistryEntry.groupId?      — set at registration time
  //   RegistryFilter.groupId?     — filter by group in list()
  //   ProcessId.groupId?          — embedded in agent identity
  //   SpawnChildOptions.groupId?  — assigned at spawn (L1)
  ```

ChildHandle signal + wait (L0 — @koi/core ecs.ts)
──────────────────────────────────────────────────

  ```
  interface ChildHandle {
    readonly childId: AgentId
    readonly name: string
    readonly onEvent: (listener: (event: ChildLifecycleEvent) => void) => () => void
    readonly signal: (kind: string) => void | Promise<void>
    readonly terminate: (reason?: string) => void | Promise<void>
    readonly waitForCompletion: () => Promise<ChildCompletionResult>
  }

  interface ChildCompletionResult {
    readonly childId: AgentId
    readonly exitCode: number
    readonly reason?: TransitionReason
  }
  ```

  `waitForCompletion()` resolves when the child reaches "terminated".
  Concurrent callers all resolve. Noop handle resolves immediately with exitCode: 0.
  Listener is unsubscribed on resolution (no leak).

Exit codes (L0 — @koi/core lifecycle.ts)
─────────────────────────────────────────

  ```
  function exitCodeForTransitionReason(reason: TransitionReason): number
  //   0 = completed | signal_stop | signal_cont
  //   1 = error (generic)
  //   2 = budget_exceeded | iteration_limit
  //   3 = timeout
  //   4 = evicted | stale
  // 126 = escalated (capability error)
  ```

  `exitCode` is a required field on `completed` and `terminated`
  variants of `ChildLifecycleEvent`.

  `signal_stop` and `signal_cont` are `TransitionReason` variants
  added to the existing discriminated union.

Group operations (L1 — @koi/engine group-operations.ts)
───────────────────────────────────────────────────────

  ```
  function listByGroup(
    registry: AgentRegistry,
    groupId: AgentGroupId,
  ): readonly RegistryEntry[] | Promise<readonly RegistryEntry[]>

  function signalGroup(
    registry: AgentRegistry,
    groupId: AgentGroupId,
    signal: AgentSignal,
    options?: {
      readonly handles?: ReadonlyMap<AgentId, ChildHandle>
      readonly deadlineMs?: number   // default: 5000ms
    },
  ): Promise<void>
  ```

  `signalGroup()` fans out via `Promise.allSettled()` — one slow agent
  does not block others. Skips already-terminated members. When handles
  are provided, delegates to `handle.signal()`; otherwise applies state
  transitions directly via the registry.

Signal dispatch flow
────────────────────

  ```
  Caller               ChildHandle / Registry        Agent loop (koi.ts)
  ──────               ──────────────────────        ───────────────────
  signal(STOP) ──────→ transition → "suspended" ───→ reactive Promise-on-watch
                                                      (zero polling, resumes
                                                       at next turn boundary)

  signal(CONT) ──────→ transition → "running"  ───→ Promise resolves, loop
                                                      continues from suspended

  signal(TERM) ──────→ abort controller fired  ───→ grace period (5s default)
                        + terminate fallback          then force terminate

  signal(USR1/USR2) ─→ fires "signaled" event ───→ notify only, no state
                        to ChildHandle listeners      change
  ```

Node / gateway wiring (commit 73899ac4, PR #640)
─────────────────────────────────────────────────

  Signals are wired through the distributed layer:

  ```
  Frame kinds:
    agent:signal        — gateway → node: signal a single agent
    agent:signal_group  — gateway → node: fan-out to group members on that node
    agent:status        — node → gateway: includes exitCode + groupId

  Gateway interface (3 new methods):
    signalAgent(agentId, signal, gracePeriodMs?)
      → looks up hosting node → sends agent:signal frame
    signalGroup(groupId, signal, { deadlineMs? })
      → finds all nodes hosting group members → sends agent:signal_group
    waitForAgent(agentId, timeoutMs?)
      → subscribes to agent:status → resolves on terminated with exitCode

  Node side (AgentHost):
    signal(agentId, signal)    → dispatches to managed agent
    signalGroup(groupId, signal) → fan-out to local group members
  ```

  Gateway maintains agentId→nodeId and groupId→agentId indexes
  (populated from agent:status frames) for routing.


PROVIDER vs MIDDLEWARE (two extension points, different phases)
══════════════════════════════════════════════════════════════

  ┌──────────────────────────────────────────────────────────────┐
  │ ComponentProvider           │ KoiMiddleware                   │
  │ (assembly time)             │ (runtime — every turn)          │
  ├─────────────────────────────┼─────────────────────────────────┤
  │ attach(agent) → Map         │ 7 optional hooks:               │
  │   of components             │   wrapModelCall                 │
  │                             │   wrapModelStream               │
  │ Gives agent:                │   wrapToolCall                  │
  │   singletons (MEMORY,       │   onSessionStart/End            │
  │     MAILBOX)                │   onBeforeTurn/AfterTurn        │
  │   tools (tool:*)            │   + describeCapabilities()      │
  │   skills (skill:*)          │                                 │
  │                             │ Intercepts and modifies         │
  │ Runs ONCE during            │ model/tool calls. Onion chain.  │
  │ createKoi assembly.         │ Runs on EVERY turn.             │
  └─────────────────────────────┴─────────────────────────────────┘

  Some packages need BOTH (tool + interception logic).
  These return a bundle: { provider, middleware } or { providers[], middleware[] }.

  ┌──────────────────────────────────────────────────────────────┐
  │ Bundle examples (provider + middleware in one package):       │
  │                                                              │
  │ tool-squash:                                                 │
  │   Provider: attaches squash tool + skill:squash              │
  │   Middleware (priority 220): drains pending squash queue      │
  │     before each model call                                   │
  │   Shared closure: pendingQueue (tool enqueues, mw drains)    │
  │                                                              │
  │ middleware-compactor:                                         │
  │   Provider: attaches compact_context tool                    │
  │   Middleware (priority 225): handles compaction when          │
  │     context exceeds threshold                                │
  │   Shared closure: scheduleCompaction flag                    │
  │                                                              │
  │ context-arena (L3):                                          │
  │   Aggregates both of the above + context-editing (250)       │
  │   + optional memory-fs provider + hydrator                   │
  │   Returns: { middleware[], providers[] }                      │
  └──────────────────────────────────────────────────────────────┘


TWO LAYERS OF LLM GUIDANCE (how tools teach the agent)
══════════════════════════════════════════════════════

  ┌──────────────────────────────────────────────────────────────┐
  │ Layer 1: Tool descriptor (ALWAYS auto-injected)              │
  │                                                              │
  │   compose.ts: agent.query("tool:") → ToolDescriptor[]       │
  │   → injected into ModelRequest.tools on EVERY model call     │
  │   → LLM sees: tool name + description + inputSchema          │
  │                                                              │
  │   Short "what + when" — LLM knows the tool exists and        │
  │   roughly when to call it. No manifest needed.               │
  │                                                              │
  │   Example (squash tool descriptor):                          │
  │     "Compress conversation history at a phase boundary.      │
  │      Replaces old messages with your summary, archives       │
  │      originals for retrieval, and optionally stores facts    │
  │      to memory. Call at natural transitions."                │
  │                                                              │
  ├──────────────────────────────────────────────────────────────┤
  │ Layer 2: Skill content (opt-in via manifest)                 │
  │                                                              │
  │   Attached as skill:* component by provider.                 │
  │   Only injected into system prompt if manifest declares:     │
  │     context.sources: [{ kind: skill, name: "squash" }]       │
  │                                                              │
  │   Detailed "why + how" — teaches the LLM strategy,           │
  │   when NOT to call, how to write good inputs.                │
  │                                                              │
  │   Example (squash skill — 63-line markdown guide):           │
  │     When to squash, when to skip, how to write summaries,   │
  │     how to extract durable facts, decay tier explanations.   │
  │                                                              │
  ├──────────────────────────────────────────────────────────────┤
  │ Not all tools have skills:                                   │
  │                                                              │
  │   squash         → tool descriptor + skill:squash    (both)  │
  │   memory_store   → tool descriptor + skill:memory    (both)  │
  │   memory_recall  → tool descriptor + skill:memory    (both)  │
  │   compact_context→ tool descriptor only              (no skill)│
  │   ipc_send       → tool descriptor only              (no skill)│
  │                                                              │
  │   Tools without skills rely on descriptor alone.             │
  │   Sufficient for simple tools; richer skills help for        │
  │   complex behaviors (when to store vs. when to recall).      │
  └──────────────────────────────────────────────────────────────┘


L2 IMPLEMENTATIONS (all depend on L0 only)
═══════════════════════════════════════════

  INFRASTRUCTURE                     DATA BACKENDS
  ──────────────                     ─────────────
┌───────────────────────┐          ┌───────────────────────────────────┐
│ @koi/node              │          │ events-nexus                      │
│ (✅ exists)            │          │ (✅ exists)                       │
│                        │          │                                   │
│ createNode(config,     │          │ Implements:                       │
│   { registry? })       │          │   EventBackend                    │
│                        │          │                                   │
│ Two modes:             │          │ How:                              │
│  "full" — hosts agents │          │   One JSON file per event on      │
│    dispatch, terminate │          │   Nexus filesystem                │
│    capacity, checkpoint│          │                                   │
│    memory monitor      │          │ Storage:                          │
│    agent inbox         │          │   /events/streams/{streamId}/     │
│    delivery manager    │          │     events/0000000001.json        │
│    status reporter     │          │     meta.json                     │
│  "thin" — tools only   │          │                                   │
│    no agents           │          │ Features:                         │
│    no engines          │          │   FIFO eviction, TTL expiry,      │
│                        │          │   optimistic concurrency, DLQ,    │
│ Both modes:            │          │   subscription cursors            │
│   tool resolver        │          └──────────────┬────────────────────┘
│   gateway transport    │                         │
│   mDNS discovery       │                         │
│   heartbeat            │          ┌──────────────┼────────────────────┐
│                        │          │ registry-event-sourced            │
│ Consumes:              │          │ (✅ exists)                       │
│   AgentRegistry (L0)   │          │                           consumes│
│   for lifecycle        │          │ Implements:               (DI)   │
│   tracking             │          │   AgentRegistry       ◄──────────┘
└───────────────────────┘          │                                   │
                                    │ How:                              │
┌───────────────────────┐          │   Appends events to               │
│ @koi/gateway           │          │   EventBackend, folds into        │
│ (✅ exists)            │          │   in-memory projection            │
│                        │          │                                   │
│ createGateway(config,  │          │ Events:                           │
│   deps)                │          │   agent_registered                │
│                        │          │   agent_transitioned              │
│ Features:              │          │   agent_deregistered              │
│   Node registry        │          └───────────────────────────────────┘
│   (who's connected,    │
│    their tools,        │          ┌───────────────────────────────────┐
│    their capacity)     │          │ registry-nexus                    │
│   Tool routing         │          │ (proposed, P0)                    │
│   (affinity + capacity │          │                                   │
│    based)              │          │ Implements:                       │
│   Session management   │          │   AgentRegistry                   │
│   (resume, TTL,        │          │                                   │
│    destroy)            │          │ How:                              │
│   Frame dedup +        │          │   Direct HTTP CRUD to Nexus API   │
│     backpressure       │          │   No events. No projection.       │
│   Webhook ingestion    │          │   Zero startup cost.              │
│   Canvas UI surface    │          │   Strong consistency.             │
│                        │          └───────────────────────────────────┘
│ Routes:                │
│   tool_call → node     │          ┌───────────────────────────────────┐
│   that has the tool    │          │ ipc-nexus                         │
│   (inverted index)     │          │ (✅ exists)                       │
│                        │          │                                   │
│ Consumes:              │          │ IS a ComponentProvider             │
│   L0 types only        │          │ (via createIpcNexusProvider)       │
│   (no AgentRegistry,   │          │                                   │
│    no MailboxComponent) │          │ Implements:                       │
│                        │          │   MailboxComponent                │
│ Does NOT create        │          │                                   │
│   agents or engines.   │          │ How:                              │
│   Pure message router. │          │   REST API to Nexus IPC server    │
└───────────────────────┘          │   POST /api/v2/ipc/send           │
                                    │   GET  /api/v2/ipc/inbox/{id}    │
                                    │                                   │
                                    │ attach() provides to agent:       │
                                    │   MAILBOX singleton (send/recv)   │
                                    │   ipc_send tool  (auto-loaded)    │
                                    │   ipc_list tool  (auto-loaded)    │
                                    │   ipc_discover   (if registry)    │
                                    │     → registry.list() to find     │
                                    │       live agents to message      │
                                    │                                   │
                                    │ Delivery (current):               │
                                    │   HTTP polling (1s → 30s backoff) │
                                    │   Dedup via seen Set              │
                                    │                                   │
                                    │ Delivery (available, not wired):  │
                                    │   Redis pub/sub → ipc.inbox.{id}  │
                                    │   SSE → /api/v2/events/stream     │
                                    │   Both ~ms latency vs ~seconds    │
                                    │                                   │
                                    │ Message kinds:                    │
                                    │   request, response,              │
                                    │   event, cancel                   │
                                    └───────────────────────────────────┘

  PAY (backend + consumer)
  ────────────────────────
┌───────────────────────┐          ┌───────────────────────────────────┐
│ middleware-pay         │          │ pay-nexus                         │
│ (✅ exists)            │          │ (✅ exists)                       │
│                        │          │                                   │
│ One consumer of        │          │ Backend — implements              │
│ PayLedger (L0)         │          │   PayLedger (L0)                  │
│                        │          │                                   │
│ KoiMiddleware          │          │ How:                              │
│ (priority: 200)        │          │   HTTP to Nexus Pay API           │
│                        │          │   GET  /api/v2/pay/balance        │
│ Hooks:                 │          │   POST /api/v2/pay/meter          │
│   wrapModelCall        │          │   POST /api/v2/pay/transfer       │
│   wrapModelStream      │          │   POST /api/v2/pay/reserve        │
│   wrapToolCall         │          │   POST /api/v2/pay/reserve/commit │
│   describeCapabilities │          │   POST /api/v2/pay/reserve/release│
│                        │          │                                   │
│ Uses PayLedger (L0)    │          │ Backend:                          │
│ directly:              │          │   TigerBeetle + PostgreSQL        │
│   meter() — record cost│          │   (via Nexus server)              │
│   getBalance() — check ├── uses ─►│                                   │
│   canAfford() — guard  │          │ PayLedger's transfer/reserve/     │
│                        │          │ commit/release are available but  │
│ Fallback: in-memory    │          │ no consumer exists yet.           │
│ PayLedger (dev/test)   │          │                                   │
│                        │          │ BudgetTracker adapter removed     │
│ Enforces:              │          │ (issue #621). middleware-pay      │
│   budget limits        │          │ consumes PayLedger directly —     │
│   alert thresholds     │          │ no indirection layer needed.      │
│   (80%, 95%)           │          │                                   │
│   hard kill or warn    │          │                                   │
└───────────────────────┘          └───────────────────────────────────┘

  MEMORY (provider — backend + tools + skill + auto-digest)
  ─────────────────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────────┐
│ memory-fs                                                            │
│ (✅ exists)                                                          │
│                                                                      │
│ IS a ComponentProvider (via createMemoryProvider)                     │
│ Implements: MemoryComponent (L0)                                     │
│ Dependencies: @koi/core only (L2)                                    │
│                                                                      │
│ One call to createMemoryProvider() gives the agent everything:       │
│   MEMORY singleton  — MemoryComponent instance (backend)             │
│   memory_store tool — auto-loaded, LLM can call immediately          │
│   memory_recall tool— auto-loaded, LLM can call immediately          │
│   memory_search tool— auto-loaded, LLM can call immediately          │
│   skill:memory      — behavioral instructions (needs manifest to     │
│                       hydrate into prompt — see ComponentProvider)    │
│                                                                      │
│ Storage layout:                                                      │
│   <baseDir>/                                                         │
│   ├── entities/                                                      │
│   │   └── <entity-slug>/                                             │
│   │       ├── items.json      # atomic facts (JSON array)            │
│   │       └── summary.md      # auto-generated (hot + warm only)     │
│   └── sessions/                                                      │
│       └── YYYY-MM-DD.md       # daily session logs                   │
│                                                                      │
│ Core features:                                                       │
│   Jaccard dedup (0.7 threshold — skip near-duplicates)               │
│   Reinforce mode (boost existing fact instead of skip)               │
│   Contradiction detection (supersede same-entity same-category)      │
│   Exponential decay: decayScore = e^(-λ * ageDays)                   │
│     Hot:  decayScore ≥ 0.7  (recent, prioritized)                    │
│     Warm: decayScore ≥ 0.3  (or accessCount ≥ 10)                    │
│     Cold: decayScore < 0.3  (excluded from summaries)                │
│   Causal graph: parents/children edges, BFS expansion on recall      │
│   Cross-entity expansion: follow relatedEntities links               │
│   Summary rebuild: hot + warm facts → summary.md per entity          │
│                                                                      │
│ DI slots (optional):                                                 │
│   FsSearchRetriever — pluggable semantic/vector search               │
│   FsSearchIndexer  — pluggable index updates                         │
│   (without these: fallback to recency-based retrieval)               │
│                                                                      │
│ ComponentProvider: createMemoryProvider(config)                       │
│   Attaches to agent:                                                 │
│     MEMORY component (MemoryComponent)                               │
│     memory_store tool  — persist one atomic fact                      │
│     memory_recall tool — semantic search with tier filter             │
│     memory_search tool — browse entity or list all entities           │
│     memory skill       — behavioral instructions for LLM             │
│                                                                      │
│ Skill content (auto-injected):                                       │
│   Tells agent: storage location, file structure,                     │
│   when to store (preferences, relationships, decisions,              │
│   milestones, corrections), when NOT to store (greetings,            │
│   temp queries, duplicates), how to recall (tier filters,            │
│   graph expansion), decay tier explanations                          │
│                                                                      │
│ Auto-digest integration:                                             │
│   middleware-compactor → createFactExtractingArchiver(memory)         │
│   Before compaction discards messages, extracts structured facts      │
  PERMISSIONS + GOVERNANCE (3 layers of security)
  ───────────────────────────────────────────────

  Layer 1: TOOL PERMISSIONS (can agent call this tool?)
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
┌──────────────────────────────────────────────────────────────────────┐
│ middleware-permissions                                                │
│ (✅ exists)                                                          │
│                                                                      │
│ KoiMiddleware (priority: 100)                                        │
│                                                                      │
│ Hooks:                                                               │
│   wrapModelCall — batch-checks all tools, removes denied ones        │
│     from ModelRequest.tools (LLM never sees denied tools)            │
│   wrapToolCall  — re-checks at execution time                        │
│     allow → execute, deny → error, ask → prompt human                │
│                                                                      │
│ Pluggable backend: PermissionBackend (L0)                            │
│                                                                      │
│ Built-in: createPatternPermissionBackend()                           │
│   Glob rules in code or manifest:                                    │
│     allow: ["read_file", "group:fs_read"]                            │
│     deny:  ["delete_file", "format_disk"]                            │
│     ask:   ["bash:*"]                                                │
│   Pre-built groups: fs, fs_read, fs_write, fs_delete,                │
│     runtime, web, browser, db, db_read, db_write, lsp, mcp          │
│                                                                      │
│ Alternative: createNexusPermissionBackend() (permissions-nexus)       │
│   Same interface, HTTP to Nexus ReBAC graph                          │
│                                                                      │
│ Features:                                                            │
│   Decision cache (configurable TTL for allow/deny)                   │
│   Approval cache (for "ask" decisions, LRU)                          │
│   Circuit breaker (fail-closed on backend errors)                    │
│   Audit sink (fire-and-forget logging)                               │
│                                                                      │
│ Manifest:                                                            │
│   permissions:                                                       │
│     allow: ["read_file:/workspace/**"]                               │
│     deny:  ["bash:rm -rf *"]                                         │
│     ask:   ["bash:*"]                                                │
└──────────────────────────────────────────────────────────────────────┘

  Layer 2: SCOPE ENFORCEMENT (what can a tool touch?)
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
┌──────────────────────────────────────────────────────────────────────┐
│ @koi/scope                                                           │
│ (✅ exists, L0u)                                                     │
│                                                                      │
│ Capability attenuation — wraps raw backends with narrower views.     │
│ Even if a tool is allowed to run (Layer 1), scope limits WHERE       │
│ it can reach. Tool doesn't know it's restricted.                     │
│                                                                      │
│ Four subsystem scopes:                                               │
│                                                                      │
│   filesystem:                                                        │
│     root: "/workspace", mode: "ro"                                   │
│     → can't escape root dir, can't write in read-only mode           │
│     → path traversal prevention (resolves + validates)               │
│                                                                      │
│   browser:                                                           │
│     allowedDomains: ["*.example.com"]                                │
│     blockPrivateAddresses: true                                      │
│     → navigate/tabNew checked against domain allowlist               │
│     → evaluate() requires trustTier: "promoted"                      │
│                                                                      │
│   credentials:                                                       │
│     keyPattern: "api_*"                                              │
│     → can only see keys matching glob, others appear absent          │
│                                                                      │
│   memory:                                                            │
│     namespace: "agent-1"                                             │
│     → isolated namespace, store injects ns, recall filters           │
│                                                                      │
│ Two-stage wrapping:                                                  │
│   1. createScopedXxx(backend, scope) — local boundary checks         │
│   2. createEnforcedXxx(scoped, enforcer) — pluggable policy (opt)    │
│                                                                      │
│ Without enforcer: local-only checks (path in root? mode allows?)     │
│ With enforcer: delegates to ScopeEnforcer (L0) for policy eval       │
│   → pattern-based (local) or Nexus ReBAC (HTTP)                      │
│                                                                      │
│ Manifest:                                                            │
│   scope:                                                             │
│     filesystem: { root: /workspace, mode: ro }                       │
│     browser: { allowedDomains: [docs.example.com] }                  │
│     credentials: { keyPattern: "api_*" }                             │
│     memory: { namespace: research }                                  │
└──────────────────────────────────────────────────────────────────────┘

  Layer 3: GOVERNANCE POLICIES (rule-based gate)
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
┌──────────────────────────────────────────────────────────────────────┐
│ middleware-governance-backend                                         │
│ (✅ exists)                                                          │
│                                                                      │
│ KoiMiddleware (priority: 150)                                        │
│                                                                      │
│ Pluggable policy evaluation gate (Cedar/OPA-style).                  │
│ Wraps wrapModelCall + wrapToolCall with GovernanceBackend.evaluate()  │
│                                                                      │
│ PolicyRequest:                                                       │
│   kind: "tool_call" | "model_call" | "spawn" | "delegation" |       │
│         "forge" | "handoff" | custom:*                               │
│   agentId, payload, timestamp                                        │
│                                                                      │
│ GovernanceVerdict:                                                    │
│   ok: true → proceed                                                 │
│   ok: false → violations[] with severity (info/warning/critical)     │
│                                                                      │
│ In-memory impl: governance-memory                                    │
│   Cedar-inspired constraint DAG, adaptive thresholds,                │
│   ring buffer compliance recording, violation history                │
│                                                                      │
│ Fail-closed: errors always deny.                                     │
└──────────────────────────────────────────────────────────────────────┘

  ADDITIONAL SECURITY MIDDLEWARE
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
┌──────────────────────────────────────────────────────────────────────┐
│ Other L2 security packages (each independent, all optional):         │
│                                                                      │
│ delegation          (priority 120) — agent-to-agent grant            │
│   Monotonic attenuation, HMAC-SHA256/Ed25519, cascading revocation.  │
│   DelegationScope.resources: glob patterns (fs_read:/project/**)     │
│   verify.ts enforces resource globs on every tool call.              │
│   Planned (#671): DelegationComponentProvider exposes 3 tools        │
│     delegation_grant  — grant another agent file/tool access         │
│     delegation_revoke — revoke with cascade                          │
│     delegation_list   — list active grants issued by this agent      │
│   onGrant/onRevoke hooks: DI seam → governance (L3) bridges to      │
│     Nexus permissions.grant RPC (writes ReBAC tuples).               │
│   Spawn: auto-creates attenuated grant (parent scope → child).      │
│   Co-pilot: brand new workspace, explicit delegation_grant only.     │
│                                                                      │
│ exec-approvals      (priority 110) — progressive command             │
│   allowlisting. allow-once → allow-session → allow-always.           │
│   Specialized permissions for shell commands.                        │
│                                                                      │
│ middleware-audit     (priority 300) — structured audit logging        │
│   Every model/tool call logged. PII redaction. Compliance trail.     │
│                                                                      │
│ middleware-pii       (priority 340) — PII detection & redaction       │
│   Email, credit card, IP, SSN, phone. Strategies: redact/mask/hash.  │
│                                                                      │
│ middleware-sanitize  (priority 350) — content sanitization            │
│   Strips injection patterns, control chars, zero-width chars.        │
│                                                                      │
│ middleware-guardrails(priority 375) — output schema validation        │
│   Zod-based, prevents malformed responses and data leaks.            │
│                                                                      │
│ permissions-nexus    (L2 backend) — thin client to Nexus ReBAC       │
│   Implements: PermissionBackend, RevocationRegistry, ScopeEnforcer   │
│   Read: permissions.check, permissions.checkBatch,                   │
│         revocations.check, revocations.checkBatch                    │
│   Write: revocations.revoke (exists)                                 │
│   Planned (#671): permissions.grant RPC — writes ReBAC tuples        │
│     so delegation_grant → Nexus tuple → NexusScopeEnforcer works.    │
│   Zanzibar-style tuples: agent:coder#writer@folder:/src              │
│   FS_OPERATION_RELATIONS: read→reader, write→writer, delete→deleter  │
│   Fail-closed on all errors.                                         │
└──────────────────────────────────────────────────────────────────────┘


  ┌──────────────────────────────────────────────────────────────────────┐
  │ PRE-DEPLOY: STATIC ANALYSIS (not runtime — runs in CI)              │
  │                                                                      │
  │ doctor                                                               │
  │   "Is this manifest safe to deploy?" — OWASP ASI01-10 rule scanner. │
  │   Analyzes AgentManifest configurations before deployment.           │
  │   Output: DoctorReport + SARIF export for CI/CD gates.              │
  │   Rule categories: GOAL_INTEGRITY, TOOL_SAFETY, ACCESS_CONTROL,     │
  │     SUPPLY_CHAIN, RESILIENCE.                                        │
  │   Advisory: pluggable vulnerability feed (npm audit, OSV, Snyk).     │
  │                                                                      │
  │   ≠ runtime middleware. Runs once at deploy time, not per turn.      │
  └──────────────────────────────────────────────────────────────────────┘


  SIDECARS (L2, run alongside node — NOT inside engine loop)
  ──────────────────────────────────────────────────────────
  Both are L2 packages. Can't import node (peer L2) or engine (L1).
  App code composes them in the same process as the node.

┌──────────────────────────────────────────────────────────────────────┐
│ agent-procfs — DIAGNOSTIC sidecar                                    │
│ (✅ exists)                                                          │
│                                                                      │
│ "What are my agents doing right now?"                                │
│                                                                      │
│ Exposes live agent state as a virtual filesystem:                    │
│   /agents/<id>/status      agent.pid, agent.state                    │
│   /agents/<id>/tools       agent.query("tool:")                      │
│   /agents/<id>/middleware   agent.query("middleware:")                │
│   /agents/<id>/config      agent.manifest                            │
│   /agents/<id>/env         agent.component(ENV)                      │
│   /agents/<id>/children    registry.list({ parentId })               │
│   /agents/<id>/metrics     registry.lookup(id)  (WRITABLE: priority) │
│                                                                      │
│ Wiring (app code):                                                   │
│   const procFs = createProcFs({ cacheTtlMs: 1000 })                 │
│   const mounter = createAgentMounter({                               │
│     registry, procFs, agentProvider: (id) => node.getAgent(id) })    │
│   // mounter auto-mounts 7 entries per agent on registry events      │
│                                                                      │
│ In-memory Map<path, lazy lambda>. 1s TTL cache. No persistence.      │
│ NOT the source of truth — read-through cache over Agent + registry.  │
│                                                                      │
│ Consumers: app code, dashboards, admin API, future procfs_* tools.   │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ scheduler + scheduler-provider — TASK SCHEDULING sidecar             │
│ (✅ both exist)                                                      │
│                                                                      │
│ "Run this agent task at this time, with retry."                      │
│                                                                      │
│ Two packages, one L0 contract (TaskScheduler):                       │
│                                                                      │
│ scheduler (sidecar):          scheduler-provider (ComponentProvider): │
│   Cron (croner, IANA tz)        Wraps TaskScheduler (L0)             │
│   Delay (scheduledAt)           9 agent-scoped tools:                │
│   Retry (exp backoff+jitter)      scheduler_submit                   │
│   Dead-letter queue               scheduler_cancel                   │
│   Priority min-heap               scheduler_schedule (cron)          │
│   Bounded concurrency             scheduler_unschedule               │
│     (semaphore)                   scheduler_pause / _resume          │
│                                   scheduler_query / _stats           │
│                                   scheduler_history                  │
│                                                                      │
│ Pluggable queue backend:                                             │
│   Local:  in-memory heap + SQLite (dev, single-process)              │
│   Nexus:  HTTP to /api/v2/scheduler/* (production)                   │
│     Nexus adds: 5-tier Astraea priority, aging, credit boost,        │
│     fair-share, HRRN scoring. Dispatches via IPC (push).             │
│     Cron dedup across nodes via idempotency_key.                     │
│                                                                      │
│ Koi owns: cron, timing, retry, tools (WHEN + interface)              │
│ Nexus owns: priority queue, dispatch via IPC (WHAT runs next + HOW)  │
│                                                                      │
│ Wiring (app code):                                                   │
│   const scheduler = createScheduler(config, store, queueBackend)     │
│   const schedulerProvider = createSchedulerProvider(scheduler)        │
│   node.dispatch(pid, manifest, engine, [schedulerProvider])           │
│                                                                      │
│ Flow (production):                                                   │
│   Agent calls scheduler_schedule("0 9 * * *", "daily report")        │
│     → croner fires at 9am                                            │
│     → scheduler submits to Nexus queue (idempotency_key for dedup)   │
│     → Nexus prioritizes + dequeues                                   │
│     → Nexus sends IPC message to target agent                        │
│     → agent receives task in mailbox                                 │
│                                                                      │
│ Security: agents only see own tasks (agentId auto-injected).         │
│ Persistence: SQLite (local) or Nexus PostgreSQL (production).        │
│ Single-process cron. Multi-node dedup via Nexus idempotency.         │
└──────────────────────────────────────────────────────────────────────┘


ORCHESTRATION PATTERNS (L0u — wraps L1, not inside engine loop)
════════════════════════════════════════════════════════════════

┌──────────────────────────────────────────────────────────────────────┐
│ @koi/verified-loop (L0u)                                              │
│ (✅ exists)                                                          │
│                                                                      │
│ "Shift from LLM self-assessment to external objective verification"  │
│                                                                      │
│ The VerifiedLoop creates a FRESH Koi runtime per iteration.          │
│ Each iteration gets a clean context window — the filesystem is       │
│ long-term memory (PRD tracks progress, learnings accumulate).        │
│ External gates decide ground truth, not the LLM.                     │
│                                                                      │
│ Core algorithm:                                                      │
│   1. Read PRD file (priority-ordered task list)                      │
│   2. Pick next undone item (nextItem, priority: lower = higher)      │
│   3. Build prompt via iterationPrompt(ctx)                           │
│   4. Run iteration (fresh engine via RunIterationFn)                 │
│   5. Run verification gate (external objective check)                │
│   6. Gate passes → mark item done, reset failure counter             │
│      Gate fails  → increment counter                                 │
│      Counter >= maxConsecutiveFailures → skip item                   │
│   7. Append learning (rolling journal, last N entries)               │
│   8. Loop until all items done/skipped or maxIterations              │
│                                                                      │
│ Consumer injects (dependency inversion):                             │
│   RunIterationFn:   (input) → AsyncIterable<EngineEvent>            │
│     Caller wires createKoi + adapter + middleware inside this fn     │
│   VerificationFn:   (ctx: GateContext) → VerificationResult          │
│     Built-in gates: createTestGate, createFileGate, createComposite  │
│   iterationPrompt:  (ctx) → string                                  │
│     Receives: currentItem, completedItems, remainingItems, learnings │
│                                                                      │
│ Config (all optional except runIteration, prdPath, verify, prompt):  │
│   maxIterations:           100                                       │
│   maxConsecutiveFailures:  3 (stuck-loop detection)                  │
│   iterationTimeoutMs:      600_000 (10 min per iteration)            │
│   gateTimeoutMs:           120_000 (2 min per gate)                  │
│   maxLearningEntries:      50 (rolling window)                       │
│   signal:                  AbortSignal (external abort)              │
│   onIteration:             callback for progress reporting           │
│                                                                      │
│ State on disk (filesystem = long-term memory):                       │
│   prdPath (JSON):       { items: [{ id, description, done,          │
│                             priority?, skipped?, verifiedAt? }] }    │
│   learningsPath (JSON): [{ iteration, timestamp, itemId,            │
│                             discovered[], failed[], context }]       │
│                                                                      │
│ Built-in gate factories:                                             │
│   createTestGate(["bun", "test"])     — subprocess, exit code 0     │
│   createFileGate("out.txt", /done/)   — file exists + content match │
│   createCompositeGate([g1, g2])       — all sub-gates must pass     │
│                                                                      │
│ Returns: VerifiedLoopResult                                          │
│   { iterations, completed[], remaining[], skipped[],                │
│     learnings[], durationMs, iterationRecords[] }                   │
│                                                                      │
│ Error handling:                                                      │
│   Iteration error → recorded, gate still runs                       │
│   Gate error → recorded as failure, loop continues                  │
│   Timeout → AbortSignal.any() ripples, cleanup via iterator.return()│
│   Learnings corruption → reset silently (advisory, not critical)    │
│   PRD missing → loop returns 0 iterations                           │
│                                                                      │
│ Deps: @koi/core (types), @koi/errors (extractMessage). Zero npm.    │
│ 773 LOC source. 2,183 LOC tests (unit + integration + E2E).         │
│                                                                      │
│ Layer placement: L0u — orchestration utility below L1.               │
│ Not a middleware. Not a provider. Not a sidecar.                     │
│ It IS the outer loop that creates Koi instances.                     │
└──────────────────────────────────────────────────────────────────────┘


AUTONOMOUS AGENT SYSTEM (L2 middleware/providers + L3 bundle)
═════════════════════════════════════════════════════════════

Issues: #684 (thread + inbox), #687 (lifecycle + pool), #688 (forge bridge)

The autonomous layer sits between the engine (L1) and governance (L3).
It is composed entirely of middleware + providers — no L1 changes needed.
Injected into createKoi like any other middleware. Zero overhead when idle.

```
┌──────────────────────────────────────────────────────────────────────┐
│ THE AUTONOMOUS EVOLUTIONARY LOOP                                     │
│                                                                      │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ 1. DETECT — does this task need autonomy?                       │  │
│ │                                                                 │  │
│ │ Autonomous middleware always present, idle by default.           │  │
│ │ Agent self-escalates by calling plan_autonomous() tool.         │  │
│ │ "hello" → middleware idle, zero overhead.                       │  │
│ │ "refactor auth, tests must pass" → agent calls:                │  │
│ │   plan_autonomous({                                             │  │
│ │     items: [                                                    │  │
│ │       { id: "audit",   description: "...", gate: "file" },     │  │
│ │       { id: "impl",    description: "...", gate: "test",       │  │
│ │                         parallel: true },                       │  │
│ │       { id: "tests",   description: "...", gate: "test",       │  │
│ │                         parallel: true },                       │  │
│ │       { id: "cleanup", description: "...",                     │  │
│ │                         dependsOn: ["impl", "tests"] },        │  │
│ │     ]                                                           │  │
│ │   })                                                            │  │
│ │ Middleware activates. TaskBoard created. Agent works items.     │  │
│ └─────────────────────────┬───────────────────────────────────────┘  │
│                           │                                          │
│                           ▼                                          │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ 2. DISCOVER — who can do this work?                             │  │
│ │                                                                 │  │
│ │ Items with parallel:true or agentType:                          │  │
│ │   ForgeAgentResolver queries catalog (#688):                    │  │
│ │     catalog.search({ kind: "agent", tags: [capability] })       │  │
│ │     → returns N agent bricks, fitness-ranked                    │  │
│ │     → variant-selection picks best manifest                     │  │
│ │                                                                 │  │
│ │ Items with reuse:true:                                          │  │
│ │   task-spawn's findLive(agentType) queries registry (#687):     │  │
│ │     registry.list({ agentType: "copilot", phase: "idle" })      │  │
│ │     → warm copilot found? → message it (skip cold-start)        │  │
│ │     → not found? → auto-create from manifest + persist          │  │
│ │                                                                 │  │
│ │ No agent bricks exist for this capability?                      │  │
│ │   forge-demand fires "capability_gap" signal                    │  │
│ │   → LLM creates new agent manifest via forge_agent              │  │
│ │   → verify in sandbox → save to ForgeStore → now discoverable   │  │
│ └─────────────────────────┬───────────────────────────────────────┘  │
│                           │                                          │
│                           ▼                                          │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ 3. DELEGATE — dispatch work to children                         │  │
│ │                                                                 │  │
│ │ Sequential items (default):                                     │  │
│ │   Agent works them one at a time, own context.                  │  │
│ │                                                                 │  │
│ │ Parallel items (parallel: true):                                │  │
│ │   parallel-minions: executeBatch(config, tasks)                 │  │
│ │   Strategies: best-effort | fail-fast | quorum                  │  │
│ │   Concurrency: semaphore + lane-semaphore per agent type        │  │
│ │   Parent → "background" state (#687), still accepting messages  │  │
│ │                                                                 │  │
│ │ DAG items (dependsOn: [...]):                                   │  │
│ │   orchestrator: board.ready() → topological sort                │  │
│ │   Cycle detection via DFS. maxConcurrency enforcement.          │  │
│ │                                                                 │  │
│ │ Copilot items (reuse: true):                                    │  │
│ │   task-spawn: findLive → message | spawn                        │  │
│ │   Warm copilot stays alive between tasks (thread persists).     │  │
│ └─────────────────────────┬───────────────────────────────────────┘  │
│                           │                                          │
│                           ▼                                          │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ 4. VERIFY — did it actually work?                               │  │
│ │                                                                 │  │
│ │ Agent calls task_complete(itemId) when it thinks item is done.  │  │
│ │ Middleware runs gate (from verified-loop):                       │  │
│ │   createTestGate(["bun", "test"])  → exit code 0 = pass         │  │
│ │   createFileGate(path, /pattern/)  → file contains match = pass │  │
│ │   createCompositeGate([g1, g2])    → all sub-gates pass         │  │
│ │                                                                 │  │
│ │ Gate passes → item marked done.                                 │  │
│ │ Gate fails  → learning recorded, agent retries.                 │  │
│ │ 3 failures  → item auto-skipped.                                │  │
│ │                                                                 │  │
│ │ Shifts from "LLM says done" to "external proof."                │  │
│ └─────────────────────────┬───────────────────────────────────────┘  │
│                           │                                          │
│                           ▼                                          │
│ ┌─────────────────────────────────────────────────────────────────┐  │
│ │ 5. EVOLVE — learn from outcomes                                 │  │
│ │                                                                 │  │
│ │ feedback-loop tracks success/failure/latency per agent brick:   │  │
│ │   Success → fitness ↑, trail strength ↑ (stigmergy)             │  │
│ │   Failure → fitness ↓                                           │  │
│ │                                                                 │  │
│ │ Demotion: errorRate ≥ 30% → demote trustTier                   │  │
│ │   promoted → verified → sandbox (floor)                         │  │
│ │                                                                 │  │
│ │ Quarantine: errorRate ≥ 50% → stop using this variant           │  │
│ │   lifecycle: "active" → "quarantined" (terminal, needs re-forge)│  │
│ │                                                                 │  │
│ │ Mutation pressure: fitness > 0.9 → freeze capability space      │  │
│ │   Blocks forging more variants when incumbent is strong.        │  │
│ │                                                                 │  │
│ │ Crystallize: agent always does same 5 tool calls?               │  │
│ │   → forge composite tool that replaces spawning entirely        │  │
│ │   → cheaper, faster, no cold-start next time                    │  │
│ └─────────────────────────┬───────────────────────────────────────┘  │
│                           │                                          │
│                           └──── back to DETECT (next task/message)   │
└──────────────────────────────────────────────────────────────────────┘
```

How it wires into the existing system:

```
Existing system (no changes needed):

  Gateway ─────── Node ─────── createKoi ─────── Middleware chain
                                    │
                                    │ providers: [ipcProvider, memoryProvider,
                                    │             schedulerProvider,
                                    │             ...autonomousBundle.providers]
                                    │
                                    │ middleware: [payMiddleware,
                                    │             ...governanceBundle.middleware,
                                    │             ...autonomousBundle.middleware]
                                    │
                                    ▼
                             Agent has ALL tools:
                               ipc_send, ipc_discover    (from ipc-nexus)
                               memory_store/recall        (from memory-fs)
                               scheduler_schedule/...     (from scheduler-provider)
                               plan_autonomous            (from autonomous middleware)
                               task_complete              (from autonomous middleware)
                               task_status                (from autonomous middleware)
                               parallel_task              (from parallel-minions)
                               task                       (from task-spawn)
                               orchestrate                (from orchestrator)
                               forge_tool, forge_agent    (from forge)

The autonomous middleware composes with governance. Priority ordering:

  100  permissions           (governance)
  110  exec-approvals        (governance)
  120  delegation            (governance)
  150  governance-backend    (governance)
  200  autonomous-middleware (autonomous — plan/complete/verify)
  220  tool-squash           (context-arena)
  225  compactor             (context-arena)
  250  ctx-editing           (context-arena)
  300  audit                 (governance)
  340  pii                   (governance)
  350  sanitize              (governance)

Governance runs BEFORE autonomous — permissions/approvals gate tool calls.
Context-arena runs AFTER autonomous — compaction respects pinned messages.
Audit sees everything — including plan_autonomous and task_complete calls.
```

Scheduler + autonomous interaction (daily briefing):

```
┌───────────────────────────────────────────────────────────────────┐
│ Personal Assistant (always-on, ThreadId: "user-alice")            │
│ Middleware: governance + autonomous (verified preset) + arena     │
│                                                                   │
│ 1. User: "Set up daily briefing at 8am"                          │
│    → Agent calls scheduler_schedule("0 8 * * *", ...)            │
│                                                                   │
│ [Night passes]                                                    │
│                                                                   │
│ 2. Scheduler fires at 8am                                        │
│    → Nexus dispatches via IPC → agent mailbox                    │
│    → Engine inbox queues message (agent idle or busy)            │
│                                                                   │
│ 3. Agent wakes (idle → running), sees briefing task              │
│    → Calls task({ description: "daily briefing",                 │
│                   agent_type: "briefing-copilot" })               │
│    │                                                              │
│    ├─ findLive("briefing-copilot") → AgentId found?              │
│    │   YES → message warm copilot (Day 2+, thread persists)      │
│    │   NO  → auto-create copilot from manifest (#687)            │
│    │         copilot runs → returns result → transitions to idle  │
│    │         registered in AgentRegistry for next findLive()      │
│    │                                                              │
│ 4. Result flows back via ChildCompletionResult                   │
│    → Agent sends briefing to user via Telegram channel           │
│    → Agent transitions to idle, awaits next message/cron         │
└───────────────────────────────────────────────────────────────────┘
```

Layer compliance:

```
L0 (core):    ThreadId, ThreadStore interface, CheckpointPolicy
              "idle" + "background" ProcessState
              Gate interfaces (VerificationFn, GateContext)
              BrickArtifact{kind:"agent"} (already exists)
              → pure types, zero imports ✅

L1 (engine):  Thread-aware engine decorator (auto-checkpoint)
              Engine inbox (FIFO queue per agent)
              idle ↔ running transitions
              background state on child spawn
              → depends only on L0 ✅

L2 (feature): Autonomous middleware (plan/complete/verify)
              ThreadStore backends (SQLite, Nexus)
              ForgeAgentResolver (catalog + variant-selection)
              Agent fitness tracking (extend feedback-loop)
              Agent demand heuristics (extend forge-demand)
              parallel-minions, task-spawn, orchestrator (exist)
              → depends only on L0/L0u ✅

L3 (bundle):  @koi/autonomous bundles middleware + providers
              Presets: minimal / standard / verified / full
              Follows @koi/governance pattern exactly
              → re-exports + wiring only ✅
```

Comparison with other frameworks (OpenClaw, OpenHands, LangGraph):

```
┌──────────────────────┬─────────┬──────────┬───────────┬──────────┐
│ Capability           │ Koi     │ OpenClaw │ OpenHands │ LangGraph│
│                      │ (plan)  │          │ V1        │          │
├──────────────────────┼─────────┼──────────┼───────────┼──────────┤
│ Idle state           │ ✅ #687 │ ✅       │ ✅        │ ✗        │
│ Worker pool          │ ✅ #687 │ ✅       │ ✗ (prop.) │ ✗        │
│ Engine inbox/queue   │ ✅ #684 │ ✅ lanes │ ✅ FIFO   │ ✗        │
│ Thread persistence   │ ✅ #684 │ ✅       │ ✅ events │ ✅ ckpt  │
│ Auto-checkpoint      │ ✅ #684 │ internal │ ✅ auto   │ ✅ nodes │
│ Parallel delegation  │ ✅ exist│ ✗        │ ✅ V1     │ ✗        │
│ DAG orchestration    │ ✅ exist│ ✗        │ ✗         │ ✅ graph │
│ Copilot routing      │ ✅ exist│ ✗        │ ✗         │ ✗        │
│ Self-extend (forge)  │ ✅ exist│ ✗        │ ✗         │ ✗        │
│ Fitness tracking     │ ✅ exist│ ✗        │ ✗         │ ✗        │
│ Variant selection    │ ✅ exist│ ✗        │ ✗         │ ✗        │
│ Demand detection     │ ✅ exist│ ✗        │ ✗         │ ✗        │
│ Verified completion  │ ✅ exist│ ✗        │ ✗         │ ✗        │
│ Forge→delegate bridge│ ✅ #688 │ ✗        │ ✗         │ ✗        │
└──────────────────────┴─────────┴──────────┴───────────┴──────────┘

Unique to Koi: the DETECT → DISCOVER → DELEGATE → VERIFY → EVOLVE
loop does not exist in any other framework. Individual pieces exist
(OpenClaw has idle+pool, OpenHands has persistence, LangGraph has
checkpoints), but nobody combines delegation + evolution + verification
in a single middleware-composable layer.
```


L3 META-PACKAGES (convenience bundles — re-export from L0 + L1 + L2)
═════════════════════════════════════════════════════════════════════

┌──────────────────────────────────────────────────────────────────────┐
│ @koi/governance (L3)                                                  │
│ "One-line enterprise compliance for AI agents"                        │
│                                                                      │
│ createGovernanceStack(config) → GovernanceBundle                      │
│   { readonly middlewares: KoiMiddleware[],                            │
│     readonly providers:  ComponentProvider[] }                        │
│                                                                      │
│ GovernanceStackConfig:                                                │
│   preset?:            "open" | "standard" | "strict"                 │
│   backend?:           "pattern" | "nexus"                            │
│   permissions?:       PermissionsMiddlewareConfig                     │
│   execApprovals?:     ExecApprovalsConfig                             │
│   delegation?:        DelegationMiddlewareConfig                      │
│   governanceBackend?: GovernanceBackendMiddlewareConfig                │
│   audit?:             AuditMiddlewareConfig                           │
│   pii?:               PIIConfig                                       │
│   sanitize?:          SanitizeMiddlewareConfig                        │
│   guardrails?:        GuardrailsConfig                                │
│   scope?:             ManifestScopeConfig                             │
│   All fields optional — preset fills defaults.                        │
│                                                                      │
│ Presets:                                                              │
│   "open":     audit only (dev/testing)                                │
│   "standard": permissions + exec-approvals + audit +                  │
│               pii + sanitize + guardrails                             │
│   "strict":   all middleware + scope + governance-backend              │
│                                                                      │
│ middlewares[] — up to 9, priority-ordered:                             │
│   100 permissions         300 audit                                   │
│   110 exec-approvals      340 pii                                     │
│   120 delegation          350 sanitize                                │
│   150 governance-backend  375 guardrails                              │
│                                                                      │
│ providers[] — scope (filesystem/browser/credentials/memory)           │
│              + delegation provider (tools for runtime grants)         │
│                                                                      │
│ Manifest (via @koi/starter):                                          │
│   middleware:                                                         │
│   - name: permissions                                                 │
│     options:                                                          │
│       rules:                                                          │
│         allow: ["read_file:/workspace/**", "group:fs_read"]           │
│         deny:  ["bash:rm -rf *"]                                      │
│         ask:   ["bash:*"]                                             │
│   scope:                                                              │
│     filesystem: { root: /workspace, mode: ro }                        │
│     browser: { allowedDomains: [docs.example.com] }                   │
│     credentials: { keyPattern: "api_*" }                              │
│     memory: { namespace: research }                                   │
│                                                                      │
│ Code wiring:                                                          │
│   // Option A: preset                                                 │
│   const { middlewares, providers } =                                   │
│     createGovernanceStack({ preset: "standard" })                     │
│                                                                      │
│   // Option B: pick individually                                      │
│   const { middlewares, providers } = createGovernanceStack({           │
│     permissions: { backend: myBackend },                              │
│     audit: { sink: myAuditSink },                                     │
│     scope: { filesystem: { root: "/workspace", mode: "ro" } },       │
│   })                                                                  │
│                                                                      │
│   const runtime = await createKoi(manifest, adapter, {                │
│     middleware: [...middlewares],                                      │
│     providers: [...providers],                                        │
│   })                                                                  │
│                                                                      │
│ Deployment tiers:                                                     │
│   Dev/testing:   "open"  (audit only)                                 │
│   Single agent:  "standard" (production defaults)                     │
│   Multi-agent:   "strict" (+ delegation + governance-backend)         │
│   Enterprise:    "strict" + backend: "nexus" (ReBAC)                  │
│                                                                      │
│ ReBAC rule management (two sources):                                  │
│   Static (deploy): admin sets ceiling on Nexus server                 │
│     agent:supervisor#writer@folder:/src                               │
│   Dynamic (runtime): agents call delegation tools                     │
│     monotonic attenuation: can only narrow, never widen               │
│     Nexus auto-syncs tuples on grant/revoke                           │
└──────────────────────────────────────────────────────────────────────┘

  (context-arena is also L3 — see wiring table above for details)
```

---

## How they relate

```
registry-event-sourced + events-nexus (what exists today)
─────────────────────────────────────────────────────────

  L2  createNode({ registry })
        │
        │ calls AgentRegistry interface
        ▼
  L2  registry-event-sourced ──implements──► AgentRegistry (L0)
        │
        │ needs an EventBackend
        ▼
  L2  events-nexus ──implements──► EventBackend (L0)
        │
        │ stores on
        ▼
      Nexus filesystem (JSON files)

  L2 → L2 → L2 → Nexus.  Three packages. Two layers.


registry-nexus (proposed, replaces the above as default)
────────────────────────────────────────────────────────

  L2  createNode({ registry })
        │
        │ calls AgentRegistry interface
        ▼
  L2  registry-nexus ──implements──► AgentRegistry (L0)
        │
        │ direct HTTP
        ▼
      Nexus API

  L2 → L2 → Nexus.  Two packages. One layer.


ipc-nexus (exists, agent-to-agent messaging)
─────────────────────────────────────────────

  L1  createKoi({ providers: [ipcNexusProvider] })  ← only L1 in this doc
        │
        │ provider.attach(agent) → attaches MAILBOX + tools
        │ if registry provided → also attaches ipc_discover tool
        ▼
  L2  ipc-nexus ──implements──► MailboxComponent (L0)
        │                  ╲
        │ REST API          ╲ optional: reads AgentRegistry (L0)
        ▼                    ╲ for ipc_discover
      Nexus IPC server        ▼
      (/api/v2/ipc/*)       registry.list() → live agents

  L1 → L2 → Nexus.  Agent-facing (provides tools via ComponentProvider).


  Agent A                    Nexus IPC                   Agent B
  ────────                   ─────────                   ────────
  1. LLM calls ipc_discover
     → returns [{id:"agent-b", state:"running"}, ...]

  2. LLM calls ipc_send ──►  POST /send  ──► stored ──►  polling inbox
     { to: "agent-b",                                     GET /inbox/b
       kind: "request",                                        │
       type: "code-review",                                    ▼
       payload: {...} }                              onMessage handler
                                                     processes request
                                                           │
                                                     LLM calls ipc_send
                                                     { to: "agent-a",
                                                       kind: "response",
                                                       correlationId: "..." }


pay-nexus + middleware-pay (backend + one consumer)
───────────────────────────────────────────────────

  One L0 contract (PayLedger), one backend (pay-nexus),
  one existing consumer (middleware-pay). Same pattern as registry.

  L1  createKoi({ middleware: [payMiddleware] })
        │
        │ wrapModelCall → check budget, record cost
        ▼
  L2  middleware-pay ──uses──► PayLedger (L0) directly
        │                       meter(), getBalance(), canAfford()
        │
        │ Option A: in-memory (dev)     Option B: Nexus-backed (prod)
        │ createInMemoryPayLedger()     createNexusPayLedger()
        │                                    │
        │                                    │ HTTP
        │                                    ▼
        │                              L2  pay-nexus ──implements──► PayLedger (L0)
        │                                    │
        │                                    ▼
        │                              Nexus Pay API (/api/v2/pay/*)
        │                              TigerBeetle + PostgreSQL

  No adapter layer. middleware-pay consumes PayLedger (L0) directly.
  Same swap pattern as registry (in-memory for dev, Nexus for prod).

  Future consumers: L2 agent tools for transfer/reserve (not built yet).
  PayLedger's full API (transfer, reserve/commit/release) goes beyond
  budget enforcement — but no L2 consumer exists for those yet.


agent-procfs (sidecar — not middleware, not provider)
─────────────────────────────────────────────────────

  Caller code (app-level — L2 can't import peer L2, no L3 imports @koi/node):

    const node = createNode(config, { registry })
    const procFs = createProcFs({ cacheTtlMs: 1000 })
    const mounter = createAgentMounter({
      registry, procFs,
      agentProvider: (id) => node.getAgent(id),
    })

  That's it. Mounter watches registry.watch() for register/deregister.
  No L1 involvement. No createKoi() wiring. No manifest.

    Agent registers → mounter mounts 7 entries
        │
        ▼
    procFs (in-memory Map<path, lazy lambda>)
        │
        │ read("/agents/a1/tools")
        │   → lambda calls agent.query("tool:")
        │   → returns live data, cached 1s
        │
        │ read("/agents/a1/children")
        │   → lambda calls registry.list({ parentId: a1 })
        │   → returns live registry data
        │
        │ write("/agents/a1/metrics", { priority: 0 })
        │   → lambda calls registry.patch(a1, { priority: 0 })
        │
        │ Agent deregisters → mounter unmounts all 7
        ▼
    No persistence. No backend. Ephemeral in-memory only.

  Data sources (where each entry reads from):

    /agents/<id>/status      → Agent entity (agent.pid, agent.state)
    /agents/<id>/tools       → Agent ECS map (agent.query("tool:"))
    /agents/<id>/middleware   → Agent ECS map (agent.query("middleware:"))
    /agents/<id>/config      → Agent manifest (agent.manifest)
    /agents/<id>/env         → Agent ECS map (agent.component(ENV))
    /agents/<id>/children    → AgentRegistry (registry.list({ parentId }))
    /agents/<id>/metrics     → AgentRegistry (registry.lookup(id))

  Key property: procfs is NOT the source of truth for anything.
  It's a read-through cache over existing sources (Agent entity + registry).
  If the Agent entity or registry changes, the next read() returns fresh data.

  Comparison with other ComponentProvider-based packages:

    ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬───────────────────┐
    │              │ filesystem   │ ipc-nexus    │ memory-fs    │ delegation   │ agent-procfs      │
    │              │              │              │              │ (#671)       │                   │
    ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┼───────────────────┤
    │ Pattern      │ Provider     │ Provider     │ Provider     │ Provider     │ Sidecar           │
    │ In createKoi │ Yes          │ Yes          │ Yes          │ Yes          │ No                │
    │ Gives tools  │ fs_read,     │ ipc_send,    │ memory_store,│ delegation_  │ None today        │
    │ to agents    │ fs_write,    │ ipc_list     │ memory_recall│   grant,     │                   │
    │              │ fs_edit,     │              │              │ delegation_  │                   │
    │              │ fs_list,     │              │              │   revoke,    │                   │
    │              │ fs_search,   │              │              │ delegation_  │                   │
    │              │ fs_semantic_ │              │              │   list       │                   │
    │              │ search (#666)│              │              │              │                   │
    │ Gives skills │ No           │ No           │ skill:memory │ No           │ None today        │
    │ Backend      │ Local or     │ Nexus IPC    │ Local FS     │ In-memory +  │ None (in-memory)  │
    │              │ Nexus FS     │              │              │ Nexus ReBAC  │                   │
    │              │              │              │              │ (via hooks)  │                   │
    │ Persistence  │ Disk or      │ Nexus server │ JSON files   │ In-memory or │ Ephemeral         │
    │              │ Nexus server │              │              │ Nexus tuples │                   │
    │ Security     │ Scoped root  │ Agent-scoped │ Per-agent    │ HMAC-signed, │ N/A               │
    │              │ + rw/ro mode │ (own mailbox)│ baseDir      │ monotonic    │                   │
    │              │ via @koi/    │              │              │ attenuation, │                   │
    │              │ scope        │              │              │ cascade      │                   │
    │ Shared FS    │ Nexus: same  │ N/A          │ N/A          │ Grants write │ N/A               │
    │ isolation    │ server, each │              │              │ ReBAC tuples │                   │
    │              │ agent scoped │              │              │ → per-file   │                   │
    │              │ to own root  │              │              │ sharing      │                   │
    │ Agents can   │ Yes (tools)  │ Yes (tools)  │ Yes (tools)  │ Yes (tools)  │ No (app code only)│
    │ access it    │              │              │              │              │                   │
    └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴───────────────────┘


filesystem (agent file access — local or shared Nexus)
──────────────────────────────────────────────────────

  L0 contract: FileSystemBackend (read, write, edit, list, search, delete, rename)
  L2 provider: @koi/filesystem — createFileSystemProvider({ backend, retriever? })
  ECS token: FILESYSTEM

  Packages:

    @koi/filesystem          (L2) — ComponentProvider, wraps backend as tools
    @koi/filesystem-nexus    (L2, planned #673) — FileSystemBackend → Nexus RPC
    @koi/workspace           (L2) — creates workspace dir (git worktree/docker/tmp)
    @koi/scope               (L0u) — createScopedFileSystem + createEnforcedFileSystem
    @koi/search-nexus        (L2) — Retriever + Indexer → Nexus REST
    @koi/permissions-nexus   (L2) — NexusScopeEnforcer → per-file ReBAC

  Relationship between workspace and filesystem:

    @koi/workspace   = WHERE (creates the directory: /agents/{id}/workspace)
    @koi/filesystem  = HOW   (tools: fs_read, fs_write, etc.)
    @koi/scope       = BOUNDARY (path containment + rw/ro + enforcer)

    workspace.create(agentId) → { path: "/agents/agent-1/workspace" }
      ↓ path flows into
    createFileSystemProvider({ backend, scope: { root: path, mode: "rw" } })
      ↓ agent gets
    fs_read, fs_write, fs_edit, fs_list, fs_search — scoped to that path

  Initialization (4 patterns):

    // Pattern 1: Local filesystem (dev/single-node)
    const backend = createLocalFileSystem({ root: "/workspace" })
    const fsProvider = createFileSystemProvider({ backend })

    // Pattern 2: Nexus shared filesystem (multi-node) (#673)
    const backend = createNexusFileSystem({ client })
    const retriever = createNexusRetriever({ baseUrl, apiKey })  // same server!
    const fsProvider = createFileSystemProvider({ backend, retriever })
    // Agent gets fs_semantic_search for free — Nexus indexes on write

    // Pattern 3: Via governance preset (auto-wired)
    const { providers, middlewares } = createGovernanceStack({
      scope: { filesystem: { root: ".", mode: "rw" } },
      ...
    })
    // Governance wraps the backend with createScopedFileSystem automatically

    // Pattern 4: L3 workspace bundle — one call, everything wired (#673)
    const { providers, enforcer } = createNexusWorkspaceStack({
      nexusBaseUrl, nexusApiKey, agentId,
      scope: { mode: "rw" },
    })
    // Agent gets: 7 fs tools + semantic search + per-file permissions
    //   + cross-agent sharing (via delegation #671) + shared across nodes

  What you get for free with Nexus backend:

    ┌─────────────────────┬──────────────────────────────────────────┐
    │ Capability          │ How (no extra code)                      │
    ├─────────────────────┼──────────────────────────────────────────┤
    │ Semantic search     │ Nexus indexes on write → Retriever free  │
    │                     │ fs_semantic_search tool (#666)            │
    ├─────────────────────┼──────────────────────────────────────────┤
    │ Per-file permissions│ NexusScopeEnforcer → permissions.check   │
    │                     │ ReBAC tuples: agent:X#reader@folder:/src │
    ├─────────────────────┼──────────────────────────────────────────┤
    │ Cross-agent sharing │ delegation_grant (#671) writes tuples    │
    │                     │ → NexusScopeEnforcer allows delegatee    │
    ├─────────────────────┼──────────────────────────────────────────┤
    │ Shared across nodes │ All nodes → same Nexus server            │
    │                     │ Agent on node 1 writes, node 2 reads     │
    └─────────────────────┴──────────────────────────────────────────┘

  Security — 4 layers (all automatic with L3 bundle):

    1. Scope (path boundary):
       createScopedFileSystem(backend, { root: "/workspace", mode: "rw" })
       → Agent can only see files under /workspace
       → Even on shared Nexus, each agent has its own scoped root
       → Path traversal ("../../etc/passwd") blocked at resolve() time

    2. Enforcer (per-file ReBAC):
       createEnforcedFileSystem(backend, nexusScopeEnforcer)
       → Every fs_read/fs_write calls permissions.check RPC
       → Nexus checks ReBAC tuple: agent:X#reader@folder:/path
       → Cross-agent sharing: delegation writes tuples (#671)

    3. Permissions (tool-level):
       Manifest: permissions: { allow: ["group:fs_read"], deny: ["group:fs_delete"] }
       → Agent cannot even see fs_delete in its tool list
       → Denied tools removed from ModelRequest before LLM sees them

    4. Governance (policy-level):
       GovernanceBackend.evaluate({ tool: "fs_write", resource: path })
       → Policy can block specific write targets, rate-limit, audit

  L3 bundle composition (#673):

    createNexusWorkspaceStack()
      │
      ├─ @koi/filesystem-nexus (L2)  → FileSystemBackend → Nexus RPC
      │
      ├─ @koi/scope (L0u)
      │    createEnforcedFileSystem   → NexusScopeEnforcer (per-file perms)
      │    createScopedFileSystem     → root + rw/ro (path boundary)
      │
      ├─ @koi/search-nexus (L2)      → Retriever (semantic search, free)
      │
      ├─ @koi/permissions-nexus (L2)  → NexusScopeEnforcer (ReBAC checks)
      │
      └─ @koi/filesystem (L2)         → ComponentProvider + tools
           fs_read, fs_write, fs_edit, fs_list, fs_search,
           fs_semantic_search (#666)

    No L2→L2 coupling. L3 is the composition point.
    Each L2 imports only from L0 + L0u.

  Shared Nexus filesystem — how isolation works:

    Agent A (scope: /agents/a/workspace)     Agent B (scope: /agents/b/workspace)
    ────────────────────────────────────     ────────────────────────────────────
    fs_read("/src/main.ts")                  fs_read("/src/main.ts")
      → resolves to /agents/a/workspace/       → resolves to /agents/b/workspace/
        src/main.ts on Nexus                     src/main.ts on Nexus
      → different files, same tool call        → different files, same tool call

    fs_read("../../agents/b/workspace/x")    fs_semantic_search("auth logic")
      → BLOCKED: path escapes root              → only searches /agents/b/workspace/
                                                   (Nexus scopes the query)

    Agent A shares with B (#671):
      delegation_grant({ delegateeId: "agent:b",
        resources: ["fs_read:/agents/a/workspace/shared/**"] })
      → writes ReBAC tuple → agent:b#reader@folder:/agents/a/workspace/shared
      → Agent B can now fs_read("/agents/a/workspace/shared/doc.md") ✅
      → Agent B still can't read /agents/a/workspace/private/ ❌

  Semantic search (#666):

    When retriever is provided, provider registers fs_semantic_search tool:
      Input: { query: "authentication flow", limit?: 10 }
      Output: ranked chunks with path, score, chunk_text

    With Nexus backend: free — server indexes files on write
    With local backend: caller provides @koi/search BM25 retriever


scheduler + scheduler-provider (sidecar — cron + task queue)
────────────────────────────────────────────────────────────

  App code (same process as node, but separate L2 — can't import node):

    const scheduler = createScheduler(config, store, queueBackend)
    const schedulerProvider = createSchedulerProvider(scheduler)
    node.dispatch(pid, manifest, engine, [schedulerProvider])

  Agent gets 9 tools. Scheduler runs cron + timing independently.

    Agent A                      Scheduler              Nexus
    ────────                     ─────────              ─────
    scheduler_schedule(          stores cron
      "0 9 * * *",              definition
      "daily report",
      { agentId: "agent-b" }
    )
                                 ┌──────────┐
                                 │ 9:00 AM  │
                                 │ cron     │
                                 │ fires    │
                                 └────┬─────┘
                                      │
                                      ▼
                                 submit(task,         enqueue
                                   idempotencyKey) ──►  │
                                                        ├─ Astraea priority
                                                        ├─ aging + boost
                                                        ▼
                                                     dequeue ready
                                                        │
                                                        ▼
                                                     ipc.send("agent-b",
                                                       task) ──► agent-b
                                                                 mailbox

  Koi owns: cron, timing, retry, tools (WHEN + interface).
  Nexus owns: priority queue, dispatch via IPC (WHAT + HOW).
  Multi-node cron dedup: Nexus idempotency_key.

  Comparison of sidecars:

    ┌──────────────┬───────────────────┬────────────────────────────┐
    │              │ agent-procfs      │ scheduler                  │
    ├──────────────┼───────────────────┼────────────────────────────┤
    │ Purpose      │ Diagnostic        │ Task scheduling            │
    │ In createKoi │ No                │ No (but provider is)       │
    │ Gives tools  │ None today        │ 9 tools (via provider)     │
    │ Agent-facing │ No (app code)     │ Yes (via scheduler-provider│
    │ Backend      │ None (in-memory)  │ SQLite (dev) / Nexus (prod)│
    │ Persistence  │ Ephemeral         │ Yes                        │
    │ Watches      │ Registry events   │ Cron timers + queue        │
    └──────────────┴───────────────────┴────────────────────────────┘


verified-loop (autonomy orchestrator — external verification)
─────────────────────────────────────────────────────────────

  Not a middleware, provider, or sidecar. An outer loop that wraps L1.

  ┌───────────────────────────────────────────────────────────────────┐
  │ Consumer app                                                      │
  │   │                                                               │
  │   ▼                                                               │
  │ createVerifiedLoop(config)                                        │
  │   │                                                               │
  │   │ for each iteration (1..maxIterations):                        │
  │   │   ┌─────────────────────────────────────────────────────────┐ │
  │   │   │ 1. Read PRD → pick next item                           │ │
  │   │   │ 2. Build prompt (currentItem + learnings + history)    │ │
  │   │   │ 3. RunIterationFn → createKoi (FRESH runtime)          │ │
  │   │   │      └── adapter + middleware + providers               │ │
  │   │   │      └── yields EngineEvent stream                      │ │
  │   │   │ 4. VerificationFn → gate checks (tests, files, custom) │ │
  │   │   │ 5. Gate pass → markDone | Gate fail → counter++         │ │
  │   │   │ 6. Append learning to rolling journal                  │ │
  │   │   └─────────────────────────────────────────────────────────┘ │
  │   │                                                               │
  │   ▼                                                               │
  │ VerifiedLoopResult { completed[], skipped[], learnings[] }        │
  └───────────────────────────────────────────────────────────────────┘

  State on disk:
    PRD file (JSON)       — task list + progress tracking
    Learnings file (JSON) — rolling journal (last 50 entries)

  Why it matters for multi-node:
    - Each iteration creates a FRESH Koi runtime → clean context window
    - Filesystem is the shared state → works across context resets
    - Gate is external verification → prevents LLM hallucinating completion
    - Stuck-loop detection → skips items after 3 consecutive failures
    - Can compose with IPC + scheduler: scheduler triggers loop,
      loop runs iterations, IPC delivers results to supervisor

  Layer: L0u. Depends on @koi/core + @koi/errors only.
  Consumer wires their own createKoi + adapter + gates.


memory-fs (agent long-term memory with decay + auto-digest)
───────────────────────────────────────────────────────────

  L1  createKoi({ providers: [memoryProvider] })
        │
        │ provider.attach(agent) → attaches MEMORY + 3 tools + skill
        ▼
  L2  memory-fs ──implements──► MemoryComponent (L0)
        │
        │ local filesystem (JSON files)
        ▼
      <baseDir>/entities/<slug>/items.json + summary.md

  L1 → L2 → local disk.  No Nexus dependency.

  Search (optional DI — not wired today):

    memory-fs accepts optional retriever + indexer for semantic recall:
      createFsMemory({ ..., retriever?, indexer? })
    When provided, memory_recall uses semantic search; without, recency-only.

    Backends exist:
      @koi/search (L2)        — BM25/SQLite local
      @koi/search-nexus (L2)  — Nexus REST remote
    Contracts in @koi/search-provider (L0u): Retriever, Indexer, Embedder

    Gap: context-arena (L3) creates memory-fs without retriever/indexer.
    Semantic search is unreachable through the standard L3 wiring path.
    See issue #664.

  The skill is auto-injected as a SkillComponent — LLM receives behavioral
  instructions (when to store, how to recall, decay tiers) without
  manifest configuration. The 3 tools are auto-attached via ComponentProvider.

  Auto-digest pipeline (survives context compaction):

    Conversation messages (about to be compacted)
          │
          ▼
    middleware-compactor → createFactExtractingArchiver(memory)
          │
          │ extracts structured facts: category + related entities
          ▼
    memory.store(fact, { category, relatedEntities })
          │
          ▼
    Persisted in entities/<slug>/items.json
    → dedup (Jaccard), supersession, decay scoring
    → available for future recall even after messages discarded

  Agent tool use flow:

    1. LLM calls memory_store("Alice is CTO at Acme",
         { category: "relationship", related_entities: ["alice", "acme"] })
       → fact persisted, deduped, entity-linked

    2. LLM calls memory_recall("What do I know about Alice?",
         { tier: "hot", graph_expand: true })
       → returns scored results with tier + decay, expands causal edges

    3. LLM calls memory_search({ entity: "alice" })
       → returns all facts about Alice across categories
       OR memory_search({}) → lists all known entities


permissions + scope + governance (3 security layers)
────────────────────────────────────────────────────

  LLM wants to call: fs_write("/etc/passwd", "data")

  Layer 1 — Tool permissions (middleware-permissions):

    wrapModelCall (before LLM sees tools):
      batch-check all tools → fs_write allowed? denied? ask?
      if denied → remove from ModelRequest.tools (LLM never sees it)
      if ask → prompt human

    wrapToolCall (at execution time):
      re-check fs_write against PermissionBackend (L0)
        │
        ├── Option A: createPatternPermissionBackend()
        │     glob rules: allow: ["group:fs_write"]
        │     local, sync, zero network
        │
        └── Option B: createNexusPermissionBackend()
              HTTP → Nexus ReBAC graph traversal
              Zanzibar tuples: agent:coder#writer@folder:/src

      allow → continue to Layer 2
      deny  → KoiRuntimeError("PERMISSION")
      ask   → prompt human, cache approval

  Layer 2 — Scope enforcement (@koi/scope):

    Tool executes → calls scopedFilesystem.write("/etc/passwd", ...)
      │
      ├── Local boundary check:
      │     root = /workspace
      │     /etc/passwd outside root → BLOCKED
      │     (even though tool permission was granted)
      │
      └── Optional enforcer (ScopeEnforcer L0):
            checkAccess({ subsystem: "filesystem",
                          operation: "write",
                          resource: "/etc/passwd" })
              │
              ├── local patterns → false (blocked)
              └── Nexus ReBAC → check tuple → false (blocked)

  Layer 3 — Governance policy (middleware-governance-backend):

    wrapToolCall → evaluate PolicyRequest:
      kind: "tool_call", agentId, payload: { tool: "fs_write" }
        │
        └── GovernanceBackend.evaluate()
              ok: true → proceed
              ok: false + violations → throw, block

  All three layers are independent and optional.
  governance L3 bundle (#641) will wire them together with presets.


delegation + file sharing (#671)
────────────────────────────────

  What exists today:

    DelegationManager       — grant, attenuate, revoke (cascade), verify
    DelegationScope         — { permissions: PermissionConfig, resources?: string[] }
    .resources              — glob patterns: "fs_read:/project/src/**"
    verify.ts:110           — matchToolAgainstScope() enforces resource globs
    DELEGATION ECS token    — defined in L0, ready for ComponentProvider
    DelegationComponent     — grant/revoke/verify/list interface (L0)
    Delegation middleware   — priority 120, verifies grants on every tool call
    NexusScopeEnforcer      — per-file path checks via Nexus permissions.check
    FS_OPERATION_RELATIONS  — read→reader, write→writer, delete→deleter
    CapabilityProof         — hmac-sha256 (internal), ed25519 (chain), nexus (v2)

  What's planned (#671):

    DelegationComponentProvider (L2) — wraps DelegationManager, 3 tools:
      delegation_grant   — grant another agent file/tool access
      delegation_revoke  — revoke with cascade
      delegation_list    — list active grants issued by this agent

    onGrant/onRevoke hooks on DelegationManager (L2) — DI callbacks:
      Consumer: governance (L3), avoids L2→L2 coupling

    permissions.grant RPC on permissions-nexus (L2) — write ReBAC tuples

    Governance bridge wiring (L3) — connects hooks → Nexus:
      onGrant  → nexusPerms.grant(tuple)      — writes ReBAC tuple
      onRevoke → nexusRevocations.revoke(id)   — already exists!

    Auto-delegation at spawn (L1) — attenuated grant from parent → child

  Architecture — why L3 is the bridge:

    @koi/delegation (L2)          @koi/permissions-nexus (L2)
    ────────────────────          ──────────────────────────
    DelegationManager              NexusPermissionBackend
      onGrant?: callback  ←─── wired by ───→  permissions.grant RPC
      onRevoke?: callback ←─── wired by ───→  revocations.revoke RPC
                                      │
                           @koi/governance (L3)
                           imports BOTH L2 packages
                           connects the callbacks
                           zero L2→L2 coupling

  Two agent creation patterns:

    Pattern 1: Sub-agent (spawn) — auto-inherit
    ────────────────────────────────────────────

      Parent has: agent:parent#editor@folder:/project
      Parent spawns child →
        Engine auto-creates attenuated DelegationGrant:
          issuerId: parent, delegateeId: child
          scope.resources: ["fs_read:/project/subtask/**"]  (narrowed)
        onGrant hook → governance → permissions.grant RPC → Nexus tuple:
          agent:child#reader@folder:/project/subtask
        Child gets DelegationComponent + enforced filesystem
        Child calls fs_read("/project/subtask/file.ts")
          → EnforcedFileSystem → NexusScopeEnforcer
          → permissions.check → tuple exists → allowed ✅

    Pattern 2: Co-pilot (new workspace) — explicit grant
    ─────────────────────────────────────────────────────

      Co-pilot created with brand new workspace /agents/copilot-1/
        → No inherited permissions, no parent
        → Own scoped filesystem: root=/agents/copilot-1/workspace

      Agent A explicitly shares:
        delegation_grant({
          delegateeId: "agent:copilot-1",
          permissions: { allow: ["fs_read", "fs_write"] },
          resources: [
            "fs_read:/agents/A/workspace/shared-docs/**",
            "fs_write:/agents/A/workspace/shared-docs/report.md"
          ],
          ttlMs: 3600000
        })
        → DelegationGrant created (HMAC-signed)
        → onGrant → Nexus tuples:
            agent:copilot-1#reader@folder:/agents/A/workspace/shared-docs
            agent:copilot-1#writer@file:/agents/A/workspace/shared-docs/report.md
        → Co-pilot can read shared-docs, write report.md only

  Full enforcement chain for delegated file access:

    Agent B calls fs_read("/agents/A/workspace/shared-docs/design.md")
      │
      ├─ 1. Permissions middleware (priority 100)
      │    "can agent:B call fs_read?" → tool-level check → allowed
      │
      ├─ 2. Delegation middleware (priority 120)
      │    ctx.metadata.delegationId → look up grant → verifyGrant():
      │      signature ✓, expiry ✓, revocation ✓, chain depth ✓
      │      matchToolAgainstScope("fs_read", scope) → glob match ✓
      │
      ├─ 3. Governance backend (priority 150)
      │    PolicyRequest { tool: "fs_read", input: { path } }
      │      → GovernanceBackend.evaluate() → ok
      │
      ├─ 4. Tool executes → backend.read(path)
      │
      ├─ 5. EnforcedFileSystem → NexusScopeEnforcer
      │    checkAccess({ subsystem: "filesystem", operation: "read",
      │                  resource: "/agents/A/workspace/shared-docs/design.md",
      │                  context: { agentId: "agent:B" } })
      │      → Nexus permissions.check RPC
      │      → tuple: agent:B#reader@folder:/agents/A/workspace/shared-docs
      │      → folder inheritance → allowed ✅
      │
      └─ 6. ScopedFileSystem → path within allowed root → read file

  Sub-delegation (monotonic attenuation):

    Worker receives grant: fs_read:/project/src/**
    Worker sub-delegates to sub-worker:
      delegation_grant({
        delegateeId: "sub-worker",
        permissions: { allow: ["fs_read"] },
        resources: ["fs_read:/project/src/lib/**"]    ← narrower
      })
      → attenuateGrant() enforces: child scope ≤ parent scope
      → child allow ⊆ parent allow, parent deny ⊆ child deny
      → child expiresAt ≤ parent expiresAt
      → chainDepth incremented, checked against maxChainDepth

  Revocation (cascade):

    Supervisor calls delegation_revoke({ grantId, cascade: true })
      → DelegationManager cascades: revokes grant + all children
      → onRevoke → governance → revocations.revoke RPC → Nexus
      → all agents in chain lose access immediately
      → NexusScopeEnforcer → denied ❌
```

---

## Same L0 contract, different L2

`createNode` (L2) only sees `AgentRegistry` (L0). It doesn't know or care which L2 implements it:

```typescript
// Option A: event-sourced (exists today)
const backend  = createNexusEventBackend({ baseUrl, apiKey })
const registry = createEventSourcedRegistry(backend)

// Option B: direct HTTP (proposed, P0)
const registry = createNexusRegistry({ baseUrl, apiKey })

// Either one works — createNode sees the same L0 interface
const node = createNode(config, { registry })

// IPC wiring — with optional discovery via registry
const ipcProvider = createIpcNexusProvider({ baseUrl, apiKey, registry })
//                                                          ^^^^^^^^
//                                          optional: enables ipc_discover tool
// Pay: same swap pattern — middleware-pay consumes PayLedger (L0) directly
// Option A: in-memory (dev)
const payMiddleware = createPayMiddleware({
  ledger: createInMemoryPayLedger(),
  calculator: createDefaultCostCalculator(),
  budget: 50.0,
})

// Option B: Nexus-backed (production)
const payMiddleware = createPayMiddleware({
  ledger: createNexusPayLedger({ baseUrl, apiKey }),
  calculator: createDefaultCostCalculator(),
  budget: 50.0,
})

// Memory: same ComponentProvider pattern as IPC
const fsMemory = await createFsMemory({ baseDir: "/data/memory/agent-1" })
const memoryProvider = createMemoryProvider({
  memory: fsMemory,
  baseDir: "/data/memory/agent-1",
  // optional: retriever + indexer for semantic search
})

// createKoi is L1 — assembles the agent with providers + middleware
const runtime = await createKoi(manifest, adapter, {
  providers: [ipcProvider, memoryProvider, schedulerProvider],
  middleware: [payMiddleware],
})
// Agent now has: MAILBOX + IPC tools, MEMORY + memory tools + memory skill,
// SCHEDULER + 9 scheduler tools, pay budget enforcement.
// All via L0 contracts, all swappable.

// Sidecars — app code wires (L2 can't import peer L2)

// agent-procfs: diagnostic sidecar
const procFs = createProcFs({ cacheTtlMs: 1000 })
const mounter = createAgentMounter({
  registry,
  procFs,
  agentProvider: (id) => node.getAgent(id),  // node.getAgent() returns Agent | undefined
})
// Mounter auto-mounts 7 entries per agent on registry events.
// Consumers read directly:
//   await procFs.read("/agents/worker-1/tools")  → tool list
//   await procFs.list("/agents/")                → all agent IDs
//   await procFs.write("/agents/worker-1/metrics", { priority: 0 })

// scheduler: task scheduling sidecar
// Option A: local queue (dev/test)
const scheduler = createScheduler(
  DEFAULT_SCHEDULER_CONFIG,
  createSqliteTaskStore(db),
  async (agentId, input, mode) => { /* local dispatch */ },
)

// Option B: Nexus queue backend (production)
// const scheduler = createScheduler(
//   DEFAULT_SCHEDULER_CONFIG,
//   createNexusTaskStore({ baseUrl, apiKey }),  // not yet built
//   async (agentId, input, mode) => { /* Nexus handles dispatch via IPC */ },
// )

const schedulerProvider = createSchedulerProvider(scheduler)

// Agent gets scheduler tools via provider:
// node.dispatch(pid, manifest, engine, [ipcProvider, memoryProvider, schedulerProvider])

// verified-loop: autonomy orchestrator (wraps L1, not inside it)
const loop = createVerifiedLoop({
  prdPath: "./tasks/prd.json",
  learningsPath: "./tasks/learnings.json",
  maxIterations: 20,
  maxConsecutiveFailures: 3,

  // Consumer wires their own engine per iteration (fresh context each time)
  runIteration: async function*(input) {
    const runtime = await createKoi(manifest, adapter, {
      providers: [ipcProvider, memoryProvider],
      middleware: [payMiddleware],
    })
    yield* runtime.run(input)
  },

  // External objective check — composable gates
  verify: createCompositeGate([
    createTestGate(["bun", "test"]),
    createFileGate("dist/output.js", /export/),
  ]),

  // Prompt builder — receives rich context
  iterationPrompt: (ctx) =>
    `Work on: ${ctx.currentItem?.description}\n` +
    `Completed: ${ctx.completedItems.map(i => i.id).join(", ")}\n` +
    `Learnings: ${ctx.learnings.slice(-3).map(l => l.context).join("; ")}`,

  onIteration: (record) => {
    console.log(`#${record.iteration}: ${record.itemId} → ${record.gateResult.passed}`)
  },
})

const result = await loop.run()
// result.completed  — items verified done
// result.skipped    — items skipped after 3 consecutive failures
// result.remaining  — items not yet attempted
// result.learnings  — rolling journal of discoveries + failures

// OR via context-arena (L3) — auto-wires memory + compactor + squash:
const arena = await createContextArena({
  memoryFs: { config: { baseDir: "/data/memory/agent-1" } },
  summarizer, sessionId, getMessages,
})
// arena.providers includes memoryProvider automatically
// arena.middleware includes compactor with fact-extracting archiver

// Governance: security middleware bundle (L3)
// Option A: pick what you need
const { middlewares: securityMiddleware } = createGovernanceStack({
  permissions: {
    backend: createPatternPermissionBackend({
      rules: { allow: ["group:fs_read"], deny: ["delete_file"], ask: ["bash:*"] },
    }),
  },
  audit: { sink: myAuditSink },
  sanitize: {},
})

// Option B: preset (planned #641)
const { middlewares: securityMiddleware, providers: securityProviders } =
  createGovernanceStack({ preset: "standard" })

// The caller wires L1 + L2 + L3 together:
const runtime = await createKoi(manifest, adapter, {
  providers: [ipcProvider, memoryProvider, ...securityProviders],
  middleware: [payMiddleware, ...securityMiddleware],
})

// OR via @koi/starter — manifest-driven (reads YAML + code callbacks):
const runtime = await createConfiguredKoi({
  manifest,   // YAML declares middleware, permissions, scope
  adapter,
  callbacks: {
    permissions: { backend: myBackend, approvalHandler: myHandler },
  },
})

// ─── Manifest (koi.yaml) — full agent configuration ───
//
//   name: research-agent
//   model: claude-sonnet-4-5-20250514
//
//   context:
//     maxTokens: 8000
//     sources:
//       - kind: skill           # ← loads memory skill behavioral instructions
//         name: memory           #    from skillToken("memory") on the agent
//       - kind: memory           # ← recalls memories at session start
//         query: "user context"
//         maxTokens: 2000
//       - kind: text             # ← static system instructions
//         text: "You are a research assistant."
//         required: true
//
//   permissions:                 # ← tool access control
//     allow:
//       - "read_file:/workspace/**"
//       - "group:fs_read"
//     deny:
//       - "bash:rm -rf *"
//     ask:
//       - "bash:*"
//
//   scope:                       # ← subsystem boundaries
//     filesystem:
//       root: /workspace
//       mode: ro
//     browser:
//       allowedDomains: [docs.example.com]
//     credentials:
//       keyPattern: "api_*"
//
//   middleware:
//     - name: pay               # ← budget enforcement
//     - name: context-arena     # ← context window management
//       options:
//         preset: balanced
//
// Without context.sources, the memory skill is attached to the agent
// but NEVER injected into the LLM prompt. Both code + manifest needed.
```

---

## Nexus has its own event log

Nexus server has a built-in event subsystem that logs **all filesystem
operations** automatically. Every `write`, `delete`, `rename` on the
Nexus filesystem produces a `FileEvent`:

```
Nexus Event Subsystem (server-side, always on)
──────────────────────────────────────────────

  FileEventType (all filesystem ops are logged):
    FILE_WRITE              file created or modified
    FILE_DELETE             file removed
    FILE_RENAME             file path changed
    METADATA_CHANGE         permissions, ownership changed
    DIR_CREATE              directory created
    DIR_DELETE              directory removed
    SYNC_TO_BACKEND_*       sync requested/completed/failed
    CONFLICT_DETECTED       data conflict

  EventLogProtocol (how to query):
    append(event)           write to WAL (Rust, <5μs)
    read_from(seq, limit)   read events from sequence number
    current_sequence()      latest sequence number
    truncate(before_seq)    remove old events

  Storage: WAL (Write-Ahead Log) backed by Rust extension
  Delivery: EventBus with Redis or NATS pub/sub backends
  Durability: fsync to disk, crash recovery, segment rotation
```

This means **registry-nexus gets an audit trail for free** from the
Nexus server. When registry-nexus calls `write("/registry/agents/worker-1.json", ...)`
to update agent state, Nexus automatically logs a `FILE_WRITE` event
with the path, timestamp, and zone.

```
registry-nexus writes:  POST /rpc → write(path, content)
                           │
Nexus server internally:   │
  1. writes file            │
  2. appends FileEvent ─────┼──► WAL (durable, queryable)
     { type: FILE_WRITE,    │    read_from(seq) to replay
       path: "/registry/    │
         agents/worker-1",  │
       timestamp, zone_id } │
                            │
  3. publishes to EventBus ─┼──► Redis/NATS subscribers
                            │    (real-time notification)
```

---

## Why both exist (updated)

```
┌─────────────────────────┬──────────────────────────────────────┐
│                         │ registry-event-sourced               │
│ registry-nexus          │ + events-nexus                       │
├─────────────────────────┼──────────────────────────────────────┤
│ Direct CRUD             │ Event sourcing + projection          │
│ 1 package               │ 2 packages                          │
│ L2 → L2 → Nexus        │ L2 → L2 → L2 → Nexus               │
│ Strong consistency      │ Eventually consistent               │
│ Zero startup cost       │ Must fold all events on startup     │
│ Current state only      │ Can replay history                  │
│ DEFAULT for multi-node  │ OPTIONAL for audit-trail deploys    │
│                         │                                      │
│ Audit trail: YES        │ Audit trail: YES                    │
│ (Nexus server-side WAL  │ (Koi-side EventBackend streams      │
│  logs all file writes   │  with domain-specific events like   │
│  automatically)         │  agent_registered, transitioned)    │
└─────────────────────────┴──────────────────────────────────────┘
```

**Both have audit trails**, but at different levels:
- **registry-nexus**: Nexus WAL logs raw file operations (`FILE_WRITE` to path X)
- **registry-event-sourced**: Koi EventBackend logs domain events (`agent_transitioned from running to terminated, reason: completed`)

The Nexus WAL tells you "file changed at time T". The Koi event stream
tells you "agent-1 transitioned from running to terminated because the
task completed." Different granularity, different semantics.

`events-nexus` is freed up to serve other append-only consumers
(audit logs, domain events) once registry-nexus becomes the default.

---

## Two communication planes

```
GATEWAY (WebSocket)                    NEXUS (HTTP + pub/sub)
───────────────────                    ─────────────────────
Nodes connect here.                    L2 packages call here directly.
Clients connect here.                 Gateway not involved.

Routes:                                Handles:
  tool_call / tool_result               IPC mailboxes (ipc-nexus)
  node lifecycle frames                 Registry state (registry-nexus)
  client sessions                       Event streams (events-nexus)
                                        File storage

Cross-node tool call:                  Agent-to-agent IPC:
  Node A → Gateway → Node B             Agent A → Nexus IPC → Agent B
  (real-time, ~ms)                       (currently polling, ~seconds)
                                         (pub/sub available, ~ms)
```

**Nexus IPC server supports 3 delivery mechanisms:**

| Mechanism | Latency | Used by ipc-nexus? |
|---|---|---|
| REST polling (GET /inbox) | ~1-30s (backoff) | Yes (current) |
| Redis pub/sub (`ipc.inbox.{id}`) | ~ms (push) | No (available) |
| SSE (`/api/v2/events/stream`) | ~ms (push) | No (available) |

The polling latency is a **client-side limitation** in `@koi/ipc-nexus`,
not a Nexus limitation. Upgrading to pub/sub or SSE would give agent
IPC the same ~ms latency as Gateway tool routing. See issue #609.

---

## Full node vs. thin node

```
┌──────────────────────────────┬──────────────────────────────┐
│ Full Node (mode: "full")     │ Thin Node (mode: "thin")     │
├──────────────────────────────┼──────────────────────────────┤
│ Hosts agents (dispatch,      │ No agents.                   │
│   terminate, list)           │ No engines.                  │
│ Runs engines (createKoi)     │ No dispatch.                 │
│ Capacity management          │                              │
│ Memory monitor + eviction    │                              │
│ Checkpoint + crash recovery  │                              │
│ Agent inbox (100-msg ring)   │                              │
│ Delivery manager (retry)     │                              │
│ Status reporter              │                              │
│                              │                              │
│ SHARED:                      │ SHARED:                      │
│   Tool resolver              │   Tool resolver              │
│   Gateway WebSocket          │   Gateway WebSocket          │
│   Heartbeat                  │   Heartbeat                  │
│   mDNS discovery             │   mDNS discovery             │
│   start() / stop()           │   start() / stop()           │
│   onEvent()                  │   onEvent()                  │
│                              │                              │
│ Use case:                    │ Use case:                    │
│   GPU server running agents  │   Raspberry Pi with camera   │
│   Cloud VM with LLM access   │   IoT device with sensors   │
│   Laptop doing local dev     │   Machine with CLI tools     │
└──────────────────────────────┴──────────────────────────────┘
```

---

## Gateway features

```
┌─────────────────────────────────────────────────────────────┐
│ @koi/gateway (L2)                                           │
│ "WebSocket control plane — routes frames, never runs agents"│
│                                                             │
│ Node Management:                                            │
│   Node registry (inverted tool index for O(1) lookup)       │
│   Handshake: node:handshake → node:capabilities → ack      │
│   Heartbeat monitoring (timeout → deregister)               │
│   Capacity tracking (current/max/available per node)        │
│   Dynamic tool updates (add/remove at runtime)              │
│                                                             │
│ Tool Routing:                                               │
│   Agent calls tool → not on local node?                     │
│   Gateway finds node with that tool (inverted index)        │
│   Affinity rules: glob pattern → preferred node             │
│   Fallback: highest available capacity                      │
│   Sends tool_call frame → waits → returns tool_result       │
│                                                             │
│ Session Management:                                         │
│   Create, resume, destroy sessions                          │
│   TTL-based keep-alive on disconnect                        │
│   Pending frame buffer (up to 1,000)                        │
│   Flush on reconnect                                        │
│                                                             │
│ Client Routing:                                             │
│   GatewayFrame (request/response/event/ack/error)           │
│   Dispatch keys: main, per-peer, per-channel-peer           │
│   Channel binding (static channel → agent mapping)          │
│                                                             │
│ Ingestion:                                                  │
│   Webhook (HTTP POST → GatewayFrame)                        │
│   Canvas UI (SSE surface store)                             │
│                                                             │
│ Reliability:                                                │
│   Frame dedup (sequence tracker)                            │
│   Backpressure (per-conn + global buffer monitoring)        │
│   Reconnect handling (evict old conn on same nodeId)        │
└─────────────────────────────────────────────────────────────┘
```

---

## Cross-node tool routing

```
Full Node A                    Gateway                     Thin Node B
(agent running)                (router)                    (camera tool)
───────────────                ───────                     ───────────

1. Agent LLM calls                                        On start():
   camera.capture              Node registry has:           node:handshake
   (not on this node)          Node-B: [camera.capture]     node:capabilities
        │                      Node-A: [shell, fs]            tools: [camera.*]
        ▼
2. Node A sends                                           3. Gateway finds
   tool_call frame ──────────► tool_call                     Node-B has
   { tool: "camera.capture",   │                             camera.capture
     args: {...},               │ inverted index lookup      (O(1) lookup)
     correlationId: "abc" }     │                                │
                                ▼                                ▼
                           4. Gateway sends ──────────────► tool_call
                              to Node B                     { tool: "camera.capture"
                                                              args: {...} }
                                                                 │
                                                            5. Node B executes
                                                               tool locally
                                                                 │
                                                                 ▼
                           6. Gateway routes ◄────────────── tool_result
                              back to Node A                { image: "base64..." }
        │
        ▼
7. Agent receives
   tool_result
   continues with photo
```

---

## Node lifecycle events

```
Node emits these events via onEvent(listener):

  Connection:
    connected              transport connected to gateway
    disconnected           transport disconnected
    reconnecting           attempting to reconnect
    reconnected            successfully reconnected
    reconnect_exhausted    max reconnect attempts exceeded

  Auth:
    auth_started           auth handshake started
    auth_success           auth successful
    auth_failed            auth failed

  Agent (full node only):
    agent_dispatched       agent created (agentId, name)
    agent_terminated       agent terminated (agentId)
    agent_crashed          agent crashed (reason, error)
    agent_recovered        agent recovered from checkpoint

  Tools:
    tool_timeout           tool execution timeout
    tool_error             tool execution error

  Resources:
    memory_warning         heap usage >= warning threshold (80%)
    memory_eviction        agent evicted due to memory (90%)

  Shutdown:
    shutdown_started       graceful shutdown started
    shutdown_complete      shutdown complete

  Delivery:
    pending_frame_sent     pending frame successfully sent
    pending_frame_expired  pending frame TTL exceeded
    pending_frame_dead_letter  frame delivery exhausted
```
