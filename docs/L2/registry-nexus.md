# @koi/registry-nexus — Nexus-Backed Agent Registry

Implements the L0 `AgentRegistry` contract using Nexus as the authoritative store for agent state. Agents on different nodes can discover each other by ID, skill, type, or phase. Maintains a local in-memory projection for fast reads, synchronized via periodic polling. Watch events fire both from local mutations and poll-detected remote changes.

---

## Why It Exists

In a single-node Koi deployment, agents discover each other through the in-memory `InMemoryRegistry`. When agents run across multiple nodes — separate processes, containers, or machines — they cannot see each other. Node 1's agents are invisible to Node 2.

Without this package, you'd need to:
1. Build a custom distributed registry with CAS semantics
2. Map Koi's 5-phase lifecycle to your backend's state model
3. Handle generation tracking for two independent CAS systems (Koi + backend)
4. Poll for remote changes and diff against local state
5. Encode full `AgentStatus` into backend metadata for lossless round-trips
6. Do all of the above while respecting Koi's layer architecture (L2 → L0 only)

`@koi/registry-nexus` handles all of this. Point it at a Nexus server and agents across any number of nodes can find each other.

---

## What This Enables

### Before vs After

```
BEFORE: agents on different nodes are blind to each other
═════════════════════════════════════════════════════════

  Node 1                    Node 2                    Node 3
  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
  │  Agent A     │          │  Agent B     │          │  Agent C     │
  │  "researcher"│   ???    │  "coder"     │   ???    │  "reviewer"  │
  │              │───────X  │              │───────X  │              │
  │  "Who else   │          │  "Who else   │          │  "Who else   │
  │   exists?"   │          │   exists?"   │          │   exists?"   │
  └──────────────┘          └──────────────┘          └──────────────┘

  No discovery. No lifecycle visibility. No coordination.


AFTER: Nexus provides a shared registry visible to all nodes
════════════════════════════════════════════════════════════

                      ┌─────────────────────────────┐
                      │     Nexus Server (Hub)       │
                      │                              │
                      │  agent-A  CONNECTED  gen:3   │
                      │  agent-B  IDLE       gen:1   │
                      │  agent-C  CONNECTED  gen:5   │
                      └──────┬──────────┬────────┬───┘
                  poll/sync  │          │        │  poll/sync
               ┌─────────────┘          │        └─────────────┐
               ▼                        ▼                      ▼
  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │  Node 1          │    │  Node 2          │    │  Node 3          │
  │  Agent A         │    │  Agent B         │    │  Agent C         │
  │  Sees: A, B, C   │    │  Sees: A, B, C   │    │  Sees: A, B, C   │
  └──────────────────┘    └──────────────────┘    └──────────────────┘
```

### Agent Discovery Across Nodes

```
Agent C (Node 3) wants to find a "researcher" agent:

┌─────────┐                    ┌──────────┐                  ┌─────────┐
│ Agent C │                    │  Nexus   │                  │ Agent A │
│ Node 3  │                    │ Registry │                  │ Node 1  │
└────┬────┘                    └────┬─────┘                  └────┬────┘
     │                              │                             │
     │  registry.list({             │                             │
     │    agentType: "worker"       │                             │
     │  })                          │                             │
     │─────────────────────────────▶│                             │
     │                              │  (reads from local          │
     │                              │   projection — fast)        │
     │◀─────────────────────────────│                             │
     │  [Agent A, Agent B, ...]     │                             │
     │                              │                             │
     │  discoverBySkill(            │                             │
     │    registry, "research"      │                             │
     │  )                           │                             │
     │─────────────────────────────▶│                             │
     │◀─────────────────────────────│                             │
     │  [Agent A]                   │                             │
     │                              │                             │
```

---

## Architecture

### Dual-Generation Model

Koi and Nexus each have their own CAS (Compare-and-Swap) generation counter. The registry tracks both independently to prevent split-brain transitions.

```
  Koi generation                  Nexus generation
  (for callers)                   (for server RPC)
  ──────────────                  ─────────────────
  Tracked in:                     Tracked in:
    projection Map                  nexusGens Map

  Used by:                        Used by:
    transition() CAS check          nexusTransition() RPC param

  Incremented by:                 Incremented by:
    local transition()              Nexus server on state change

  Visible to:                     Visible to:
    registry consumers              Nexus server only
    (callers see Koi gen)           (internal to this package)
```

### State Mapping (Koi ↔ Nexus)

Koi has 5 fine-grained phases. Nexus has 4 coarse states. The mapping is bidirectional with metadata encoding for lossless round-trips.

