# @koi/middleware-rlm — Recursive Language Model Middleware

Segments oversized model requests into model-sized chunks, dispatches each
chunk through the downstream chain, and reassembles the responses in
order. Sits in the middleware chain via `wrapModelCall` and is engine-agnostic.

> **Status: library-only, programmatic activation only.** This package
> ships the `createRlmMiddleware` factory plus pure `segmentRequest` /
> `reassembleResponses` primitives. The runtime does **not** wire RLM
> into any default middleware stack, and the built-in manifest registry
> rejects manifest-driven activation with an explicit error. Operators
> must opt in by instantiating the middleware programmatically and
> adding it to their composition (see *Usage* below). Manifest content
> cannot set the safety-relevant flags
> (`acknowledgeSegmentLocalContract`, `trustMetadataRole`, `priority`),
> so a `koi.yaml` reference would only ever produce a fail-closed
> instance — the registry surfaces this at resolution time rather than
> letting it become a hard runtime error on the first oversized turn.

---

## Why It Exists

LLM context windows are finite. When an agent receives a large user input
(50 MB JSON, a long document) the model cannot reason over it directly. The
RLM middleware solves the simplest, most common variant of this problem:

1. **Detect oversized input** — estimate tokens against a configured threshold
2. **Segment** — split the largest user text block into char-bounded chunks
3. **Dispatch** — call the downstream model once per chunk
4. **Reassemble** — concatenate the chunked responses (sum usage, retain ids)

This package intentionally implements only the segment/reassemble pattern.
Richer designs (REPL loops, code-execution sandboxes, recursive sub-agents)
were prototyped in v1 (see `archive/v1/packages/middleware/middleware-rlm`)
and deferred to a future package built on top of a real sub-agent abstraction
rather than packed into a single middleware.

---

## Architecture

```
Agent
  │
  ▼  ModelRequest
┌──────────────────────────────────┐
│ wrapModelCall (RLM middleware)   │
│  estimator.estimateMessages(req) │
│  if tokens <= threshold:         │  ──→  next(req)
│  else:                           │
│    segments = segmentRequest(req)│
│    for seg of segments:          │
│      responses.push(next(seg))   │
│    return reassemble(responses)  │
└──────────────────────────────────┘
```

L2 feature package — runtime deps on `@koi/core` (L0) and
`@koi/token-estimator` (L0u). No external dependencies.

`wrapModelStream` runs the same segment/dispatch path as `wrapModelCall`
on the streaming side. Each segment is dispatched through the downstream
stream handler; the segment's terminal `done` chunk supplies its
`ModelResponse`, which is folded into reassembly. The merged response is
re-emitted as a single synthesized stream (one `text_delta` of the merged
content, an aggregate `usage` chunk, then `done`). Per-chunk text deltas
from intermediate segments are NOT proxied to the consumer — that would
let tool-call or thinking content from one segment leak before
reassembly's safety guards (non-success stopReason, tool_call blocks)
have a chance to abort the run.

Small streamed requests forward unchanged. The streaming path enforces
the same fail-closed gates as `wrapModelCall` (acknowledgement opt-in,
no tools, segments must fit) so streaming RLM can never silently produce
the corruption modes the call path rejects.

### Token accounting

The threshold check considers the **full** request footprint, not just
`messages`:

- `messages` → `estimator.estimateMessages(...)`
- `systemPrompt` → `estimator.estimateText(...)` when present
- `tools` → `estimator.estimateText(JSON.stringify(tools))` when present

L1 injects the system prompt and tool descriptors before the middleware
chain runs, so omitting them would let small-message requests with large
capability banners or tool schemas slip past the gate.

### Fail-closed cases

The middleware throws (rather than silently forwarding the oversize request)
in three situations where its segmentation strategy cannot uphold its contract:

- **Observe-phase middleware sees N events per oversized turn.** Both
  `wrapModelCall` and `wrapModelStream` dispatch each segment through
  the *full* downstream chain — that is the only `next` handler a
  middleware has access to. So observe-phase middleware (e.g.
  `@koi/session:transcript`, `@koi/middleware-audit`,
  cost/report aggregators) commit / record once per segment, not once
  per logical user turn. Hosts whose persistence layer keys off
  `request.messages.at(-1)` will durably store one oversized user turn
  as N partial turns. `metadata.rlmSegments` on the merged response
  records the per-segment provenance so callers can correlate after
  the fact, but the duplication itself is inherent to the simple
  "segment + reassemble at this layer" design. Operators that need
  single-turn semantics for transcript/audit must run RLM as an
  engine-adapter wrapper (so the rest of the chain runs once on the
  merged request) instead of as a chain middleware.
