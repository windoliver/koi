# @koi/middleware-hot-memory — Automatic Hot-Tier Memory Injection

`@koi/middleware-hot-memory` is an L2 middleware package that automatically
injects recently-accessed memories into every model call. The agent doesn't
invoke tools or call `recall()` — hot memories appear in context transparently,
giving the LLM ambient awareness of its most relevant knowledge.

---

## Why it exists

Agent memory systems have a **cold start problem per turn**: the LLM sees only
the conversation history, not the knowledge it stored in previous sessions or
earlier in the current session. Without injection, the agent must explicitly
decide to recall — but it can't decide to recall what it doesn't know it has.

```
Without hot-memory:
  Agent has 50 stored facts from prior sessions
  User asks: "Set up the project"
  → Agent starts from scratch, ignores stored preferences and context

With hot-memory:
  [Hot Memories]
  - User prefers Bun over Node.js
  - Project uses ESM-only with .js extensions
  - Dark mode preferred
  → Agent applies stored knowledge without being asked
```

The middleware bridges the gap between **stored knowledge** and **active
context** using the tier system already built into `@koi/memory-fs`.

---

## What this enables

### For agent builders

- **Zero-config ambient memory** — enable `memoryFs` in context-arena and hot
  memories auto-inject. No tools, no explicit recall, no prompt engineering.
- **Budget-controlled injection** — preset-driven token limits prevent memory
  from crowding out conversation history.
- **Turn-interval caching** — recall happens every N turns (default 5), not
  every turn. 80% of turns have zero I/O cost.
- **Graceful degradation** — recall errors are swallowed with a warning. The
  agent continues without injection rather than crashing.

### For users

- Agents that **remember context** from prior sessions automatically
- Recently-discussed facts stay visible without re-explaining them
- No manual "remember this" — frequently-accessed knowledge stays hot

### How it complements other memory middleware

| Middleware | Strategy | Frequency | Purpose |
|---|---|---|---|
| **hot-memory** (310) | Wildcard + tier filter | Every 5 turns | Ambient awareness of recent knowledge |
| **personalization** (420) | Semantic query | Every turn | Relevant preferences for current task |
| **preference** (410) | Keyword detection | Every turn | Detect + store preference changes |

