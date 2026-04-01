# @koi/api-client — Anthropic SDK Transport

Wraps `@anthropic-ai/sdk` to provide `ModelHandler` and `ModelStreamHandler` implementations for Koi's middleware pipeline. Supports direct API, AWS Bedrock, and Google Vertex as transport backends via a single factory function.

---

## Why It Exists

Koi's middleware pipeline (`KoiMiddleware.wrapModelCall` / `wrapModelStream`) terminates at a `ModelHandler` / `ModelStreamHandler` — the innermost onion layer that actually talks to the LLM. This package is that innermost layer for Anthropic models.

The v1 adapter used raw `fetch` + manual SSE parsing (~400 lines). Using the official SDK eliminates SSE parsing, retry header handling, and multi-provider auth complexity, while gaining typed responses and native Bedrock/Vertex support.

---

## What This Enables

```
BEFORE: raw fetch adapter (v1)
═══════════════════════════════
  ModelRequest → manual HTTP → SSE parsing → ModelChunk
  • ~400 lines of fetch/SSE/timeout code
  • No Bedrock/Vertex support
  • Manual error mapping

AFTER: SDK-backed adapter (v2)
═══════════════════════════════
  ModelRequest → @anthropic-ai/sdk → ModelChunk
  • SDK handles SSE, timeouts, auth
  • Bedrock + Vertex via SDK constructors
  • Typed streaming events
```

---

## Architecture

**Layer**: L2 (feature package)
**Depends on**: `@koi/core` (L0), `@koi/errors` (L0u), `@anthropic-ai/sdk` (external)
**Implements**: `ModelHandler` and `ModelStreamHandler` function types from `@koi/core`

### Module Map

```
@koi/api-client/src/
├── client.ts        # createAnthropicClient() → { complete, stream }
├── config.ts        # AnthropicClientConfig type + DEFAULT_CLIENT_CONFIG
├── normalize.ts     # InboundMessage[] → Anthropic messages (system extraction, content blocks)
├── map-request.ts   # ModelRequest → SDK MessageCreateParams
├── map-response.ts  # SDK Message → ModelResponse
├── map-stream.ts    # SDK stream events → AsyncIterable<ModelChunk>
├── map-error.ts     # SDK errors → KoiRuntimeError
├── map-tools.ts     # ToolDescriptor[] → Anthropic Tool[]
└── index.ts         # Public exports
```

### Data Flow

```
ModelRequest (from middleware pipeline)
    │
    ▼
  normalize.ts          extract system messages, map content blocks
    │
    ▼
  map-request.ts        assemble SDK MessageCreateParams
    │
    ▼
  @anthropic-ai/sdk     messages.create() or messages.create({ stream: true })
    │
    ├── non-streaming ──▶ map-response.ts ──▶ ModelResponse
    │
    └── streaming ──────▶ map-stream.ts ───▶ AsyncIterable<ModelChunk>
```

---

## Key APIs

### Factory

```typescript
function createAnthropicClient(config?: AnthropicClientConfig): {
  readonly complete: ModelHandler;
  readonly stream: ModelStreamHandler;
}
```

Returns a pair of handlers that can be passed to L1 as the innermost model call layer.

### Configuration

```typescript
type AnthropicProvider = "direct" | "bedrock" | "vertex";

interface AnthropicClientConfig {
  readonly provider?: AnthropicProvider;   // default: "direct"
  readonly apiKey?: string;                // direct only; env ANTHROPIC_API_KEY
  readonly model?: string;                 // default: "claude-sonnet-4-5-20250929"
  readonly fallbackModel?: string;         // one retry with this model on failure
  readonly maxTokens?: number;             // default: 4096
  readonly timeoutMs?: number;             // default: 120_000
  readonly baseUrl?: string;               // override base URL
  readonly awsRegion?: string;             // bedrock
  readonly googleProjectId?: string;       // vertex
  readonly googleRegion?: string;          // vertex
  readonly retryConfig?: RetryConfig;      // from @koi/errors
}
```

### Wiring (via L3 harness)

```typescript
// In @koi/harness (L3) — NOT in this package
const { complete, stream } = createAnthropicClient({ provider: "direct" });
const engine = createQueryEngine({ modelCall: complete, modelStream: stream });
```

---

## Error Handling

SDK errors are mapped to `KoiRuntimeError` from `@koi/errors`:

| SDK Error | KoiErrorCode | Retryable |
|-----------|-------------|-----------|
| 401 Unauthorized | PERMISSION | No |
| 404 Not Found | NOT_FOUND | No |
| 429 Rate Limited | RATE_LIMIT | Yes |
| 529 Overloaded | RATE_LIMIT | Yes |
| 500+ Server Error | EXTERNAL | Yes |
| AbortError | TIMEOUT | No |

Non-streaming calls use `withRetry` from `@koi/errors`. Streaming does not retry at this level — that's a middleware concern.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SDK vs raw fetch | `@anthropic-ai/sdk` | Eliminates ~150 lines of SSE/timeout code; native multi-provider |
| Single factory | `createAnthropicClient({ provider })` | SDK clients share identical `messages.create()` interface |
| No class | Closure-captured SDK client | Matches codebase conventions |
| Retry scope | `complete` only, not `stream` | Stream retry belongs to middleware layer |
| Cache hints | Deferred | Requires `@koi/middleware-prompt-cache` coordination |

---

## Layer Compliance

- [x] Imports only from `@koi/core` (L0) and `@koi/errors` (L0u)
- [x] No L1 (`@koi/engine`) imports
- [x] No peer L2 imports
- [x] All interface properties are `readonly`
- [x] No vendor-specific types in public API (SDK types internal only)
- [x] `ModelHandler` and `ModelStreamHandler` contracts fully implemented
