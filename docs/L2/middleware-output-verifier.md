# @koi/middleware-output-verifier — Two-Stage Output Quality Gate

Intercepts every model response before delivery and runs it through two sequential stages: fast deterministic checks (regex, length, policy), then an optional LLM-as-judge for semantic quality scoring. Supports three actions per check — block, warn, revise — with per-session stats and a mutable rubric for runtime control.

---

## Why It Exists

LLMs produce outputs that can fail in two fundamentally different ways:

1. **Structural failures** — too long, empty, contains a banned pattern, missing a required field, raw `<script>` injection. These are detectable in microseconds with a predicate.
2. **Semantic failures** — factually wrong, off-topic, low quality, violates a subtle policy. These require judgment that only another LLM can reliably provide.

Handling both in one place prevents every agent from reimplementing the same guard logic. The Spotify pattern targets a **25% baseline veto rate** — caught by this middleware, not silently delivered to users.

Without this package:
- Guards scattered across agent logic, hard to audit
- No consistent veto event surface for monitoring
- No path to inject revision feedback and retry without boilerplate
- Streaming responses go un-checked entirely

---

## Architecture

`@koi/middleware-output-verifier` is an **L2 feature package** — it depends only on `@koi/core` (L0) and `@koi/errors` (L0u). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────┐
│  @koi/middleware-output-verifier  (L2)                    │
│                                                          │
│  types.ts           ← 8 types + discriminated unions     │
│  builtin-checks.ts  ← nonEmpty, maxLength, matchesPattern│
│                       validJson, BUILTIN_CHECKS registry  │
│  judge.ts           ← prompt builder + response parser   │
│  output-verifier.ts ← middleware factory + revision loop │
│  index.ts           ← public API surface                 │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Dependencies                                            │
│                                                          │
│  @koi/core   (L0)   KoiMiddleware, ModelRequest,         │
│                      ModelResponse, TurnContext,          │
│                      InboundMessage, CapabilityFragment   │
│  @koi/errors (L0u)  KoiRuntimeError                      │
└──────────────────────────────────────────────────────────┘
```

Priority **385** — runs after guardrails (375), before memory (400).

---

## How It Works

### Two-Stage Pipeline

```
  model response
       │
       ▼
┌──────────────────────────────────────────┐
│  Stage 1: Deterministic  (μs, zero cost) │
│  Run ALL checks — first block short-     │
│  circuits Stage 2                        │
│                                          │
│  [ nonEmpty ] [ maxLength ] [ noXSS ] …  │
└──────────────────┬───────────────────────┘
                   │
        ┌──────────┴─────────────┐
      BLOCK                  all pass / warn
        │                        │
      throw                ┌─────▼──────────────────────┐
    (skip S2)              │  Stage 2: LLM judge  (ms,$) │
                           │  score 0.0 ──────────► 1.0  │
                           │  threshold (default: 0.75)   │
                           └──────┬───────────────────────┘
                                  │
              ┌───────────────────┼───────────────┐
            pass                warn          block/revise
              │                   │                │
          deliver             deliver +        see below
                              onVeto()
```

### Three Actions

| Action | Non-streaming | Streaming |
|--------|--------------|-----------|
| **block** | Throws `KoiRuntimeError(VALIDATION)`. Output never delivered. | Degrades to **warn** (content already yielded). |
| **warn** | Output delivered. `onVeto` fires with event. | Same. |
| **revise** | Feedback injected into `messages[]`, model retried (up to `maxRevisions`). | Degrades to **warn**. |

> **Note:** `revise` calls `next()` multiple times within one `wrapModelCall` invocation. This is designed for direct-invocation contexts and custom integration code, not the standard `composeModelChain` path (which guards against multiple `next()` calls on the success path by contract).

### Middleware Position (Onion)

```
         Incoming Model Call
                │
                ▼
  ┌─────────────────────────┐
  │  middleware-guardrails   │  priority: 375 (outermost)
  ├─────────────────────────┤
  │  middleware-output-      │  priority: 385
  │  verifier (THIS)        │◄─ two-stage gate
  ├─────────────────────────┤
  │  engine adapter          │
  │  → LLM API call         │
  └─────────────────────────┘
