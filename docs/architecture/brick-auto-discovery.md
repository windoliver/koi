# Brick Auto-Discovery

How forged bricks flow from creation to runtime availability.

## Overview

Koi agents can forge 5 kinds of bricks at runtime: **tool**, **skill**, **agent**, **middleware**, and **channel**. Brick auto-discovery is the pipeline that makes a forged brick available on the agent entity — queryable by any consumer — without manual wiring.

```
  ForgeStore              ForgeComponentProvider         Agent (ECS Entity)
  ┌──────────┐            ┌──────────────────┐          ┌──────────────────┐
  │ save()   │──watch()──>│ attachBrick()    │──set()──>│ tool:adder       │
  │          │            │ (exhaustive      │          │ skill:coding     │
  │ 5 kinds  │            │  switch on kind) │          │ agent:helper     │
  │ stored   │            │                  │          │ middleware:log   │
  └──────────┘            └──────────────────┘          │ channel:slack    │
                                                        └──────────────────┘
                                                               │
                                                               ▼
                                                        agent.query<T>("skill:")
                                                        → [{ name, content, ... }]
```

## The Pipeline

### 1. Forge and Save

A brick is created (by the agent or operator) and saved to `ForgeStore`:

```
  Agent decides "I need a date formatter tool"
       │
       ▼
  forge-tool (LLM generates implementation)
       │
       ▼
  verify (static analysis + sandbox self-test + integrity hash)
       │
       ▼
  store.save(artifact)  →  ForgeStore persists it
       │
       ▼
  store.watch() fires StoreChangeEvent
```

### 2. Discover and Verify

`ForgeComponentProvider` discovers bricks from the store and verifies them:

```
  ForgeComponentProvider.attach(agent)
       │
       ▼
  store.search({ lifecycle: "active" })
       │
       ├─── trust tier check: MIN_TRUST_BY_KIND
       │    tool/skill/agent: "sandbox" minimum
       │    middleware/channel: "promoted" minimum
       │
       ├─── scope filtering (global, session, zone)
       │
       ├─── requires check (bins, env, tools)
       │
       └─── integrity verification (content-addressed ID)
```

### 3. Attach as ECS Component

Each brick kind maps to a typed ECS component via `attachBrick()`:

```
  BrickKind      Token Prefix    ECS Component Type
  ─────────      ────────────    ──────────────────
  tool           tool:name       Tool (callable function)
  skill          skill:name      SkillComponent { name, description, content }
  agent          agent:name      AgentDescriptor { name, description, manifestYaml }
  middleware     middleware:name  BrickArtifact (raw artifact)
  channel        channel:name    BrickArtifact (raw artifact)
```

### 4. Query by Consumers

Any part of the system can query attached components:

```
  // Skills — e.g., @koi/context skill source
  const skills = agent.query<SkillComponent>("skill:");
  // → [{ name: "coding", description: "...", content: "# Coding Guide\n..." }]

  // Agents — peer discovery
  const peers = agent.query<AgentDescriptor>("agent:");
  // → [{ name: "helper", description: "...", manifestYaml: "..." }]

  // Tools — resolved at call time via ForgeRuntime
  const tool = await runtime.resolveTool("date-formatter");
```

## ForgeRuntime.resolve()

Generic per-kind resolution with type safety:

```
  resolve<K extends BrickKind>(kind: K, name: string)
    → Promise<BrickComponentMap[K] | undefined>

  BrickComponentMap:
    tool       → Tool
    skill      → SkillComponent
    agent      → AgentDescriptor
    middleware → BrickArtifact
    channel    → BrickArtifact
```

### Resolution flow

```
  resolve("skill", "coding")
       │
       ├── kind === "tool"? → delegate to resolveTool() (integrity + sandbox)
       │
       ├── lazy cache lookup (per-kind Map, populated on first call)
       │
       ├── checkBrickRequires(artifact.requires, availableTools)
       │   ├── requires.bins  → PATH lookup
       │   ├── requires.env   → process.env check
       │   └── requires.tools → Set<toolName> check
       │   (unsatisfied → return undefined)
       │
       └── wrap artifact → SkillComponent
           return { name, description, content, tags }
```

## Hot Availability

When a brick is saved, how quickly does it become available?

```
  Brick Kind       Resolution Path          Availability
  ──────────       ───────────────          ────────────
  tool             resolveTool() per call   Immediate (mid-turn)
  skill, agent     resolve() per call       Immediate (cache invalidated)
  middleware       attach() re-runs         Next turn boundary
  channel          attach() re-runs         Next turn boundary
```

