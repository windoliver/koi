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

`wrapModelStream` is intentionally not implemented: streaming requests are
forwarded unchanged because reassembling chunked deltas across multiple
downstream streams is materially more complex than the current scope.
Callers that need RLM behavior should use the non-streaming path.

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

1. Locate the largest text block across all user messages.
2. If absent or already within `maxChunkChars`, return `[request]`.
3. Otherwise call `splitText(text, maxChunkChars)` which prefers paragraph
   boundaries (`\n\n`), then line boundaries, and finally hard-cuts.
4. Re-emit one `ModelRequest` per chunk with that block's text replaced by
   `Segment k/N:\n${chunk}` and all other messages, system prompt, and tools
   carried verbatim.

`splitText(text, maxChars)` is exported for unit testing and reuse.

## Reassembly

`reassembleResponses(parts)`:

- `content` → `parts.map(p => p.content).join("\n\n")`
- `model`, `responseId`, `metadata` from the first part
- `stopReason` from the last part
- `usage` summed across parts (cache fields aggregated when present)
- `richContent` concatenated when any part carries it

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