- **Tools are present.** Each segment would receive the same tool list, the
  model would emit independent tool calls per segment, and reassembly would
  concatenate them — turning one user turn into N side-effecting tool batches.
  Disable RLM for tool-enabled turns or compose with a tool-aware middleware.
  This guard depends on **ordering**: RLM's `intercept`-tier priority MUST
  be greater than every tool-injecting intercept middleware in the chain so
  the tool list is materialized BEFORE RLM evaluates the request. The
  default priority (800) sits above `@koi/middleware-tool-selector` (200);
  custom tool-mutating middleware must respect the same invariant.
- **Single-block chunking cannot reduce the request.** If every user text
  block already fits within `maxChunkChars` but the total token estimate
  still exceeds `maxInputTokens` (overflow lives in surrounding history /
  system prompt), segmentation produces one chunk and the request would
  otherwise pass through. RLM throws so the caller sees the budget breach
  immediately instead of failing later inside the provider. Pair with a
  compaction middleware or raise `maxInputTokens` if this fires often.
- **A produced segment still exceeds the budget.** After splitting the
  largest text block, every segment is re-estimated (`messages` +
  `systemPrompt` + `tools`). When surrounding history dominates the
  request, individual segments can still exceed `maxInputTokens`. RLM
  rejects before paying for any downstream calls.

---

## Usage

```typescript
import { createRlmMiddleware } from "@koi/middleware-rlm";

const rlm = createRlmMiddleware({
  maxInputTokens: 32_000,
  maxChunkChars: 8_000,
});

const middleware = [rlm, modelRouter, retry];
```

### Manifest

```yaml
middleware:
  - name: rlm
    options:
      maxInputTokens: 32000
      maxChunkChars: 8000
```

---

## Configuration

### `RlmConfig`

