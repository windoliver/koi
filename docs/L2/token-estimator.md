# @koi/token-estimator — Shared Heuristic Token Estimation

Provides a single, configurable heuristic token estimator (`4 chars ≈ 1 token`) that implements the `TokenEstimator` contract from `@koi/core`. Eliminates 11 duplicate implementations across the monorepo.

---

## Why It Exists

The `4 chars ≈ 1 token` heuristic was duplicated **11 times** across the monorepo — 3 full `TokenEstimator` implementations and 8 bare `estimateTokens()` local functions. L2 packages cannot import from peer L2 packages (architecture rule), so each package reimplemented the same logic.

Without this package:

1. **Scattered implementations** — 11 copies of the same heuristic, each slightly different in naming and config surface
2. **Inconsistent behavior** — some implementations counted per-message overhead, others didn't
3. **No configurability** — hardcoded `4` everywhere, no way to tune for CJK-heavy or code-heavy workloads
4. **Maintenance burden** — fixing a bug or changing the heuristic requires touching 11 files

---

## Architecture

`@koi/token-estimator` is an **L0u utility package** — it depends only on `@koi/core` (L0). Every L2 package can import it.

```
┌─────────────────────────────────────────────┐
│  @koi/token-estimator  (L0u)                │
│                                             │
│  estimator.ts    ← factory, singleton,      │
│                    bare function, constant   │
│  index.ts        ← public API surface       │
│                                             │
├─────────────────────────────────────────────┤
│  Dependencies                               │
│                                             │
│  @koi/core  (L0)   TokenEstimator,          │
│                     InboundMessage           │
└─────────────────────────────────────────────┘
```

### Consumer graph (before → after)

```
BEFORE: 11 duplicated implementations
─────────────────────────────────────────────

  context/         compactor/       context-editing/
  estimator.ts     estimator.ts     estimator.ts
  (COPY #1)        (COPY #2)        (COPY #3)

  file-resolution/ middleware-memory/ middleware-ace/
  tokens.ts        store.ts           injector.ts
  (local fn)       (local fn)         (local fn)

  long-running/    long-running/    browser-playwright/
  context-bridge   harness.ts       a11y-serializer.ts
  (local fn)       (inline /4)      (local const)

  model-router/
  complexity-classifier.ts
  (local const)


AFTER: single source of truth
─────────────────────────────────────────────

                  @koi/token-estimator
                  ┌─────────────────────┐
                  │ createHeuristic...  │
                  │ HEURISTIC_ESTIMATOR │
                  │ estimateTokens      │
                  │ CHARS_PER_TOKEN     │
                  └────────┬────────────┘
                           │
        ┌──────┬──────┬────┴────┬──────┬──────┐
        ▼      ▼      ▼        ▼      ▼      ▼
     context  compac  ctx-ed  file-  memory  ace
              tor     iting   resol
        ┌──────┬──────┐
        ▼      ▼      ▼
     long-   browser  model-
     running  playw   router
```

---

## How It Works

### Token Estimation Heuristic

The default heuristic uses UTF-16 string length divided by 4:

```
Token count = ⌈ text.length / charsPerToken ⌉

Examples (charsPerToken = 4):
  ""         → 0 tokens
  "a"        → 1 token
  "abcd"     → 1 token
  "abcde"    → 2 tokens  (rounds up)
  "a" × 400  → 100 tokens
```

### Message Estimation

For `estimateMessages()`, the estimator adds structural overhead:

```
For each message:
  ├── + perMessageOverhead (default: 4)    ← role, separators
  └── For each content block:
      ├── text block → ⌈ text.length / charsPerToken ⌉
      └── non-text block → + perNonTextBlockOverhead (default: 100)
                             (image, file, custom, button)
```

### API Shape