```
  Koi ProcessState        Nexus AgentState         Notes
  ════════════════        ═══════════════          ═════
  created    ────────────▶ CONNECTED               Nexus starts at UNKNOWN,
  running    ────────────▶ CONNECTED               transitions UNKNOWN→CONNECTED
  waiting    ────────────▶ IDLE                     on registration
  suspended  ────────────▶ SUSPENDED
  terminated ────────────▶ SUSPENDED + flag         metadata: koi:terminated=true

  UNKNOWN    ◀──────────── created                  Reverse mapping
  CONNECTED  ◀──────────── running                  (coarse → fine)
  IDLE       ◀──────────── waiting
  SUSPENDED  ◀──────────── suspended or terminated  Check koi:terminated flag
```

Full `AgentStatus` (phase, generation, conditions, reason, lastTransitionAt) is stored losslessly in Nexus metadata under the `"koi:status"` key. The reverse mapping only serves as a fallback when `koi:status` metadata is missing (e.g., agents registered by non-Koi systems).

### Data Flow

```
                        ┌─────────────────────┐
                        │    Nexus Server      │
                        │   (source of truth)  │
                        └─────────┬────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    │             │             │
                 register      poll          transition
                 deregister    (periodic)     (CAS)
                    │             │             │
                    ▼             ▼             ▼
           ┌──────────────────────────────────────────┐
           │         createNexusRegistry()             │
           │                                           │
           │  ┌─────────────┐  ┌──────────────────┐   │
           │  │  projection  │  │  nexusGens        │   │
           │  │  Map<id,     │  │  Map<id,          │   │
           │  │   Entry>     │  │   nexusGen>        │   │
           │  └──────┬───────┘  └──────────────────┘   │
           │         │                                  │
           │         ▼                                  │
           │  ┌─────────────┐                          │
           │  │  listeners   │  watch() subscribers    │
           │  │  Set<fn>     │  receive events from    │
           │  └─────────────┘  local ops + poll diffs  │
           └───────────────────────────────────────────┘
                    │
                    ▼
           Fast reads: lookup(), list()
           return from projection — no network call
```

### Layer Compliance

```
  L0  @koi/core ──────────────────────────────────────────┐
      AgentRegistry, RegistryEntry, ProcessState,          │
      matchesFilter(), VALID_TRANSITIONS, agentId()        │
                                                           │
  L2  @koi/registry-nexus ◄────────────────────────────────┘
      imports from L0 only
      ✗ never imports @koi/engine (L1)
      ✗ never imports peer L2 packages
```

---

## How It Works

### Startup — Eager Warmup

When `createNexusRegistry(config)` is called, it immediately loads all agents from Nexus into the local projection:

1. Call `nexusListAgents(config)` to get all agent IDs
2. For each agent, call `nexusGetAgent(config, id)` to fetch full metadata
3. Decode `koi:status` from metadata into `RegistryEntry`
4. Populate the projection Map (respecting `maxEntries` cap)
5. Start poll timer if `pollIntervalMs > 0`

### Registration

```
register(entry: RegistryEntry)
  │
  ├─ 1. Encode AgentStatus into Nexus metadata
  │     (koi:status + koi:terminated + agentType + registeredAt)
  │
  ├─ 2. nexusRegisterAgent() → creates agent in UNKNOWN state
  │     ├─ Track Nexus generation: gen=0
  │
  ├─ 3. nexusTransition(UNKNOWN → CONNECTED) → gen=1
  │
  ├─ 4. If target ≠ CONNECTED (e.g., waiting → IDLE):
  │     └─ nexusTransition(CONNECTED → target) → gen=2
  │
  ├─ 5. Store entry in local projection
  │
  └─ 6. Notify watchers: { kind: "registered", entry }
```

### CAS Transition

```
transition(agentId, targetPhase, expectedGeneration, reason)
  │
  ├─ 1. Lookup current entry in projection → NOT_FOUND if missing
  │
  ├─ 2. CAS check: entry.status.generation === expectedGeneration?
  │     └─ No → CONFLICT (stale caller, retryable)
  │
  ├─ 3. Validate transition edge: VALID_TRANSITIONS[current] → target?
  │     └─ No → VALIDATION (invalid edge, not retryable)
  │
  ├─ 4. nexusTransition(agentId, mapKoiToNexus(target), nexusGen)
  │     └─ Nexus CONFLICT → registry CONFLICT (retryable)
  │
  ├─ 5. nexusUpdateMetadata() → encode full AgentStatus
  │
  ├─ 6. Update local projection with new entry (generation + 1)
  │
  └─ 7. Notify watchers: { kind: "transitioned", from, to, generation }
```

### Polling — Remote Change Detection

