# @koi/middleware-preference — Preference Drift Detection & Memory Salience Gate

`@koi/middleware-preference` is an L2 middleware package that solves the
**confidently wrong agent** problem: once an agent writes confident preference
notes, it stops asking clarification questions. When preferences change, the
agent acts on stale beliefs without seeking confirmation. This middleware
detects preference drift and gates noise before it pollutes memory.

---

## Why it exists

PAHF research identifies a critical failure mode in agent memory systems:

```
Turn 1:   User says "I prefer dark mode"
          → Agent stores: "User prefers dark mode" ✓

Turn 50:  User says "Actually, switch to light mode"
          → Without this middleware: agent KEEPS using dark mode
            because the old memory note is confident and never questioned

          → With this middleware: drift detected → old note superseded
            → new preference stored → agent uses light mode ✓
```

The problem has two parts:

1. **Drift detection** — recognizing when a user's preference has changed
2. **Salience gating** — filtering noise ("ok thanks", "sounds good") before it
   gets stored as a preference, diluting real signal

Without salience gating, an agent's memory fills with low-value entries like
"User said ok" that drown out real preferences during recall.

---

## What this enables

### For agent builders

- **Self-correcting memory** — agents update their beliefs when users change
  their minds, instead of clinging to stale preferences
- **Cost-efficient LLM usage** — keyword pre-filter skips LLM calls for 90%+
  of turns where no drift occurs (cascaded architecture)
- **Pluggable classification** — inject any LLM via a simple
  `(prompt: string) => Promise<string>` callback, no vendor lock-in
- **Explicit supersession** — new `supersedes` option on `MemoryStoreOptions`
  lets any middleware precisely control which old facts are replaced

### For users

- Agents that **listen when you change your mind** instead of ignoring corrections
- Cleaner memory that only stores meaningful preferences, not every "ok thanks"
- Confidence that outdated preferences won't resurface in future sessions

### Failure mode coverage

| Scenario | Without middleware | With middleware |
|---|---|---|
| User changes preference | Old preference persists | Old superseded, new stored |
| User says "sounds good" | May be stored as preference | Salience gate filters it out |
| LLM classifier is down | Silent failure | Drift: fail-closed (assume changed), Salience: fail-open (store anyway) |
| Ambiguous phrasing ("I no longer need docs") | Misclassified as preference change | Keyword pre-filter catches, LLM confirms/denies |

---

## Architecture

### Layer position

```
L0  @koi/core                       ─ KoiMiddleware, TurnContext, MemoryComponent,
                                       MemoryStoreOptions (+ new `supersedes` field)
L2  @koi/middleware-preference       ─ this package (no L1 dependency)
L2  @koi/memory-fs                   ─ handles `supersedes` in store()
```

### Internal module map

```
index.ts              ← public re-exports
│
├── types.ts          ← PreferenceDriftSignal, PreferenceDriftDetector, SalienceGate, LlmClassifier
├── config.ts         ← PreferenceMiddlewareConfig + validatePreferenceConfig()
├── keyword-drift.ts  ← createKeywordDriftDetector() — 8 regex patterns, zero LLM cost
├── llm-drift.ts      ← createLlmDriftDetector() — LLM-based with old/new extraction
├── cascaded-drift.ts ← createCascadedDriftDetector() — keyword pre-filter → LLM confirmation
├── llm-salience.ts   ← createLlmSalienceGate() — LLM-as-judge noise filter
└── preference.ts     ← createPreferenceMiddleware() factory
                         onBeforeTurn pipeline + session lifecycle
```

### Lifecycle hook mapping

| Hook | What runs |
|---|---|
| `onSessionStart` | Register session as active |
| `onBeforeTurn` | Extract user text → detect drift → recall/store with supersession |
| `onSessionEnd` | Remove session from active set |

---

## How it works

### The decision flow (every turn)

```
onBeforeTurn
│
├─ Extract text from last user message
│  └─ No text? → return (skip turn)
│
├─ Run drift detector:
│  ├─ Keyword-only (no classify callback): 8 regex patterns, zero cost
│  ├─ Cascaded (with classify): keyword pre-filter → LLM confirmation
│  └─ Custom: user-supplied PreferenceDriftDetector
│
├─ No drift? → return (nothing to do)
│
├─ Recall existing preferences from memory
│  └─ Filter by category === "preference" and status === "active"
│
├─ Run salience gate (if configured):
│  ├─ LLM judge: "Is this a real preference worth remembering?"
│  └─ Not salient? → return (don't pollute memory)
│
└─ Store new preference with explicit supersession
   └─ memory.store(newPreference, { category: "preference", supersedes: [oldIds] })
```