```
┌─────────────────────────────────────────────────────────┐
│  @koi/token-estimator exports                           │
│                                                         │
│  CHARS_PER_TOKEN          = 4          (constant)       │
│                                                         │
│  createHeuristicEstimator(config?)     (factory)        │
│    → TokenEstimator { estimateText, estimateMessages }  │
│                                                         │
│  HEURISTIC_ESTIMATOR                   (singleton)      │
│    = createHeuristicEstimator()                         │
│                                                         │
│  estimateTokens(text)                  (bare function)  │
│    = ⌈ text.length / 4 ⌉                               │
└─────────────────────────────────────────────────────────┘
```

---

## API Reference

### `createHeuristicEstimator(config?: HeuristicEstimatorConfig): TokenEstimator`

Factory that returns a `TokenEstimator` (L0 contract) with configurable parameters.

```typescript
interface HeuristicEstimatorConfig {
  readonly charsPerToken?: number;          // default: 4
  readonly perMessageOverhead?: number;     // default: 4
  readonly perNonTextBlockOverhead?: number; // default: 100
}
```

### `HEURISTIC_ESTIMATOR: TokenEstimator`

Pre-built constant using default config. Use this when no customization is needed.

### `estimateTokens(text: string): number`

Bare convenience function for text-only estimation. Always uses `CHARS_PER_TOKEN = 4`.

### `CHARS_PER_TOKEN: 4`

The default characters-per-token ratio, exported for consumers that need the raw constant (e.g., truncation math).

---

## Examples

### Basic: use the singleton

```typescript
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";

const tokens = HEURISTIC_ESTIMATOR.estimateText("Hello, world!");
// → 4

const msgTokens = HEURISTIC_ESTIMATOR.estimateMessages(messages);
// → includes per-message overhead + content estimation
```

### Quick text estimation

```typescript
import { estimateTokens } from "@koi/token-estimator";

const tokens = estimateTokens("Hello, world!");
// → 4
```

### Custom config for CJK-heavy workloads

```typescript
import { createHeuristicEstimator } from "@koi/token-estimator";

// CJK characters tokenize at roughly 2 chars/token
const estimator = createHeuristicEstimator({ charsPerToken: 2 });
const tokens = estimator.estimateText("你好世界");
// → 2
```

### Truncation with shared constant

```typescript
import { CHARS_PER_TOKEN } from "@koi/token-estimator";

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
```

---

## Design Decisions

### Why L0u, not L2?

L2 packages cannot import from peer L2 packages. Token estimation is needed by 9 different L2 packages. Placing it in L0u (alongside `@koi/errors`, `@koi/validation`, etc.) makes it universally importable.

### Why factory + singleton + bare function?

Three access patterns for three use cases:

| Pattern | Use case |
|---------|----------|
| `createHeuristicEstimator(config)` | Custom config (tests, CJK, tuning) |
| `HEURISTIC_ESTIMATOR` | Default config, need both `estimateText` and `estimateMessages` |
| `estimateTokens(text)` | Quick text-only estimation (most common case) |

### Why not a real tokenizer (tiktoken, etc.)?

The heuristic is intentionally simple. It runs in microseconds with zero dependencies. Real tokenizers add ~50MB of WASM/data and are only marginally more accurate for the use cases in this codebase (budget checks, trigger thresholds, truncation). If precision is needed, consumers can create a custom `TokenEstimator` implementation wrapping a real tokenizer.

### Why `perMessageOverhead` and `perNonTextBlockOverhead`?

Real LLM APIs add tokens for message roles, separators, and non-text content. The defaults (4 and 100) are conservative estimates. Without these, message-level estimation would systematically undercount, causing premature compaction triggers or exceeded budgets.

---

## Layer Compliance

- [x] `@koi/core` (L0) — `TokenEstimator` interface, `InboundMessage` type
- [x] No imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties are `readonly`
- [x] All array parameters are `readonly T[]`
- [x] Immutable — no mutation of inputs or shared state
- [x] `let` used only with justification comments (accumulator in message loop)
- [x] Pure functions — deterministic, no side effects