| Field | Default | Description |
|-------|---------|-------------|
| `maxInputTokens` | 32 000 | Threshold (in estimated tokens). Requests at or below pass through unchanged. |
| `maxChunkChars` | 8 000 | Maximum characters per segment of the split text block. |
| `estimator` | `HEURISTIC_ESTIMATOR` | Token estimator used for the threshold check. |
| `priority` | 800 | Priority within the `intercept` phase tier. **Must be greater than every tool-mutating intercept middleware** (e.g. `@koi/middleware-tool-selector` at 200) so RLM runs deeper in the onion and its `request.tools` guard sees the materialized tool list before segmentation. |
| `onEvent` | — | Optional callback receiving `RlmEvent` (`passthrough`, `segmented`, `segment-completed`). Errors thrown by the callback are swallowed. |
| `trustMetadataRole` | `false` | When `true`, RLM honors `metadata.role` on inbound messages as a trusted role override (mirrors `model-openai-compat`'s explicit trust gate). Default is `false` because `InboundMessage.metadata` is otherwise caller-controlled — an external caller could stamp `role: "assistant"` on an oversized user turn to bypass RLM's size guard. Only opt in when the upstream path is fully trusted (e.g. L1 session-repair replaying resumed assistant content). |
| `acknowledgeSegmentLocalContract` | `false` | **Required opt-in, programmatic-only.** Setting this to `true` acknowledges that the caller's task is the in-order union of segment-local answers (extraction, transformation, summarization-per-chunk). When `false`, oversized requests fail closed rather than silently returning a synthesized concatenation that may corrupt global-aggregation tasks. **The manifest factory rejects this flag** — a committed `koi.yaml` cannot know whether each runtime request is actually segment-local, and forcing concatenation globally would silently ship wrong answers for cross-segment tasks. Hosts that need RLM's segmentation behavior must register it programmatically via a custom `MiddlewareRegistry` and gate the contract per known-safe turn. |
| `segmentSeparator` | `""` | String inserted between per-segment outputs during reassembly. Empty by default for byte-faithful concatenation (exact-copy and JSON/CSV/code transforms stay intact). Set to `"\n\n"` (or other) for summarization-style outputs. |

Validate ahead of construction with `validateRlmConfig(config)` —
returns a `Result<RlmConfig, KoiError>`.

---

## Segmentation

`segmentRequest(request, maxChunkChars)`:

1. Find every user-role text block whose length exceeds `maxChunkChars`.
   "User-role" combines both canonical resolvers conservatively: messages
   with `senderId === "system" | "system:*" | "assistant" | "tool"`, or
   `metadata.role === "assistant" | "tool"` are excluded. Anything else
   is user content. Bare `senderId === "system"` is reserved (the
   openai-compat resolver treats it as user, but the shared
   `mapSenderIdToRole` normalizer treats it as system; the trust-boundary
   stance is to never chunk it). Oversized bare-system content is a
   compaction concern, not RLM's.
2. If none, return `[request]` unchanged.
3. If exactly one, call `splitText(text, maxChunkChars)` (prefers
   paragraph boundaries, then line boundaries, finally hard-cuts) and
   emit one `ModelRequest` per chunk with the **raw chunk text** replacing
   the original block — no synthetic `Segment k/N:` prefix, so exact-copy
   and structured-transformation prompts remain byte-safe. Hard-cuts
   respect UTF-16 surrogate pairs: the splitter steps back one code unit
   when a cut would land between a high and low surrogate, so emoji and
   astral-plane characters are never split into invalid UTF-16.
4. If more than one, throw `MultipleOversizedBlocksError`. A true
   multi-block partition would require a reducer stage that is out of
   scope here, and a cross-product fan-out would duplicate work and
   corrupt reassembly. Combine the blocks upstream, raise `maxChunkChars`,
   or compose with a compaction middleware.

All other messages, the system prompt, and the tools list are carried
verbatim. `splitText(text, maxChars)` is exported for unit testing and reuse.

## Reassembly

`reassembleResponses(parts)` builds a synthetic `ModelResponse` from
per-segment outputs. **It concatenates — it does not synthesize.** RLM is
therefore only sound for tasks whose answer is the in-order union of
segment-local answers (extraction, transformation, summarization-per-chunk).
Tasks that need global aggregation, dedup, ranking, or cross-segment
reasoning must run an explicit reducer downstream by feeding the
reassembled output back into another model call.

The synthetic response:

- `content` → `parts.map(p => p.content).join(segmentSeparator)` (default `""`)
- `model`, `responseId` taken from the first part for backward compatibility
- `stopReason` → the strongest non-success reason across parts (`length`,
  `tool_use`, `error`, `hook_blocked`); falls back to the last part's reason
  when every segment finished with `stop`
- `usage` summed across parts (cache fields aggregated when present)
- `richContent` rebuilt as the full ordered representation when any
  segment carries it: per-segment richContent blocks are interleaved
  with the `segmentSeparator` (when non-empty), and segments without
  richContent contribute a synthesized text block from their `content`.
  When a segment carries richContent that has **no text block** but its
  `content` is non-empty (e.g. an adapter returned a thinking-only or
  tool-call-only richContent alongside the actual text answer in
  `content`), reassembly prepends a synthesized text block from
  `content` so the engine's synthesized `modelStream` path — which
  replays richContent verbatim and ignores `content` when richContent
  is set — does not silently drop the segment's text. When no segment
  has richContent, the field is omitted entirely so the stream path
  falls back to `content`.
- `metadata` is a **last-write-wins merge** across every segment's
  `metadata`, with `rlmSegments` appended for full provenance. This
  preserves later-segment signals like `terminatedBy`, `blockedByHook`,
  and recovery metadata that downstream delivery / observability paths
  rely on; first-only metadata would silently drop them.
- `metadata.rlmSegments` → `[{ index, model, stopReason, responseId }, …]`
  for every segment, so callers can audit per-segment routing or safety
  metadata that the merged top-level fields would otherwise hide

In addition, the middleware aborts mid-dispatch (rather than pushing an
incomplete answer back to the caller) when any segment returns a
non-success `stopReason` — concatenating a truncated or tool-use segment
into a "complete" result would mask the failure.

Throws if `parts` is empty.

---

## Events

`RlmEvent` is a discriminated union emitted via `onEvent`:

| `kind` | Payload | Meaning |
|--------|---------|---------|
| `passthrough` | `{ tokens }` | Request fit within `maxInputTokens`; `next` called once. |
| `segmented` | `{ tokens, segmentCount }` | Request exceeded the threshold; about to dispatch N chunks. |
| `segment-completed` | `{ index, count }` | Chunk `index` returned successfully (one per chunk). |

Telemetry callback failures are swallowed — observers cannot influence
middleware behavior.
