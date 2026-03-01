# @koi/tracing — OpenTelemetry Distributed Tracing Middleware

Koi middleware that emits OpenTelemetry spans for the full agent lifecycle: sessions, turns, model calls, tool calls, and streaming. Includes `createTracedFetch()` for propagating trace context across HTTP boundaries.

---

## Why It Exists

Koi agents make outbound HTTP calls to model APIs, Nexus services, registries, and external tools. Without distributed tracing, each process is a black box — you can see spans inside a single agent but can't follow a request end-to-end through the system.

This package solves three problems:

1. **In-process spans** — session, turn, model call, tool call hierarchy via `KoiMiddleware` hooks
2. **Distributed context propagation** — `createTracedFetch()` injects W3C `traceparent`/`tracestate` headers into every outbound `fetch()` call
3. **Zero-cost noop** — when no `TracerProvider` or propagator is registered, the OTel API returns noop implementations. No allocation, no overhead.

---

## Architecture

`@koi/tracing` is an **L2 feature package** — it depends on `@koi/core` (L0) and `@opentelemetry/api`. No other `@koi/*` dependencies.

```
┌─────────────────────────────────────────────────────┐
│  @koi/tracing  (L2)                                  │
│                                                       │
│  tracing.ts        ← createTracingMiddleware()        │
│  traced-fetch.ts   ← createTracedFetch()              │
│  config.ts         ← TracingConfig + validation       │
│  span-context.ts   ← span store for session/turn      │
│  semantic-conventions.ts ← OTel attribute keys        │
│  index.ts          ← public API surface                │
│                                                       │
├─────────────────────────────────────────────────────┤
│  Dependencies                                         │
│                                                       │
│  @koi/core           (L0)  KoiMiddleware contract     │
│  @opentelemetry/api  (ext) Tracer, Span, propagation  │
└─────────────────────────────────────────────────────┘
```

---

## How It Works

### Span Hierarchy

The tracing middleware creates a span tree that mirrors the agent's execution model:

```
koi.session (root)
  └── koi.turn [0]
  │     ├── gen_ai.chat (model call)
  │     └── koi.tool_call (tool execution)
  └── koi.turn [1]
        ├── gen_ai.stream (model stream)
        └── koi.tool_call
```

Each span carries semantic attributes following OTel GenAI conventions:

| Attribute | Span | Value |
|-----------|------|-------|
| `koi.session.id` | session, turn | Session ID |
| `koi.agent.id` | session, turn | Agent ID |
| `koi.turn.index` | turn | Turn number |
| `gen_ai.operation.name` | model | `"chat"` |
| `gen_ai.request.model` | model | Model name |
| `gen_ai.usage.input_tokens` | model | Token count |
| `koi.tool.id` | tool | Tool identifier |

### Context Propagation

The middleware uses `context.with()` to set the active span context before calling `next()` in each wrap hook. This means any code running inside a model call or tool call handler can access the current span via `context.active()`.

```
┌─────────────────┐     ┌──────────────────┐     ┌────────────────┐
│ Tracing          │     │ Tool Handler      │     │ External API    │
│ Middleware       │     │                   │     │                 │
│                  │     │                   │     │                 │
│ wrapToolCall()   │     │ next(request)     │     │                 │
│   span = start() │────▶│   runs inside     │     │                 │
│   context.with() │     │   span context    │     │                 │
│                  │     │                   │     │                 │
│                  │     │ tracedFetch(url)   │────▶│ traceparent: …  │
│                  │     │   inject headers   │     │ tracestate: …   │
│                  │     │                   │     │                 │
│   span.end()     │◀────│   return response  │◀────│ response        │
└─────────────────┘     └──────────────────┘     └────────────────┘
```

### `createTracedFetch()`

Wraps any `fetch` function to inject W3C Trace Context headers:

```typescript
import { createTracedFetch } from "@koi/tracing";

const tracedFetch = createTracedFetch();
// or wrap a custom fetch:
const tracedFetch = createTracedFetch(myCustomFetch);

// Every call now includes traceparent + tracestate headers
await tracedFetch("https://api.example.com/v1/messages", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
// → headers sent: { "Content-Type": "…", "traceparent": "00-…-…-01" }
```

The function:
- Copies all existing headers into a plain object carrier
- Calls `propagation.inject(context.active(), carrier)` to add trace headers
- Passes the merged headers to the base fetch
- Handles all three header input types: plain object, `Headers` instance, array of tuples

