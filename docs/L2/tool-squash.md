# @koi/tool-squash — Agent-Initiated Phase-Boundary Compression

Gives agents a `squash` tool to compress their own conversation history at natural phase boundaries. Old messages are replaced with the agent's summary (zero LLM cost), originals are archived to `SnapshotChainStore` for retrieval, and optionally facts are extracted to long-term memory. Includes a companion middleware that applies the compression before the next model call.

---

## Why It Exists

Agents accumulate large conversation histories — file reads, search results, planning discussions — that eventually hit context window limits. The existing system compactor (`@koi/middleware-compactor`) is reactive and blind: it fires when token thresholds are crossed and requires an LLM call to summarize.

The agent IS the LLM — it knows what's signal and what's noise. `@koi/tool-squash` lets the agent compress proactively at phase boundaries ("done planning, starting implementation"), producing higher-quality summaries at zero additional LLM cost.

This is the Layer A complement to the system compactor (Layer B):

| | Layer A (squash) | Layer B (compactor) |
|---|---|---|
| **Trigger** | Agent calls `squash(phase, summary)` | Token threshold crossed |
| **Summarizer** | Agent's own summary (free) | LLM call ($) |
| **Quality** | Agent knows what matters | Generic blind summarization |
| **Timing** | Phase boundaries | Reactive, may interrupt |

---

## What This Enables

```
BEFORE SQUASH (context filling up)
══════════════════════════════════

┌─────────────────────────────────────────────┐
│ [System prompt]                              │
│ USER: "Build me a todo app"                  │
│ AGENT: reads package.json (200 lines)        │
│ AGENT: reads src/app.tsx (500 lines)         │
│ USER: "Use SQLite for storage"               │
│ AGENT: searches "bun sqlite" (3 pages)       │  ← stale planning
│ AGENT: "Here's my plan: ..."                 │     phase eating
│ USER: "Go ahead"                             │     tokens
│ AGENT: writes schema.sql, db.ts, routes.ts   │
│ ...                                          │
│ ████████████████████████████████████░░ 95%    │
│ ⚠️  Context almost full                       │
└─────────────────────────────────────────────┘

Agent calls: squash(phase="implementation", summary="...", facts=["Uses SQLite"])
                            │
                            ▼

AFTER SQUASH (room to work)
═══════════════════════════

┌─────────────────────────────────────────────┐
│ [System prompt]                              │
│                                              │
│ [PINNED] USER: "Build me a todo app"         │
│                                              │
│ ┌─────────────────────────────────────────┐  │
│ │ 📋 SQUASH SUMMARY (phase: impl)        │  │
│ │ Built todo app with SQLite:             │  │
│ │ • Schema: todos table (id, title, done) │  │
│ │ • DB layer: db.ts with CRUD ops         │  │
│ │ • API: REST endpoints at /api/todos     │  │
│ └─────────────────────────────────────────┘  │
│                                              │
│ [Recent 4 messages preserved]                │
│                                              │
│ ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░ 25%     │
│ ✅ 75% freed                                  │
└─────────────────────────────────────────────┘

Archived originals → SnapshotChainStore (retrievable)
Facts → Memory store (persisted across sessions)
```

---

## Quick Start

```typescript
import { createKoi } from "@koi/engine";
import { createSquashProvider } from "@koi/tool-squash";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";

// Mutable message list — the runtime updates this as messages flow in
const messages: InboundMessage[] = [];

const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();

const { provider, middleware } = createSquashProvider(
  { archiver, sessionId: "session-1" as SessionId },
  () => messages,
);

const runtime = await createKoi({
  manifest: { name: "my-agent", model: { name: "claude-sonnet-4-5-20250514" } },
  adapter,
  providers: [provider],
  middleware: [middleware],
});
```

The agent now has `tool:squash` and `skill:squash` in its component map.

---

## Configuration

```typescript
createSquashProvider({
  archiver,         // required — SnapshotChainStore for archiving originals
  sessionId,        // required — SessionId for archive chain naming
  memory,           // optional — MemoryComponent for fact extraction
  tokenEstimator,   // optional — TokenEstimator (default: 4 chars/token heuristic)
  preserveRecent,   // optional — number of recent messages to keep (default: 4)
  maxPendingSquashes, // optional — queue overflow cap (default: 3)
}, getMessages)
```

### SquashConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `archiver` | `SnapshotChainStore<InboundMessage[]>` | *(required)* | Archive store for snapshotting squashed messages |
| `sessionId` | `SessionId` | *(required)* | Session ID for archive chain naming |
| `memory` | `MemoryComponent` | `undefined` | Memory component for fact extraction |
| `tokenEstimator` | `TokenEstimator` | heuristic (4 chars/tok) | Custom token estimator |
| `preserveRecent` | `number` | `4` | Most recent messages to preserve |
| `maxPendingSquashes` | `number` | `3` | Max pending squashes before oldest dropped |

### With Memory (fact extraction)