```

---

## Stage 1: Deterministic Checks

Each check is a named predicate with an action. All checks run sequentially. The first `block` throws immediately (short-circuiting Stage 2). `warn` and `revise` continue to the next check.

```typescript
interface DeterministicCheck {
  readonly name: string;
  readonly check: (content: string) => boolean | string; // true = pass, string = fail reason
  readonly action: "block" | "warn" | "revise";
}
```

### Built-in Checks

| Function | Description |
|----------|-------------|
| `BUILTIN_CHECKS.nonEmpty(action)` | Fails if trimmed content is empty |
| `BUILTIN_CHECKS.maxLength(n, action)` | Fails if content exceeds `n` characters |
| `BUILTIN_CHECKS.validJson(action)` | Fails if content is not valid JSON |
| `BUILTIN_CHECKS.matchesPattern(re, action, name?)` | Fails if content does not match regex |
| `matchesPattern(re, action, name?)` | Standalone export — same as above |
| `nonEmpty(action)` | Standalone export |
| `maxLength(n, action)` | Standalone export |
| `validJson(action)` | Standalone export |

### Revision Loop (Deterministic)

```
  1st call → check fails (action: revise)
      │
      ▼
  inject feedback message into request.messages:
    "Check 'name' failed: reason. Please revise."
      │
      ▼
  retry → check passes → proceed to Stage 2
      │
  (if still fails after maxRevisions)
      ▼
  throw KoiRuntimeError(VALIDATION)
```

---

## Stage 2: LLM-as-Judge

The judge receives the full assembled content and the configured rubric, asks a fast model to score 0.0–1.0, and parses the JSON response.

### Judge Prompt Format

```
You are a quality judge evaluating an AI assistant's response.

RUBRIC:
{rubric}

RESPONSE TO EVALUATE:
{content}

Respond ONLY with valid JSON:
{"score": 0.85, "reasoning": "..."}

Score 1.0 = perfect quality. Score 0.0 = completely unacceptable.
```

### Score Parsing

```typescript
export function parseJudgeResponse(response: string): JudgeResult {
  // Non-greedy regex to extract first JSON object
  // isRecord() guard replaces banned `as` assertion
  // Fail-closed: parse error → score 0 → veto fires
}
```

Fail-closed means: if the judge LLM returns an unparseable response, score defaults to `0.0` and the configured action fires. This prevents a broken judge from silently passing bad content.

### Sampling Rate

```typescript
judge: {
  samplingRate: 0.1,  // Run judge on only 10% of calls — saves cost in production
}
```

Deterministic checks always run regardless of sampling rate.

---

## Streaming

In streaming mode (`wrapModelStream`), the middleware accumulates chunks into a buffer, then validates the complete content after the `done` chunk:

```
  chunk 1 → buffer
  chunk 2 → buffer       (all yielded to caller immediately)
  chunk N → buffer
  done chunk
      │
      ▼
  validate buffer
  (block/revise degrade to warn — content already yielded)
      │
      ▼
  yield done chunk
```

Buffer overflow (> `maxBufferSize`, default 256 KB) fires a `warn` event and skips validation. Prevents memory spikes on very long streams.

---

## Stats and Observability

Every middleware instance tracks per-session stats:

```typescript
interface VerifierStats {
  readonly totalChecks: number;       // Total wrapModelCall invocations
  readonly vetoed: number;            // Calls where block or revise fired
  readonly warned: number;            // Calls where warn fired
  readonly deterministicVetoes: number;
  readonly judgeVetoes: number;
  readonly judgedChecks: number;      // Calls where judge actually ran (per samplingRate)
  readonly vetoRate: number;          // vetoed / totalChecks (0 when totalChecks = 0)
}
```

`vetoRate` targeting 25% is the Spotify quality baseline. Higher means your rubric is too strict or content quality is genuinely low. Lower means the gate is too permissive.

### Veto Events

`onVeto` fires for every block, warn, and revise — both stages:

```typescript
interface VerifierVetoEvent {
  readonly source: "deterministic" | "judge";
  readonly action: "block" | "warn" | "revise";
  readonly checkName?: string;   // deterministic only
  readonly checkReason?: string; // deterministic only
  readonly score?: number;       // judge only
  readonly reasoning?: string;   // judge only
  readonly judgeError?: string;  // set when judge threw or returned unparseable response
  readonly degraded?: boolean;   // set when streaming downgraded block/revise → warn
}
```

Wire `onVeto` to your metrics system:

```typescript
createOutputVerifierMiddleware({
  onVeto(event) {
    metrics.increment("agent.output_veto", {
      source: event.source,
      action: event.action,
    });
    if (event.source === "judge") {
      metrics.histogram("agent.judge_score", event.score ?? 0);
    }
  },
});
```

---

## API Reference

### Factory Function

#### `createOutputVerifierMiddleware(config)`

Creates the middleware and returns a `VerifierHandle`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.deterministic` | `readonly DeterministicCheck[]` | — | Stage 1 checks. At least one of `deterministic` or `judge` required. |
| `config.judge` | `JudgeConfig` | — | Stage 2 judge configuration. |
| `config.onVeto` | `(event: VerifierVetoEvent) => void` | — | Called on every veto or warn. |
| `config.maxBufferSize` | `number` | `262144` | Max stream buffer (bytes) before validation is skipped. |