```
Every pollIntervalMs (default: 10s):

  poll()
    │
    ├─ nexusListAgents() → get all agent IDs + generations
    │
    ├─ For each remote agent:
    │   ├─ Is generation different from nexusGens? → fetch full details
    │   ├─ Is agent new (not in projection)?
    │   │   └─ Emit: { kind: "registered", entry }
    │   └─ Has phase changed?
    │       └─ Emit: { kind: "transitioned", from, to }
    │
    └─ For each local agent not in remote list:
        ├─ Remove from projection
        └─ Emit: { kind: "deregistered", agentId }
```

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createNexusRegistry(config)` | `Promise<AgentRegistry>` | Create a Nexus-backed registry with eager warmup |
| `createNexusRegistryProvider(config)` | `ComponentProvider` | Assembly provider: registers agent in Nexus on attach |
| `discoverBySkill(registry, skill)` | `readonly RegistryEntry[]` | Filter agents by `metadata.skills` array |
| `validateNexusRegistryConfig(config)` | `Result<NexusRegistryConfig, KoiError>` | Validate config at system boundary |

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | — | Nexus server URL (required) |
| `apiKey` | `string` | — | API key for authentication (required) |
| `zoneId` | `string?` | `undefined` | Zone scope for agent listing |
| `timeoutMs` | `number` | `10_000` | RPC call timeout in milliseconds |
| `pollIntervalMs` | `number` | `10_000` | Poll interval. 0 = disabled |
| `startupTimeoutMs` | `number` | `30_000` | Timeout for initial warmup |
| `maxEntries` | `number` | `10_000` | Max agents in local projection |
| `fetch` | `typeof fetch?` | `globalThis.fetch` | Injectable fetch for testing |

### AgentRegistry Methods

All methods from the L0 contract:

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(entry) → Promise<RegistryEntry>` | Register agent in Nexus + local projection |
| `deregister` | `(agentId) → Promise<boolean>` | Delete from Nexus + remove from projection |
| `lookup` | `(agentId) → RegistryEntry \| undefined` | Fast local lookup (no network) |
| `list` | `(filter?) → readonly RegistryEntry[]` | Filter projection with `matchesFilter()` |
| `transition` | `(id, phase, gen, reason) → Result<RegistryEntry, KoiError>` | CAS transition with dual-gen tracking |
| `watch` | `(listener) → () => void` | Subscribe to registry events |
| `[Symbol.asyncDispose]` | `() → Promise<void>` | Stop poll timer, clear projection |

### Nexus RPC Client

Low-level JSON-RPC 2.0 client exported for advanced use:

| Function | Nexus Method | Purpose |
|----------|-------------|---------|
| `nexusRpc(config, method, params)` | any | Generic JSON-RPC call |
| `nexusRegisterAgent(config, params)` | `register_agent` | Create agent |
| `nexusDeleteAgent(config, agentId)` | `delete_agent` | Delete agent |
| `nexusTransition(config, id, state, gen)` | `agent_transition` | CAS state change |
| `nexusListAgents(config, zoneId?)` | `list_agents` / `agent_list_by_zone` | List all agents |
| `nexusGetAgent(config, agentId)` | `get_agent` | Get agent with metadata |
| `nexusUpdateMetadata(config, id, meta)` | `update_agent_metadata` | Update metadata |
| `nexusHeartbeat(config, agentId)` | `agent_heartbeat` | Keep-alive |

### Error Mapping

Nexus JSON-RPC errors are mapped to `KoiErrorCode`:

| Nexus Code | Koi Code | Retryable | Meaning |
|------------|----------|-----------|---------|
| `-32006` | `CONFLICT` | yes | Generation mismatch (CAS) |
| `-32000` | `NOT_FOUND` | no | Agent does not exist |
| `-32003` | `PERMISSION` | no | Unauthorized |
| `-32005` | `VALIDATION` | no | Invalid parameters |
| `-32601` | `EXTERNAL` | no | Method not found |
| `-32603` | `EXTERNAL` | yes | Internal server error |
| HTTP 5xx | `EXTERNAL` | yes | Server-side failure |
| Timeout | `TIMEOUT` | yes | Request exceeded `timeoutMs` |

---

## Examples

### Basic Registry Setup

```typescript
import { createNexusRegistry } from "@koi/registry-nexus";

const registry = await createNexusRegistry({
  baseUrl: "https://nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY!,
  pollIntervalMs: 10_000,
});

// List all running agents
const running = await registry.list({ phase: "running" });

// Look up a specific agent
const agent = await registry.lookup(agentId("worker-42"));

// Clean up
await registry[Symbol.asyncDispose]();
```

### Wire into createKoi Assembly

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createNexusRegistryProvider } from "@koi/registry-nexus";

const nexusProvider = createNexusRegistryProvider({
  baseUrl: "https://nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY!,
});

const runtime = await createKoi({
  manifest: {
    name: "my-agent",
    version: "1.0.0",
    model: { name: "claude-sonnet-4-5" },
  },
  adapter: createPiAdapter({ model: "anthropic:claude-sonnet-4-5-20250929" }),
  providers: [nexusProvider],  // Registers in Nexus during assembly
});