```typescript
import { createFsMemory } from "@koi/memory-fs";

const memory = createFsMemory({ dataDir: "./memory" });

const { provider, middleware } = createSquashProvider(
  {
    archiver,
    sessionId,
    memory: memory.component, // enables fact extraction
  },
  () => messages,
);
```

---

## Architecture

```
@koi/tool-squash (L2)
├── types.ts               ← config, constants, tool descriptor, PendingQueue
├── estimator.ts           ← heuristic token estimator (4 chars/token)
├── skill.ts               ← SkillComponent teaching agents when/how to squash
├── squash-tool.ts         ← tool factory: validate → archive → extract → queue
├── squash-middleware.ts   ← middleware: drain pending → replace messages
├── provider.ts            ← bundle factory: tool + skill + middleware
└── index.ts               ← public API

Dependencies:
  ● @koi/core (L0) — types, interfaces, branded IDs
  ✗ @koi/engine (L1) — never imported in production
  ✗ peer L2 — never imported in production
```

### How Tool + Middleware Cooperate

```
  Agent calls squash tool
         │
         ▼
  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │  squash-tool  │───▶│  pending queue   │───▶│ squash-middleware │
  │  (priority: -)│    │  (closure-shared)│    │  (priority: 220)  │
  │               │    │                  │    │                   │
  │ • validate    │    │ CompactionResult │    │ • drain queue     │
  │ • archive     │    │ waiting to apply │    │ • replace msgs    │
  │ • extract     │    │                  │    │ • pass to next    │
  │   facts       │    └──────────────────┘    └────────┬──────────┘
  │ • enqueue     │                                     │
  └──────────────┘                                      ▼
                                               ┌──────────────────┐
                                               │    compactor      │
                                               │  (priority: 225)  │
                                               │                   │
                                               │ sees SMALLER       │
                                               │ context — may      │
                                               │ skip its LLM call  │
                                               └────────┬──────────┘
                                                        │
                                                        ▼
                                                   LLM call
                                               (with room to think)
```

The middleware runs at priority **220**, before the compactor at **225**. When no squash is pending, the middleware is zero-cost (early return on empty queue check).

---

## Tool Descriptor (exposed to model)

| Field | Value |
|-------|-------|
| `name` | `"squash"` |
| `trustTier` | `"verified"` |
| **required input** | `phase` (string), `summary` (string) |
| **optional input** | `facts` (string array) |

The `phase` labels the completed phase (e.g., "planning", "research"). The `summary` replaces old messages. The `facts` array stores durable knowledge to memory.

---

## SkillComponent

`createSquashProvider` automatically attaches `skill:squash` alongside the tool. The skill teaches agents:

| Area | Guidance |
|------|----------|
| **When to squash** | Phase transitions, after 10+ tool calls, large intermediate output, before complex next steps |
| **When NOT to squash** | Mid-task, too early (<8 messages), right before finishing |
| **Summary quality** | Key decisions, files changed, current state, unresolved issues |
| **Fact extraction** | Cross-session durable truths only (preferences, conventions, environment) |

### Accessing the skill standalone

```typescript
import { SQUASH_SKILL, SQUASH_SKILL_NAME } from "@koi/tool-squash";
import { skillToken } from "@koi/core";

const skill = agent.component(skillToken(SQUASH_SKILL_NAME));
// skill.content → markdown guidance string
// skill.tags   → ["context-management", "compression"]
```

---

## Data Flow

```
  LLM generates: squash({ phase: "planning", summary: "...", facts: [...] })
         │
         ▼
  ┌─────────────────────────────────────────────────┐
  │ 1. Validate input                                │
  │    phase: string (required), summary: string     │
  │    facts: string[] (optional)                    │
  │                                                  │
  │    ✗ Bad input → { ok: false, code: "VALIDATION"}│
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │ 2. Partition messages                            │
  │    pinned: msg.pinned === true (always kept)     │
  │    squashable: everything else                   │
  │                                                  │
  │    ≤ preserveRecent squashable? → noop           │
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │ 3. Split squashable                              │
  │    head = squashable[0 .. -preserveRecent]       │
  │    tail = squashable[-preserveRecent ..]          │
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │ 4. Archive head to SnapshotChainStore            │
  │    chain: "squash:{sessionId}"                   │
  │    metadata: { phase, timestamp }                │
  │    option: skipIfUnchanged: true                 │
  │                                                  │
  │    ✗ Failure → { ok: false, code: "ARCHIVE_FAILED"}│
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │ 5. Extract facts (best-effort)                   │
  │    memory.store(fact, { category: phase })        │
  │    Failures silently tracked in factsStored count │
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │ 6. Build CompactionResult                        │
  │    messages: [...pinned, summaryMsg, ...tail]     │
  │    strategy: "squash"                            │
  │    → queued for companion middleware              │
  └──────────────────┬───────────────────────────────┘
                     │
                     ▼
  ┌─────────────────────────────────────────────────┐
  │ 7. Return metrics to agent                       │
  │    { ok, phase, originalMessages, originalTokens,│
  │      compactedTokens, archivedNodeId, factsStored}│
  └─────────────────────────────────────────────────┘
```