### Injectable Fetch Pattern

Packages that make outbound HTTP calls accept an optional `fetch` parameter in their config. This enables distributed tracing by passing `createTracedFetch()`:

```typescript
import { createTracedFetch } from "@koi/tracing";
import { createNexusClient } from "@koi/ipc-nexus";
import { createAnthropicAdapter } from "@koi/model-router";

const tracedFetch = createTracedFetch();

// Nexus IPC calls include traceparent
const nexus = createNexusClient({
  baseUrl: "http://localhost:4000",
  fetch: tracedFetch,
});

// Model API calls include traceparent
const anthropic = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetch: tracedFetch,
});
```

Packages that support injectable fetch:

| Package | Config property | Default |
|---------|----------------|---------|
| `@koi/ipc-nexus` | `NexusClientConfig.fetch` | `globalThis.fetch` |
| `@koi/model-router` | `ProviderAdapterConfig.fetch` | `globalThis.fetch` |
| `@koi/channel-canvas-fallback` | `GatewayClientConfig.fetch` | `globalThis.fetch` |
| `@koi/nexus-client` | `NexusClientConfig.fetch` | `globalThis.fetch` |
| `@koi/registry-http` | `client.fetch` | `globalThis.fetch` |
| `@koi/search-brave` | `config.fetchFn` | `globalThis.fetch` |

---

## API Reference

### Factory Functions

#### `createTracingMiddleware(config?)`

Creates a `KoiMiddleware` that emits OTel spans.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.tracer` | `Tracer` | auto from `trace.getTracer()` | OTel tracer instance |
| `config.serviceName` | `string` | `"@koi/agent"` | Service name for auto-tracer |
| `config.attributes` | `Record<string, string>` | `{}` | Extra attributes on all spans |
| `config.captureContent` | `boolean` | `false` | Log request/response content |
| `config.contentFilter` | `(data: unknown) => unknown` | identity | Filter sensitive content |
| `config.onError` | `(error: unknown) => void` | swallow | Error handler for tracing failures |

**Returns:** `KoiMiddleware` with priority 450.

#### `createTracedFetch(baseFetch?)`

Creates a fetch wrapper that injects trace context headers.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baseFetch` | `FetchFn` | `globalThis.fetch` | Base fetch function to wrap |

**Returns:** `FetchFn` — `(input, init?) => Promise<Response>`

#### `validateTracingConfig(config)`

Validates a raw config object against the `TracingConfig` schema.

**Returns:** `Result<TracingConfig, KoiError>`

---

## Examples

### Basic Setup

```typescript
import { createTracingMiddleware, createTracedFetch } from "@koi/tracing";

// 1. Create the middleware (spans for session/turn/model/tool)
const tracing = createTracingMiddleware({
  serviceName: "my-agent",
  captureContent: false,
});

// 2. Create traced fetch (propagates traceparent to outbound HTTP)
const tracedFetch = createTracedFetch();

// 3. Pass tracedFetch to packages that make HTTP calls
const modelAdapter = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetch: tracedFetch,
});
```

### With a Real TracerProvider

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(new OTLPTraceExporter({ url: "http://jaeger:4318/v1/traces" }))
);
provider.register(); // enables context manager + W3C propagator

const tracing = createTracingMiddleware({
  tracer: provider.getTracer("my-agent"),
});
```

### Content Capture with Filtering

```typescript
const tracing = createTracingMiddleware({
  captureContent: true,
  contentFilter: (data) => {
    // Redact sensitive fields before logging to spans
    if (typeof data === "object" && data !== null && "apiKey" in data) {
      return { ...data, apiKey: "[REDACTED]" };
    }
    return data;
  },
});
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────┐
    KoiMiddleware, ModelRequest, ToolRequest      │
                                                   │
                                                   ▼
L2  @koi/tracing ◄────────────────────────────────┘
    imports from L0 only (+ @opentelemetry/api)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ traced-fetch.ts has zero @koi imports
```

## Performance Characteristics

| Scenario | Cost |
|----------|------|
| No `TracerProvider` registered | Zero — noop spans, noop propagator |
| `TracerProvider` registered, no propagator | Spans emitted, no headers injected |
| Full setup (provider + propagator) | Spans + W3C traceparent on every `fetch()` |
| `createTracedFetch` without active span | `propagation.inject()` is a no-op — no headers added |