Hot-memory uses **tier-based** recall (what's recent), personalization uses
**relevance-based** recall (what's related to the current message). They inject
different memories with minimal overlap.

---

## Architecture

### Layer position

```
L0  @koi/core ──────────────────────────────────────────┐
    KoiMiddleware, MemoryComponent, MemoryRecallOptions, │
    CapabilityFragment, TokenEstimator                    │
                                                          ▼
L2  @koi/middleware-hot-memory ◄────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    one L0u dependency: @koi/token-estimator
```

### Internal module map

```
index.ts                    ← public re-exports
│
├── types.ts                ← HotMemoryConfig, HotMemoryDefaults, HOT_MEMORY_DEFAULTS
└── hot-memory-middleware.ts ← createHotMemoryMiddleware() factory
```

---

## How it works

### Per-turn flow

```
wrapModelCall / wrapModelStream
│
├─ First call ever?
│  └─ Yes → synchronous fetchHotMemories() (initial load)
│
├─ cachedMessage exists?
│  └─ Yes → prepend [Hot Memories] to request.messages
│
├─ Call next(request) → model executes
│
└─ Post-call: should refresh? (turnCount % refreshInterval === 0)
   └─ Yes → async fetchHotMemories() (fire-and-forget for next turn)
```

### Recall strategy

```typescript
memory.recall("*", { tierFilter: "hot", limit: 20 })
```

- **Wildcard query** `"*"` — not searching for specific content, just
  retrieving everything in the hot tier
- **Tier filter** — `memory-fs` computes tiers dynamically from exponential
  decay (`decayScore >= 0.7` = hot, roughly ≤10 days since last access)
- **Limit 20** — cap on number of memories to prevent runaway injection
- **Token budget** — results are formatted and truncated to fit the configured
  `maxTokens` budget (default 4000)

### Injected message format

```
[Hot Memories]
- User prefers Bun over Node.js
- Project uses ESM-only with .js extensions
- Last session focused on auth module refactoring
```

Injected as a pinned system message with `senderId: "system:hot-memory"`,
prepended before all conversation messages.

### Tier calculation (handled by memory-fs)

Tiers are **not manually assigned** — they're computed at recall time:

```
decayScore = e^(-λ × ageDays)     where λ = ln(2) / 30

HOT:  decayScore >= 0.7  (~10 days or less since last access)
WARM: decayScore >= 0.3  OR accessCount >= 10
COLD: everything else
```

Each `recall()` hit updates `lastAccessed` and `accessCount`, keeping
frequently-used facts hot. Unused facts naturally decay to warm → cold.

---

## API

### `createHotMemoryMiddleware(config)`

```typescript
import { createHotMemoryMiddleware } from "@koi/middleware-hot-memory";

const hotMemory = createHotMemoryMiddleware({
  memory: memoryComponent,
  maxTokens: 4000,        // optional, default from preset
  refreshInterval: 5,     // optional, turns between recalls
});
```

Returns a `KoiMiddleware` with `name: "koi:hot-memory"` and `priority: 310`.

### `HotMemoryConfig`

```typescript
interface HotMemoryConfig {
  /** Memory component for hot-tier recall. Required. */
  readonly memory: MemoryComponent;
  /** Max tokens for injected memories. Default: 4000. */
  readonly maxTokens?: number | undefined;
  /** Turns between recall refreshes. Default: 5. 0 = session start only. */
  readonly refreshInterval?: number | undefined;
  /** Override the default token estimator. */
  readonly tokenEstimator?: TokenEstimator | undefined;
}
```

### `describeCapabilities`

Reports injection status and token usage:

```
"3 hot memories injected (850/4000 tokens)"
```

Returns `undefined` when no hot memories are available (no noise in capability
descriptions).

---

## Context Arena integration

`@koi/context-arena` (L3) wires hot memory automatically when `memoryFs` is
configured. No extra config needed:

```typescript
const bundle = await createContextArena({
  summarizer: myModelHandler,
  sessionId: mySessionId,
  getMessages: () => messages,
  memoryFs: { config: { baseDir: "./memory" } },
  // hot-memory middleware is enabled automatically
});
```

To override budget or refresh interval:

```typescript
const bundle = await createContextArena({
  // ...
  hotMemory: { maxTokens: 2000, refreshInterval: 3 },
});
```

To disable hot memory even with memoryFs:

```typescript
const bundle = await createContextArena({
  // ...
  hotMemory: { disabled: true },
});
```

### Preset budgets

| Preset | Token Budget | Refresh Interval |
|---|---|---|
| conservative | 1.5% of window (3000 tokens at 200K) | 8 turns |
| balanced | 2% of window (4000 tokens at 200K) | 5 turns |
| aggressive | 3% of window (6000 tokens at 200K) | 3 turns |

---

## Performance properties

| Operation | Cost | Frequency |
|---|---|---|
| Hot memory recall | 1 `memory.recall()` call (file I/O) | Every N turns (default 5) |
| Message formatting | String concatenation | Every turn (from cache) |
| Token estimation | Heuristic `text.length / 4` | On refresh only |
| LLM calls | **Zero** | Never |

**80% of turns have zero I/O cost** — the cached message is reused between
refresh intervals. On refresh, one `recall()` call reads from the filesystem.
No LLM calls are ever made by this middleware.

### Error handling

| Scenario | Behavior |
|---|---|
| `recall()` throws | Warning logged, existing cache kept, injection continues |
| `recall()` returns empty | No injection, `describeCapabilities` returns `undefined` |
| Token budget exceeded | Memories truncated (earliest dropped first) |
| First call before cache | Synchronous `await` (one-time initial load) |

---

## Related

- [Issue #657](https://github.com/windoliver/koi/issues/657) — Convention
  survival + tier-aware context injection
- `docs/L2/middleware-preference.md` — Preference drift detection (store-side)
- `docs/L2/middleware-personalization.md` — Preference injection (recall-side)
- `docs/L2/memory-fs.md` — Memory backend with tier calculation
- `docs/L3/context-arena.md` — Orchestrator that wires all memory middleware