---

## Error Handling

| Condition | Returns | Code |
|-----------|---------|------|
| Missing/empty `phase` or `summary` | `{ ok: false, error, code }` | `VALIDATION` |
| Invalid `facts` (not string array) | `{ ok: false, error, code }` | `VALIDATION` |
| Abort signal already fired | `{ ok: false, error, code }` | `ABORTED` |
| Archive store failure | `{ ok: false, error, code }` | `ARCHIVE_FAILED` |
| Memory store throws | Squash succeeds, `factsStored` reflects partial count | *(best-effort)* |
| Too few messages | Noop result (`originalMessages: 0`) | *(success)* |

Archive is **fail-fast** — if the archive can't store originals, the squash aborts (no message replacement). Facts are **best-effort** — failures never block the squash.

---

## Testing

```
squash-tool.test.ts — 12 tests
  Happy path:
  ● Squash with summary: archive called, CompactionResult queued
  ● With facts: memory.store called for each fact
  ● Summary with special characters stored verbatim

  Edge cases:
  ● Empty message history → noop
  ● Fewer than preserveRecent → noop
  ● All messages pinned → noop
  ● Mixed pinned + normal → pinned preserved in output

  Error handling:
  ● Archive failure → ARCHIVE_FAILED
  ● Memory not provided, facts given → silently dropped
  ● Memory store throws → squash still succeeds
  ● Abort signal already aborted → ABORTED
  ● Missing phase/summary → VALIDATION

squash-middleware.test.ts — 6 tests
  ● No pending squash → passthrough (zero-cost)
  ● Single pending squash → messages replaced
  ● Multiple pending → most recent wins
  ● Queue overflow → oldest dropped
  ● onSessionEnd → queue cleared
  ● describeCapabilities → correct label/description

e2e.test.ts — 5 tests
  ● Full flow: tool → middleware replaces messages
  ● Archive retrievable via real SnapshotChainStore
  ● Facts stored via memory.store
  ● Skill component attached alongside tool
  ● Detach clears cached components

e2e-real-llm.test.ts — 7 tests (gated on E2E_TESTS=1 + API key)
  ● LLM calls squash tool through full Pi adapter stack
  ● Archive populated with correct metadata
  ● Middleware replaces messages before next model call
  ● Facts stored to memory when LLM provides them
  ● Multi-tool agent uses squash alongside other tools
  ● Session lifecycle hooks fire correctly
  ● Pinned messages preserved through squash
```

```bash
# Unit + integration tests
bun --cwd packages/tool-squash test

# E2E with real LLM
E2E_TESTS=1 bun --cwd packages/tool-squash test src/__tests__/e2e-real-llm.test.ts
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Tool + middleware in one package | They share a closure-scoped pending queue. Splitting would require a shared state package — unnecessary complexity |
| Phase as archive label, not region marker | Simpler than start/end markers. The agent names the phase after it's done, not before |
| Agent-provided summary (no LLM call) | The agent IS the LLM. It already knows what matters. Zero additional cost |
| Agent-provided facts (not auto-extracted) | Auto-extraction requires an LLM call. Agent can select durable facts during its normal reasoning |
| Archive-or-fail, facts best-effort | Losing originals is unrecoverable. Losing a fact just means it won't be recalled later |
| Bounded queue (max 3) | Multiple rapid squashes can queue up. Oldest are dropped to prevent memory growth |
| Priority 220 (before compactor at 225) | Squash reduces context first, so the compactor sees smaller input and may skip its LLM call |
| Skill bundled in provider | No separate manifest entry needed. Tool + behavioral guidance travel together |
| `detach()` clears cache | Prevents stale closures if agent is re-assembled during hot-reload |
| Zero-cost middleware passthrough | Empty queue check (`length === 0`) returns original request unchanged. No allocation on the hot path |
| `skipIfUnchanged: true` on archive put | Prevents duplicate archives if the same messages are squashed twice |

---

## Exports

```typescript
// Provider factory
export { createSquashProvider } from "./provider.js";
export type { SquashProviderBundle } from "./provider.js";

// Skill
export { SQUASH_SKILL, SQUASH_SKILL_NAME } from "./skill.js";

// Types + constants
export type { SquashConfig, SquashResult } from "./types.js";
export { SQUASH_DEFAULTS, SQUASH_TOOL_DESCRIPTOR } from "./types.js";
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    SnapshotChainStore, CompactionResult, TokenEstimator, │
    MemoryComponent, ToolDescriptor, Tool, InboundMessage, │
    SkillComponent, skillToken, chainId, SessionId         │
                                                           │
L2  @koi/tool-squash ◄─────────────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ All interface properties readonly
    ✓ Returns error objects (never throws for expected failures)
    ✓ import type for type-only imports
    ✓ .js extensions on all local imports
    ✓ No enum, any, namespace, as Type, ! in production code
```