// Agent is now visible to all nodes polling this Nexus server
for await (const event of runtime.run({ kind: "text", text: "Hello" })) {
  // ...
}

// Detach removes from Nexus
await nexusProvider.detach?.(runtime.agent);
await runtime.dispose();
```

### Watch for Agent Lifecycle Events

```typescript
const registry = await createNexusRegistry(config);

const unsubscribe = registry.watch((event) => {
  switch (event.kind) {
    case "registered":
      console.log(`New agent: ${event.entry.agentId}`);
      break;
    case "transitioned":
      console.log(`${event.agentId}: ${event.from} → ${event.to} (gen ${event.generation})`);
      break;
    case "deregistered":
      console.log(`Agent left: ${event.agentId}`);
      break;
  }
});

// Later: stop watching
unsubscribe();
```

### CAS-Safe State Transitions

```typescript
// Read current state
const entry = await registry.lookup(agentId("worker-42"));
if (entry === undefined) throw new Error("Agent not found");

// Transition with CAS — only succeeds if nobody else changed it
const result = await registry.transition(
  agentId("worker-42"),
  "waiting",
  entry.status.generation,    // Must match current generation
  { kind: "assembly_complete" },
);

if (!result.ok) {
  if (result.error.code === "CONFLICT") {
    // Another caller transitioned first — re-read and retry
    console.log("Stale generation, re-read and retry");
  }
}
```

### Discover Agents by Skill

```typescript
import { discoverBySkill } from "@koi/registry-nexus";

// Find all agents that have "research" in their metadata.skills
const researchers = await discoverBySkill(registry, "research");

for (const agent of researchers) {
  console.log(`${agent.agentId}: ${agent.status.phase}`);
}
```

### Testing with Injectable Fetch

```typescript
import { createNexusRegistry } from "@koi/registry-nexus";

// Mock fetch for unit tests — no real Nexus server needed
const mockFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(init?.body as string);
  // ... return mock JSON-RPC responses
};

const registry = await createNexusRegistry({
  baseUrl: "https://nexus.test",
  apiKey: "sk-test",
  pollIntervalMs: 0,    // Disable polling in tests
  fetch: mockFetch,      // Inject mock
});
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Dual-generation model (Koi + Nexus) | Nexus CAS and Koi CAS are independent counters. Conflating them causes split-brain when Nexus advances its generation for metadata updates that don't correspond to Koi transitions. |
| Full status in metadata, coarse state in Nexus | Nexus has 4 states, Koi has 5 phases + conditions + reason. Metadata encoding preserves the full fidelity. Coarse Nexus state enables basic visibility for non-Koi systems. |
| Local projection for reads | `lookup()` and `list()` hit an in-memory Map — zero network latency. Poll keeps it fresh. Acceptable staleness window = `pollIntervalMs`. |
| Hybrid watch (local + poll) | Local mutations emit immediately. Remote changes detected on next poll. No WebSocket dependency on Nexus. |
| Injectable `fetch` | Enables full unit testing with mock JSON-RPC server. No test dependency on a running Nexus instance. |
| `maxEntries` cap | Prevents unbounded memory growth if Nexus has thousands of agents. Default 10,000 is generous for most deployments. |
| `matchesFilter()` from L0 | Filter logic is shared across InMemory, EventSourced, and Nexus backends via a pure function in `@koi/core`. No duplication. |
| Eager warmup on creation | The factory is async and loads all agents before returning. Callers never get a registry with stale-on-first-read data. |
| Poll-based sync (not WebSocket) | Simpler, stateless, works behind load balancers and proxies. 10s poll is acceptable for agent discovery (not real-time messaging). |

---

## File Structure

```
packages/registry-nexus/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                  # Public exports
    ├── config.ts                 # NexusRegistryConfig + validation
    ├── nexus-client.ts           # JSON-RPC 2.0 client (~140 LOC)
    ├── nexus-registry.ts         # AgentRegistry implementation (~250 LOC)
    ├── state-mapping.ts          # Bidirectional Koi ↔ Nexus mapping
    ├── discovery.ts              # Skill-based agent discovery
    ├── component-provider.ts     # ComponentProvider for createKoi assembly
    ├── config.test.ts            # Config validation tests
    ├── nexus-client.test.ts      # JSON-RPC envelope + error mapping tests
    ├── state-mapping.test.ts     # Round-trip mapping tests
    ├── nexus-registry.test.ts    # Registry contract + impl tests
    ├── discovery.test.ts         # Skill filtering tests
    ├── component-provider.test.ts
    └── __tests__/
        ├── integration.test.ts       # Env-gated (NEXUS_URL)
        └── e2e-full-stack.test.ts    # Env-gated (ANTHROPIC_API_KEY + E2E_TESTS=1)
```