**Throws** `KoiRuntimeError(VALIDATION)` at factory time if neither `deterministic` nor `judge` is configured.

**Returns** `VerifierHandle`:

```typescript
interface VerifierHandle {
  readonly middleware: KoiMiddleware;
  readonly getStats: () => VerifierStats;
  readonly setRubric: (rubric: string) => void;  // hot-swap rubric without restart
  readonly reset: () => void;                    // zero all stats counters
}
```

### `JudgeConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rubric` | `string` | — | Quality criteria the judge uses to score. |
| `modelCall` | `(prompt: string, signal?: AbortSignal) => Promise<string>` | — | Raw model invocation — receives the assembled judge prompt, returns raw text. |
| `vetoThreshold` | `number` | `0.75` | Minimum score to pass. Below this → action fires. |
| `action` | `"block" \| "warn" \| "revise"` | `"block"` | What to do when score < threshold. |
| `samplingRate` | `number` | `1.0` | Fraction of calls on which judge runs (0.0–1.0). |
| `maxRevisions` | `number` | `1` | Max revision attempts before throwing. |
| `revisionFeedbackMaxLength` | `number` | `400` | Max characters of judge reasoning injected during revise. |

### `DeterministicCheck`

```typescript
interface DeterministicCheck {
  readonly name: string;
  readonly check: (content: string) => boolean | string;
  readonly action: "block" | "warn" | "revise";
}
```

Return `true` to pass. Return `false` or a string (failure reason) to fail.

### Types Reference

| Type | Description |
|------|-------------|
| `VerifierAction` | `"block" \| "warn" \| "revise"` |
| `VerifierConfig` | Config for `createOutputVerifierMiddleware()` |
| `VerifierHandle` | Return type — middleware + runtime control |
| `VerifierStats` | Accumulated per-session counters |
| `VerifierVetoEvent` | Event payload fired via `onVeto` |
| `JudgeConfig` | Stage 2 judge configuration |
| `DeterministicCheck` | Stage 1 predicate + action |
| `JudgeResult` | `{ score, reasoning, parseError? }` — from `parseJudgeResponse()` |

---

## Examples

### Deterministic Only

```typescript
import { BUILTIN_CHECKS, createOutputVerifierMiddleware } from "@koi/middleware-output-verifier";

const { middleware, getStats } = createOutputVerifierMiddleware({
  deterministic: [
    BUILTIN_CHECKS.nonEmpty("block"),
    BUILTIN_CHECKS.maxLength(8_000, "warn"),
    BUILTIN_CHECKS.validJson("block"),
  ],
  onVeto(event) {
    console.warn("[verifier]", event.source, event.action, event.checkReason);
  },
});

const agent = await createKoi({ manifest, middleware: [middleware] });
```

### Deterministic + LLM Judge

```typescript
import {
  BUILTIN_CHECKS,
  createOutputVerifierMiddleware,
} from "@koi/middleware-output-verifier";

const { middleware, getStats, setRubric } = createOutputVerifierMiddleware({
  deterministic: [
    BUILTIN_CHECKS.nonEmpty("block"),
    BUILTIN_CHECKS.maxLength(10_000, "warn"),
  ],
  judge: {
    rubric: [
      "Score 0.0–1.0.",
      "0.8+ if the response directly and correctly answers the user's question.",
      "Below 0.5 if the response is empty, off-topic, or factually wrong.",
    ].join("\n"),
    modelCall: async (prompt, signal) => {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      const json = await resp.json() as { content: { text: string }[] };
      return json.content[0]?.text ?? "";
    },
    vetoThreshold: 0.6,
    action: "warn",      // deliver but fire event
    samplingRate: 0.2,   // judge 20% of calls in production
  },
  onVeto(event) {
    if (event.source === "judge") {
      console.warn(`[judge] score=${event.score?.toFixed(2)} — ${event.reasoning?.slice(0, 100)}`);
    }
  },
});
```

