# Auto-Forge — Crystallize-to-Forge Pipeline

`auto-forge` is a middleware in `@koi/crystallize` that closes the gap between pattern detection and tool creation. It automatically forges high-confidence crystallized patterns into `BrickArtifact`s, saves them to the `ForgeStore`, and triggers hot-attach so the agent can use the new tool immediately.

---

## Why It Exists

Without auto-forge, the crystallize→forge pipeline has a manual gap: the middleware detects patterns and produces `CrystallizedToolDescriptor`s, but nobody consumes them. A human must review and manually forge. Auto-forge closes this loop for high-confidence patterns while preserving human-in-the-loop for uncertain ones.

```
BEFORE: Manual gap
┌─────────────────────┐          ┌─────────────────────┐
│  Crystallize detects │          │  ForgeStore          │
│  "fetch→parse→save" │──── ? ──→│  (no new bricks)     │
│  3× occurrences     │          │                      │
└─────────────────────┘          └─────────────────────┘
                        ↑
                  Human must intervene

AFTER: Auto-forge bridges the gap
┌─────────────────────┐          ┌─────────────────────┐
│  Crystallize detects │  auto   │  ForgeStore          │
│  "fetch→parse→save" │──forge──→│  + fetch-parse-save  │
│  3× occurrences     │         │    (hot-attached!)    │
└─────────────────────┘          └─────────────────────┘
```

---

## Architecture

### Layer position

```
L0  @koi/core              ─ ForgeStore, KoiMiddleware, BrickArtifact (types only)
L0u @koi/errors             ─ KoiRuntimeError
L0u @koi/crystallize        ─ this middleware lives here (no L1 dependency)
```

Auto-forge depends on L0 types only. The caller injects L2 instances (ForgeStore) via config — no L2→L2 import.

### How it fits in the middleware chain

```
Priority ordering:
  475  event-trace middleware     ← records TurnTrace events
  950  crystallize middleware     ← detects patterns, emits candidates
  960  auto-forge middleware      ← forges candidates into bricks
```

### Data flow

```
                  crystallize middleware
                         │
                         │ getCandidates()
                         ▼
              ┌──────────────────────┐
              │  auto-forge          │
              │  middleware          │
              │                     │
              │  1. Read candidates  │
              │  2. handleCandidates │
              │     (forge handler)  │
              │  3. Run verifiers    │
              │  4. Map to brick     │
              │  5. Save to store    │
              └──────────┬───────────┘
                         │
                         │ StoreChangeEvent("saved")
                         ▼
              ┌──────────────────────┐
              │  ForgeStore.watch()  │
              │  → hot-attach in L1  │
              │  → agent gets tool!  │
              └──────────────────────┘
```

---

## API Reference

### `createAutoForgeMiddleware(config)`

Factory function that returns a `KoiMiddleware`.

```typescript
import { createAutoForgeMiddleware } from "@koi/crystallize/auto-forge";

const middleware = createAutoForgeMiddleware({
  crystallizeHandle,          // from createCrystallizeMiddleware()
  forgeStore,                 // injected ForgeStore instance
  scope: "agent",
  confidenceThreshold: 0.9,   // default
  maxForgedPerSession: 3,      // default
  trustTier: "sandbox",        // default
  onForged: (descriptor) => console.log(`Forged: ${descriptor.name}`),
  onSuggested: (candidate) => console.log(`Below threshold: ${candidate.suggestedName}`),
  onError: (err) => console.error("Forge error:", err),
});
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `crystallizeHandle` | `CrystallizeHandle` | required | Handle from `createCrystallizeMiddleware` |
| `forgeStore` | `ForgeStore` | required | Store to save forged bricks |
| `scope` | `ForgeScope` | required | Visibility: `"agent"` / `"zone"` / `"global"` |
| `confidenceThreshold` | `number` | `0.9` | Minimum confidence to auto-forge |
| `trustTier` | `TrustTier` | `"sandbox"` | Trust level for forged tools |
| `maxForgedPerSession` | `number` | `3` | Cap on tools forged per session |
| `verifyPipeline` | `AutoForgeVerifier[]` | `[]` | Optional verification stages |
| `onForged` | `(descriptor) => void` | no-op | Callback when tool is forged |
| `onSuggested` | `(candidate) => void` | no-op | Callback for below-threshold candidates |
| `onError` | `(error) => void` | no-op | Error handler (never throws) |
| `clock` | `() => number` | `Date.now` | Clock function (testable) |

### Verification pipeline

Custom verifiers can gate auto-forge:

```typescript
const verifier: AutoForgeVerifier = {
  name: "size-check",
  verify: async (descriptor) => {
    const stepCount = descriptor.provenance.ngramKey.split("|").length;
    return stepCount <= 5
      ? { passed: true }
      : { passed: false, message: "Too many steps" };
  },
};
```

If any verifier fails, the brick is not saved and `onError` is called.

---

## Pipeline Executor

Auto-forged tools use a shared runtime helper for step-by-step execution:

```typescript
import { executePipeline } from "@koi/crystallize/pipeline-executor";

const result = await executePipeline(
  [{ toolId: "fetch" }, { toolId: "parse" }, { toolId: "save" }],
  { executor: (toolId, args) => callTool(toolId, args) },
  initialArgs,
);

if (result.ok) {
  console.log("Final value:", result.value);
  console.log("All results:", result.partialResults);
} else {
  console.log(`Failed at step ${result.failedAtStep}: ${result.error}`);
  console.log("Partial results:", result.partialResults);
}
```

The executor threads each step's output as the next step's input, captures partial results, and reports exactly which step failed.

---

## Design Decisions

1. **Fire-and-forget** — Forge operations run asynchronously after `onAfterTurn`, not on the hot path. Errors are caught and reported via `onError`, never thrown.
2. **L0-only dependencies** — `AutoForgeVerifier` is defined locally to avoid importing from `@koi/forge` (L2). The caller injects L2 instances via config.
3. **Verification is optional** — If no `verifyPipeline` is provided, candidates that pass the confidence threshold are forged immediately.
4. **Success rate weighting** — The scoring formula includes `successRate` derived from tool call outcomes in trace data. Patterns where tools frequently fail score lower.
5. **Rate limiting** — `maxForgedPerSession` prevents runaway tool creation. The default (3) is conservative.
