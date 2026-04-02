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

## Dependencies

Zero external dependencies. Uses `fetch()` (Bun global) and inline SSE parsing.