### Cascaded cost optimization

```
User message: "Sounds good, thanks!"

  Keyword detector: no pattern match → no_drift
  LLM call:         SKIPPED (saved ~25 tokens + latency)

User message: "I no longer want dark mode"

  Keyword detector: "no longer" matches → drift_detected (candidate)
  LLM call:         "YES: old=dark mode new=light mode" → confirmed
  Memory:           supersede old "dark mode" fact, store "light mode"
```

In typical sessions, 90%+ of turns have no drift keywords — the LLM is never
called for those turns, making the cost nearly zero.

### Error handling: asymmetric safety

The two components use opposite failure strategies:

| Component | On error | Rationale |
|---|---|---|
| Drift detection | **Fail-closed** (assume drift) | Better to store a possibly-changed preference than to miss a real change |
| Salience gate | **Fail-open** (treat as salient) | Better to store something potentially unimportant than to lose a real preference |

This asymmetry ensures the system errs toward capturing preference changes
rather than ignoring them.

---

## Keyword patterns

The default keyword detector matches 8 change-indicating phrases:

| Pattern | Example match |
|---|---|
| `\bno longer\b` | "I **no longer** want dark mode" |
| `\bnot anymore\b` | "**Not anymore**, use spaces" |
| `\bchanged? my mind\b` | "I **changed my mind** about tabs" |
| `\bprefer .+ instead\b` | "I **prefer spaces instead**" |
| `\b(don't\|do not) (like\|want\|use)\b` | "I **don't want** vim" |
| `\b(actually I? (want\|prefer\|use))\b` | "**Actually I prefer** Bun" |
| `\bswitch (to\|from)\b` | "**Switch to** pnpm" |
| `\bfrom now on\b` | "**From now on** use 2-space indent" |

Additional patterns can be added via `additionalPatterns` in the config.

---

## API

### `createPreferenceMiddleware(config)`

```typescript
import { createPreferenceMiddleware } from "@koi/middleware-preference";

const preference = createPreferenceMiddleware({
  classify: (prompt) => haiku(prompt),  // any LLM callback
  memory: memoryComponent,              // from @koi/memory-fs or custom
});
```

Returns a `KoiMiddleware` with `name: "preference-drift"` and `priority: 410`.

### `PreferenceMiddlewareConfig`

```typescript
interface PreferenceMiddlewareConfig {
  /** Custom drift detector. Auto-wired from classify if not provided. */
  readonly driftDetector?: PreferenceDriftDetector;
  /** Custom salience gate. Auto-wired from classify if not provided. */
  readonly salienceGate?: SalienceGate;
  /** LLM classifier callback. Used to auto-wire detector and gate. */
  readonly classify?: LlmClassifier;
  /** Additional keyword patterns for drift detection. */
  readonly additionalPatterns?: readonly RegExp[];
  /** Max recalled preferences for supersession matching. Default: 5. */
  readonly recallLimit?: number;
  /** Category for storing/recalling preferences. Default: "preference". */
  readonly preferenceCategory?: string;
  /** Memory component for store/recall. Skipped if not provided. */
  readonly memory?: MemoryComponent;
}
```

### Auto-wiring behavior

The config resolves components based on what's provided:

| `classify` | `driftDetector` | `salienceGate` | Result |
|---|---|---|---|
| provided | not provided | not provided | Cascaded detector + LLM salience gate (auto-wired) |
| provided | provided | not provided | Custom detector + LLM salience gate |
| not provided | not provided | not provided | Keyword-only detector, no salience gate |
| not provided | provided | provided | Fully custom pipeline |

### Individual component factories

```typescript
// Keyword-only (zero LLM cost)
const detector = createKeywordDriftDetector({
  additionalPatterns: [/\bplease stop\b/i],
});

// LLM-based (with old/new extraction)
const detector = createLlmDriftDetector(classify);

// Cascaded (keyword pre-filter → LLM confirmation)
const detector = createCascadedDriftDetector(classify, {
  additionalPatterns: [/\bplease stop\b/i],
});

// LLM salience gate
const gate = createLlmSalienceGate(classify);
```

### Validation

```typescript
import { validatePreferenceConfig } from "@koi/middleware-preference";

const result = validatePreferenceConfig(rawConfig);
if (!result.ok) {
  console.error(result.error.message);
}
```

---

## L0 change: `supersedes` on `MemoryStoreOptions`

This package introduces a new optional field on `MemoryStoreOptions` in `@koi/core`:

```typescript
interface MemoryStoreOptions {
  // ... existing fields ...
  /** IDs of existing facts to explicitly supersede when storing this fact. */
  readonly supersedes?: readonly string[];
}
```

