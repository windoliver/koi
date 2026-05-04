# @koi/rlm-stack — Recursive Language Model Composition

`@koi/rlm-stack` is an **L3 meta-package** that wires
[`@koi/middleware-rlm`](./middleware-rlm.md) into a ready-to-use middleware
with thresholds coordinated against
[`@koi/context-manager`](./context-manager.md).

It contains **no new processing algorithms** — only configuration and
composition. Issue [#1359](https://github.com/windoliver/koi/issues/1359).

---

## Why It Exists

`@koi/middleware-rlm` is an unopinionated primitive: callers must supply a
token threshold, chunk size, priority, and several safety flags. Picking
these correctly requires knowing how the middleware interacts with
`@koi/context-manager`'s soft/hard compaction tiers — pick wrong and the
two systems fight (RLM segments before compaction can relieve pressure;
compaction summarizes work that RLM was about to chunk).

`createRlmStack` packages a small set of validated, opinionated
configurations so the typical caller wires "RLM + tiered context
management" with one call instead of recreating the threshold ordering
from scratch.

---

## Architecture

```
L3  @koi/rlm-stack          ─ this package
    imports: @koi/core, @koi/middleware-rlm, @koi/context-manager,
             @koi/token-estimator, @koi/sandbox-executor (types only)

L2  @koi/middleware-rlm     ─ provides createRlmMiddleware
L0u @koi/context-manager    ─ provides resolveThresholds (no middleware)
L0u @koi/token-estimator    ─ provides HEURISTIC_ESTIMATOR
L0  @koi/core               ─ KoiMiddleware, ModelRequest, TokenEstimator
```

### Threshold coordination

The stack treats RLM and context-manager as **non-overlapping** strategies
that fire at different pressure points on the same context window:

```
0% ───── softTrigger (50%) ───── hardTrigger (75%) ───── 100% (window) ───── ∞
   passthrough        microcompact       full compact          virtualize
                      (context-manager)  (context-manager)     (RLM segments)
```

- **passthrough** — request fits comfortably; no intervention.
- **compact** — context-manager truncates (soft) or summarizes (hard) the
  *transcript* to relieve pressure. Handled outside the middleware chain
  by the engine adapter consuming `enforceBudget`.
- **virtualize** — a *single* user input exceeds the entire context
  window. Compaction cannot help (the input itself is too large), so RLM
  segments the largest user text block into chunks and fans out.

By placing RLM's `maxInputTokens` at or near 100% of the context window,
RLM only fires when context-manager's compaction would have nothing to
compact — i.e. when the user's *current* input alone overflows.

---

## API

### `createRlmStack(config?): RlmStack`

```typescript
import { createRlmStack } from "@koi/rlm-stack";

const stack = createRlmStack({
  contextWindowTokens: 200_000,
  tier: "standard",
  acknowledgeSegmentLocalContract: true,
});

const middlewares = [stack.middleware /* ... other middleware */];
```

#### `RlmStackConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `contextWindowTokens` | `number` | `undefined` (falls back to `DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000` when nothing resolves) | Explicit context window. Forwarded to `resolveThresholds` as `contextWindowSize`. Used only when `modelId` is omitted **and** no override map applies — the resolver always prefers the registry over `contextWindowSize` for known models. |
| `modelId` | `string` | `undefined` | Optional model id. Forwarded **as-is** to `@koi/context-manager`'s `resolveThresholds` — no prefix stripping, no canonicalization. Pure delegation guarantees RLM and context-manager resolve the same window for the same input string. For prefixed or private model ids, supply `modelWindowOverrides` (keyed in the same form) so both layers pick up the override in lock-step. See *Caveats* below. |
| `modelWindowOverrides` | `Record<string, number>` | `undefined` | Optional per-model window overrides forwarded to `resolveThresholds`. Keys must match the form used for `modelId`. Mirrors `@koi/context-manager`'s field of the same name so the two systems resolve the same window for overridden models. |
| `tier` | `"light" \| "standard" \| "aggressive"` | `"standard"` | Preset chunk-size profile. See [Tiers](#tiers). |
| `priority` | `number` | `801` (`RLM_STACK_PRIORITY_FLOOR`) | Forwarded to `RlmConfig.priority`. The stack rejects values below `RLM_STACK_PRIORITY_FLOOR` as a **best-effort floor**, set strictly above the priority-`800` peers in the repo (notably `@koi/middleware-tool-disclosure`, which pins itself at 800 and requires being the innermost tool-list mutator). The `+1` removes the equal-priority race the engine sorter would otherwise allow. The floor still does **not** prove the full ordering invariant: composers stacking custom tool-injecting `wrapModelCall` middleware above `RLM_STACK_PRIORITY_FLOOR` must additionally verify their relative ordering or bump RLM's priority above those peers. Use `createRlmMiddleware` directly to opt out. |
| `acknowledgeSegmentLocalContract` | `boolean` | `false` | Forwarded to `RlmConfig`. **Required** to actually enable virtualization — when absent, RLM fails closed on every oversized request. |
| `trustMetadataRole` | `boolean` | `false` | Forwarded. Internal trusted callers only. |
| `segmentSeparator` | `string` | `""` | Forwarded. |
| `estimator` | `TokenEstimator` | `HEURISTIC_ESTIMATOR` | Forwarded. |
| `onEvent` | `(e: RlmEvent) => void` | `undefined` | Forwarded. |
| `sandboxExecutor` | `SandboxExecutor` | `undefined` | Reserved for future. The v2 `middleware-rlm` does not consume a sandbox executor (richer designs were deferred — see `middleware-rlm.md`). When provided, it is exposed on the returned stack handle for forward compatibility but is **not** wired into the middleware. |

#### `RlmStack`

```typescript
interface RlmStack {
  readonly middleware: KoiMiddleware;
  readonly thresholds: {
    readonly contextWindowTokens: number;
    readonly maxInputTokens: number;
    readonly maxChunkChars: number;
  };
  readonly tier: RlmStackTier;
  readonly sandboxExecutor: SandboxExecutor | undefined;
}
```

### `policyFor(tokens, thresholds): RlmDisposition`

Pure helper that classifies an estimated token count against the resolved
thresholds and returns one of `"passthrough" | "compact" | "virtualize"`.
Does not invoke the middleware — useful for telemetry, dashboards, and
preview UIs that want to display the disposition before the call lands.

```typescript
import { createRlmStack, policyFor } from "@koi/rlm-stack";

const stack = createRlmStack({ contextWindowTokens: 200_000 });
policyFor(50_000, stack.thresholds);   // "passthrough"
policyFor(120_000, stack.thresholds);  // "compact"
policyFor(250_000, stack.thresholds);  // "virtualize"
```

The stack uses `@koi/context-manager`'s `softTriggerFraction` (50%) and
`hardTriggerFraction` (75%) defaults to determine the `compact`
boundaries. The stack does **not** invoke compaction itself — that
remains the engine adapter's responsibility via `enforceBudget`.

---

## Tiers

| Tier | `maxChunkChars` | Use case |
|------|----------------|----------|
| `light` | `4_000` | Cheap & fast. Many small segments; suits per-line transformation. |
| `standard` | `8_000` | Default. Matches `@koi/middleware-rlm`'s `DEFAULT_MAX_CHUNK_CHARS`. |
| `aggressive` | `16_000` | Fewer, larger segments. Suits long-form summarization where boundaries cost coherence. |

`maxInputTokens` is identical across tiers and tracks the resolved
`contextWindowTokens` — RLM should fire only when input exceeds the entire
window, regardless of tier. Tiers tune *how* the segmentation runs, not
*when* it fires.

---

## Composition with context-manager

`@koi/context-manager` is a utility, not a middleware. The engine adapter
calls `enforceBudget(messages, ...)` before each model turn and drops /
summarizes transcript prefixes when the running total crosses the soft
or hard threshold. This is independent of the middleware chain.

The stack guarantees:

1. RLM's `maxInputTokens` defaults to `contextWindowTokens` — RLM fires
   only at 100% pressure.
2. Compaction's `hardTriggerFraction` (75% default) is **strictly less
   than** RLM's threshold, so compaction always runs first when both
   could help.
3. When a single user turn exceeds the window in isolation (compaction
   cannot help — there is nothing in the transcript to drop), RLM
   segments that turn.

### What can still go wrong

- **Tool-bearing requests over the threshold.** RLM fails closed when
  `request.tools.length > 0`. The stack inherits this guard. Operators
  composing with custom tool-mutating middleware must ensure RLM's
  priority remains greater than every tool injector.
- **Streaming reassembly.** RLM's stream path reassembles all segments
  before re-emitting — partial deltas are not proxied. See
  `middleware-rlm.md`.
- **Observe-phase middleware sees N events per oversized turn.**
  Inherited from `middleware-rlm`. The stack does not change this.

---

## Sandbox

`sandboxExecutor` is accepted for forward compatibility. Today's
`middleware-rlm` is pure segmentation (no code execution). The richer v1
design (QuickJS-WASM script runner that lets the model write JS to
analyze large inputs) was archived to `archive/v1/packages/meta/rlm-stack`
and deferred to a future package built on a real sub-agent abstraction —
see the *Why It Exists* note in `middleware-rlm.md`.

When `sandboxExecutor` is supplied, the stack stores it on the returned
handle (`stack.sandboxExecutor`) so callers can verify it round-trips,
and so a future middleware version can pick it up without changing the
public API. It is not wired into the current middleware.

---

## Layer position

`@koi/rlm-stack` is **L3**. It depends on:

- `@koi/core` (L0)
- `@koi/middleware-rlm` (L2)
- `@koi/context-manager` (L0u)
- `@koi/token-estimator` (L0u)

Listed in `scripts/layers.ts`'s `L3_PACKAGES` set alongside `@koi/runtime`
and `@koi/gateway-stack`.

---

## Caveats — `resolveThresholds` limitations

`@koi/rlm-stack` delegates window resolution entirely to
`@koi/context-manager`'s `resolveThresholds` so the two layers cannot
disagree. That delegation also inherits the resolver's current limits:

- **No prefix canonicalization.** A prefixed id like
  `"anthropic:claude-opus-4-6"` misses the registry and falls back to the
  default window in **both** layers. Pass the bare id, or supply
  `modelWindowOverrides` keyed in the form you actually use elsewhere.
- **Unknown ids ignore `contextWindowSize`.** `resolveThresholds` consults
  `@koi/model-registry`'s `resolveModelWindow`, which returns its own
  default (`128_000`) for unknown ids before `contextWindowSize` would
  otherwise apply. Private / custom deployments must use
  `modelWindowOverrides` rather than relying on `contextWindowTokens`.

Generalizing the resolver (prefix-aware lookup + `undefined`-on-miss so
`contextWindowSize` can take effect) is tracked separately so the change
applies uniformly to every caller of `resolveThresholds`, not just RLM.

## References

- v1 prototype: `archive/v1/packages/meta/rlm-stack/` — wired QuickJS
  sandbox into RLM middleware (deferred for v2).
- Issue [#1359](https://github.com/windoliver/koi/issues/1359)
- Parent umbrella [#1211](https://github.com/windoliver/koi/issues/1211)