Cache invalidation flow:

```
  store.save(brick)
       │
       ▼
  store.watch() → StoreChangeEvent
       │
       ├── ForgeRuntime: invalidateCache()
       │   (clears tool cache + all kind caches + integrity cache)
       │
       └── ForgeComponentProvider: invalidateCache()
           (next attach() rebuilds component map)
```

## BrickRegistryBase

Generic brick discovery interface for consumers that don't need the full ForgeStore:

```
  BrickRegistryReader
  ├── search(query) → BrickPage     // cursor-based pagination
  ├── get(kind, name) → Result      // single brick lookup
  └── onChange?(listener) → unsub   // change notifications

  BrickRegistryWriter
  ├── register(brick) → Result
  └── unregister(kind, name) → Result

  BrickRegistryBackend = Reader + Writer
```

### Pagination

```
  const page1 = await registry.search({ kind: "tool", limit: 10 });
  // page1.items = [...10 tools]
  // page1.cursor = "10"

  const page2 = await registry.search({ kind: "tool", limit: 10, cursor: page1.cursor });
  // page2.items = [...next 10 tools]
```

## Trust and Verification

Every brick passes through trust enforcement before attachment:

```
  MIN_TRUST_BY_KIND:
    tool       → "sandbox"    (lowest — runs in sandbox)
    skill      → "sandbox"    (content only, no execution)
    agent      → "sandbox"    (manifest descriptor only)
    middleware → "promoted"   (intercepts all calls — high trust required)
    channel    → "promoted"   (I/O surface — high trust required)
```

Tools additionally pass content-addressed integrity verification:

```
  computeBrickId("tool", implementation)
    → SHA-256 hash of kind + code
    → must match artifact.id at resolve time
    → prevents tampering between save and load
```

## Use Cases

### Self-extending agent

Agent encounters a task it lacks tools for, forges one:

```
  User: "What's the SHA-256 of this file?"
  Agent: I don't have a hash tool. Let me forge one.
       │
       ▼
  forge-tool → verify → save → cache invalidated
       │
       ▼
  Agent: (calls the newly forged hash tool)
  Agent: "The SHA-256 is abc123..."
```

### Skill composition

Agent forges reusable prompt skills:

```
  Operator saves skill:code-review to store
       │
       ▼
  ForgeComponentProvider attaches as SkillComponent
       │
       ▼
  @koi/context queries agent.query<SkillComponent>("skill:")
       │
       ▼
  Skill content injected into system prompt
  Agent now knows how to do code reviews
```

### Peer agent discovery

Orchestrator discovers available worker agents:

```
  ForgeStore contains agent:researcher, agent:writer, agent:reviewer
       │
       ▼
  Orchestrator queries agent.query<AgentDescriptor>("agent:")
       │
       ▼
  Orchestrator reads manifestYaml, decides which to spawn
  (see #393 for lifecycle governance)
```

### Hot middleware injection

Operator promotes a middleware brick:

```
  Operator saves middleware:rate-limiter (trustTier: "promoted")
       │
       ▼
  Next turn: ForgeComponentProvider re-attaches
       │
       ▼
  Rate limiter middleware now intercepts all model/tool calls
```

## Package Map

```
  @koi/core (L0)
  ├── SkillComponent, AgentDescriptor          (ecs.ts)
  ├── agentToken()                             (ecs.ts)
  ├── BrickComponentMap                        (brick-component-map.ts)
  └── BrickRegistryBase interfaces             (brick-registry.ts)

  @koi/engine (L1)
  └── ForgeRuntime.resolve<K>() interface      (types.ts)

  @koi/forge (L2)
  ├── ForgeComponentProvider.attachBrick()      (forge-component-provider.ts)
  └── ForgeRuntime.resolve() implementation    (forge-runtime.ts)

  @koi/test-utils (L0u)
  ├── BrickRegistryContract test suite         (brick-registry-contract.ts)
  └── InMemoryBrickRegistry                    (in-memory-brick-registry.ts)
```

## Related

- [Koi Architecture](./Koi.md) — full system overview
- [#377](https://github.com/windoliver/koi/issues/377) — implementation issue
- [#360](https://github.com/windoliver/koi/issues/360) — manifest auto-resolution (wires `skills: auto` to this pipeline)
- [#393](https://github.com/windoliver/koi/issues/393) — agent lifecycle governance (copilot/worker for forged agents)