### Custom Policy Check

```typescript
import { createOutputVerifierMiddleware } from "@koi/middleware-output-verifier";
import type { DeterministicCheck } from "@koi/middleware-output-verifier";

const noSecrets: DeterministicCheck = {
  name: "no-api-keys",
  check: (content) => {
    if (/sk-[a-zA-Z0-9]{20,}/.test(content)) {
      return "Response contains what looks like an API key";
    }
    return true;
  },
  action: "block",
};

const { middleware } = createOutputVerifierMiddleware({
  deterministic: [noSecrets],
});
```

### Dynamic Rubric (e.g. per-user config)

```typescript
const { middleware, setRubric } = createOutputVerifierMiddleware({
  judge: {
    rubric: "Default: be concise and factual.",
    modelCall: myJudge,
  },
});

// Later — when user updates their quality preferences:
setRubric("Formal tone required. No bullet points. Cite sources.");
// Takes effect on next wrapModelCall/wrapModelStream invocation.
```

### Per-Session Stats Reset

```typescript
const { middleware, getStats, reset } = createOutputVerifierMiddleware({ ... });

// On session end:
const sessionStats = getStats();
console.log(`Session veto rate: ${(sessionStats.vetoRate * 100).toFixed(1)}%`);
reset(); // zero counters for next session
```

---

## Flow Diagrams

### Revise Loop

```
  wrapModelCall(ctx, request, next)
      │
      │  revision = 0
      │  ┌─────────────────────────────────────────────┐
      │  │  call next(currentRequest)                  │
      │  │  → response.content                         │
      │  │                                             │
      │  │  Stage 1: all checks                        │
      │  │    check → fail (action: revise)            │
      │  │    revision < maxRevisions? yes             │
      │  │    revision++                               │
      │  │    currentRequest += feedbackMessage        │
      │  │    onVeto(revise)                           │
      │  │  ← continue (restart loop)                  │
      │  │                                             │
      │  │  Stage 1: all checks pass                   │
      │  │                                             │
      │  │  Stage 2: judge                             │
      │  │    score >= threshold → pass                │
      │  │  ← return response                         │
      │  └─────────────────────────────────────────────┘
```

### Stats Overcounting Prevention

Stats are incremented with per-call boolean flags flushed in `finally` — prevents a multi-revision loop from counting the same logical call multiple times:

```
try {
  while (true) {
    // set callVetoed / callWarned flags — not stats directly
  }
} finally {
  if (callVetoed) stats.vetoed++;
  if (callWarned) stats.warned++;
}
```

---

## Comparison: Koi vs. OpenClaw vs. NanoClaw

| Feature | Koi (`middleware-output-verifier`) | OpenClaw (Lobster) | NanoClaw |
|---------|------------------------------------|--------------------|----------|
| Deterministic checks | Yes — composable, named, per-check action | Yes — approval gates (block/warn) | None |
| LLM-as-judge | Yes — pluggable, rubric-driven, score-based | No | No |
| Actions | block, warn, revise | block, warn | — |
| Streaming support | Yes (block/revise degrade to warn) | No | No |
| Per-session stats | Yes — vetoRate, judgedChecks, etc. | No | No |
| Hot-swap rubric | Yes — `setRubric()` | No | No |
| Sampling rate | Yes — reduce judge cost in production | No | No |
| onVeto event surface | Yes — structured, typed | No | No |
| Revision loop | Yes — injects feedback, retries model | No | No |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ModelResponse,            │
    TurnContext, InboundMessage, CapabilityFragment        │
                                                           │
L0u @koi/errors ──────────────────────────────────────────┤
    KoiRuntimeError                                        │
                                                           ▼
L2  @koi/middleware-output-verifier ◄──────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

Dev-only dependency: `@koi/test-utils` (used in tests only, not in runtime).