When `@koi/memory-fs` processes a store with `supersedes`, it marks the
referenced facts as `status: "superseded"` before appending the new fact. This
runs after dedup/reinforce and before automatic entity-based supersession.

The field is backward-compatible — existing callers are unaffected since it
defaults to `undefined`.

---

## Examples

### 1. Full setup with LLM classifier

```typescript
import { createPreferenceMiddleware } from "@koi/middleware-preference";
import { createFsMemory } from "@koi/memory-fs";

const memory = await createFsMemory({ baseDir: "./memory" });

const preference = createPreferenceMiddleware({
  classify: async (prompt) => {
    const response = await haiku(prompt);
    return response.text;
  },
  memory: memory.component,
});

const koi = await createKoi({
  adapter: createLoopAdapter({ modelCall, maxTurns: 30 }),
  middleware: [preference],
});
```

### 2. Keyword-only (zero LLM cost)

```typescript
const preference = createPreferenceMiddleware({
  memory: memory.component,
  // No classify callback → keyword-only detector, no salience gate
});
```

### 3. Custom drift detector

```typescript
import type { PreferenceDriftDetector } from "@koi/middleware-preference";

const customDetector: PreferenceDriftDetector = {
  detect: async (feedback, ctx) => {
    // Use embeddings to compare against stored preferences
    const similarity = await computeSimilarity(feedback, storedPrefs);
    if (similarity < 0.3) {
      return { kind: "drift_detected", newPreference: feedback };
    }
    return { kind: "no_drift" };
  },
};

const preference = createPreferenceMiddleware({
  driftDetector: customDetector,
  memory: memory.component,
});
```

### 4. Combined with goal-reminder

```typescript
const reminder = createGoalReminderMiddleware({
  sources: [{ kind: "manifest", objectives: ["Help user set up project"] }],
  baseInterval: 5,
  maxInterval: 20,
});

const preference = createPreferenceMiddleware({
  classify: (prompt) => haiku(prompt),
  memory: memory.component,
});

const koi = await createKoi({
  adapter: createLoopAdapter({ modelCall, maxTurns: 50 }),
  middleware: [reminder, preference],  // reminder at 330, preference at 410
});
```

---

## Priority and middleware ordering

`@koi/middleware-preference` has `priority: 410`, placing it after memory
middleware so recalled facts are available when needed:

```
priority: 300  @koi/middleware-audit          (audit all calls)
priority: 330  @koi/middleware-goal-reminder   (periodic goal injection)
priority: 340  @koi/middleware-goal-anchor     (every-call goal injection)
priority: 400  @koi/middleware-permissions     (enforce before execution)
priority: 410  @koi/middleware-preference      ← THIS (detect drift, gate stores)
```

---

## Performance properties

| Feature | Algorithm | Per-turn cost |
|---|---|---|
| Text extraction | Array scan of last message | O(content blocks) |
| Keyword detection | 8 regex tests | O(patterns × text length) |
| LLM confirmation | Single classifier call | ~25-40 tokens (only on keyword match) |
| Salience gate | Single classifier call | ~25 tokens (only on drift) |
| Memory recall | Backend-specific | 1 recall call (only on drift) |
| Memory store | Backend-specific + supersession | 1 store call (only on drift + salient) |

In typical sessions, **90%+ turns cost zero LLM tokens** because the keyword
pre-filter short-circuits before the LLM is consulted.

---

## Layer compliance

```
L0  @koi/core ────────────────────────────────────────────────┐
    KoiMiddleware, TurnContext, SessionContext,                │
    MemoryComponent, MemoryStoreOptions, ContentBlock          │
                                                               │
                                                               ▼
L2  @koi/middleware-preference ◄──────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external runtime dependencies
```

---

## Context Arena integration

`@koi/context-arena` (L3) wires preference drift detection **by default** when
memory is available. No extra config needed:

```typescript
const bundle = await createContextArena({
  summarizer: myModelHandler,
  sessionId: mySessionId,
  getMessages: () => messages,
  memoryFs: { config: { baseDir: "./memory" } },
  // preference middleware is enabled automatically (keyword-only)
});
```

To add LLM-backed cascaded detection, pass a `classify` callback:

```typescript
const bundle = await createContextArena({
  // ...
  preference: { classify: (prompt) => haiku(prompt) },
});
```

To disable preference drift detection entirely:

```typescript
const bundle = await createContextArena({
  // ...
  preference: false,
});
```

---

## Related

- [Issue #653](https://github.com/windoliver/koi/issues/653) — Original feature request
- `docs/L2/middleware-goal-reminder.md` — Complementary adaptive goal injection
- `docs/L2/memory-fs.md` — Memory backend that handles `supersedes` field
