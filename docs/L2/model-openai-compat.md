# @koi/model-openai-compat

> Thin OpenAI-compatible model adapter for OpenAI-compatible and any Chat Completions API.

## Layer

L2 — imports from `@koi/core` only.

## Purpose

Implements the `ModelAdapter` contract from `@koi/core` for providers using the
OpenAI Chat Completions API shape. Works with OpenAI-compatible, direct OpenAI, Groq,
xAI, and any compatible endpoint.

## Public Surface

```typescript
createOpenAI-compatibleAdapter(config: OpenAI-compatibleAdapterConfig): ModelAdapter
```

### Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | — | API key for the provider |
| `baseUrl` | `string` | `https://openai-compat.ai/api/v1` | Provider API base URL |
| `model` | `string` | — | Model identifier (e.g., `anthropic/claude-sonnet-4`) |
| `capabilities` | `Partial<ModelCapabilities>` | auto-detected | Override capability flags |
| `headers` | `Record<string, string>` | — | Additional HTTP headers |
| `provider` | `string` | `openai-compat` | Provider name for telemetry |

## Streaming

`AsyncIterable<ModelChunk>` via `async function*`. Natural backpressure from
generator suspension — no push queue.

## Error Mapping

HTTP status codes mapped to `KoiError` via `BackendErrorMapper`:

| HTTP | KoiErrorCode | Retryable |
|------|-------------|-----------|
| 401/403 | `PERMISSION` | No |
| 429 | `RATE_LIMIT` | Yes |
| 408/504 | `TIMEOUT` | Yes |
| 5xx | `EXTERNAL` | No (override per-case) |

`Retry-After` header parsed into `KoiError.retryAfterMs`.

## Streaming tool call name handling

`stream-parser.ts` uses a **deferred emission** strategy: `tool_call_start` is not emitted
until the function name arrives. Some providers send the name in the first `tool_calls`
delta; others send it in a later delta. If a tool call closes (`finish_reason: tool_calls`)
before any name arrives, the parser emits a deferred `tool_call_start` with `toolName: ""`
followed by a `VALIDATION` error, ensuring `consumeModelStream` always has an accumulator
entry for that call ID (prevents the `"unknown"` fallback in downstream consumers).

## Prompt cache stability (#1554)

### Deterministic tool ordering

`mapToolDescriptors()` sorts tools alphabetically by name before mapping to
OpenAI format. This ensures the tools section of the request body is identical
across turns regardless of component attach order or forge changes, preserving
the provider's KV cache prefix.

### Prompt prefix fingerprint

Each model response includes `promptPrefixFingerprint` in `ModelResponse.metadata`.
This is a SHA-256 hash of the system prompt + sorted tool payload (name, description,
schema) — the static portion of the provider-visible prefix. It detects unexpected
prefix drift from tool reordering, banner changes, or schema mutations. It does NOT
include conversation messages (which change every turn by definition).

## Dependencies

`@koi/core` (L0), `@koi/hash` (L0u). Uses `fetch()` (Bun global) and inline SSE parsing.

> **Maintenance note (PR #1506):** Replaced `!` non-null assertions in `request-mapper.ts` with proper null checks in bounds-checked loops, following the project `noNonNullAssertion` rule. No functional changes.
