# @koi/middleware-rlm — Recursive Language Model Middleware

Segments oversized model requests into model-sized chunks, dispatches each
chunk through the downstream chain, and reassembles the responses in
order. Sits in the middleware chain via `wrapModelCall` and is engine-agnostic.

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

`wrapModelStream` is implemented as a fail-closed gate, not a segmenter.
Stream reassembly across multiple downstream streams is out of scope, but
silently letting oversized streamed requests bypass RLM would be a
contract break (engines with native `modelStream` skip call-only
middleware on the streaming path). Small streamed requests forward
unchanged; oversized ones throw — route them through the non-streaming
path or compose with a compaction middleware.

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

- **Tools are present.** Each segment would receive the same tool list, the
  model would emit independent tool calls per segment, and reassembly would
  concatenate them — turning one user turn into N side-effecting tool batches.
  Disable RLM for tool-enabled turns or compose with a tool-aware middleware.
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
| `priority` | 200 | Middleware priority. Sits before model-router/retry so per-segment fallback works. |
| `onEvent` | — | Optional callback receiving `RlmEvent` (`passthrough`, `segmented`, `segment-completed`). Errors thrown by the callback are swallowed. |

Validate ahead of construction with `validateRlmConfig(config)` —
returns a `Result<RlmConfig, KoiError>`.

---

## Segmentation

`segmentRequest(request, maxChunkChars)`:

1. Locate the largest user text block whose length exceeds `maxChunkChars`.
2. If every user text block already fits, return `[request]` unchanged.
3. Otherwise call `splitText(text, maxChunkChars)` which prefers paragraph
   boundaries (`\n\n`), then line boundaries, and finally hard-cuts.
4. Re-emit one `ModelRequest` per chunk with the **raw chunk text** replacing
   the original block — no synthetic `Segment k/N:` prefix, so exact-copy
   and structured-transformation prompts remain byte-safe.
5. **Recurse** on each produced segment so a request with multiple
   oversized user text blocks fans out across the cross product of their
   chunks instead of failing closed at re-validation.

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

- `content` → `parts.map(p => p.content).join("\n\n")`
- `model`, `responseId` taken from the first part for backward compatibility
- `stopReason` → the strongest non-success reason across parts (`length`,
  `tool_use`, `error`, `hook_blocked`); falls back to the last part's reason
  when every segment finished with `stop`
- `usage` summed across parts (cache fields aggregated when present)
- `richContent` concatenated when any part carries it
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
