# @koi/middleware-otel

> L2 middleware that emits OpenTelemetry GenAI semantic convention spans for every
> model call, tool invocation, and agent session — routes to any OTLP-compatible backend.

## Why it exists

Production agent deployments need their traces in the same observability stack as the
rest of their infrastructure. Without OTel export, Koi observability is local-only and
incompatible with Grafana, Datadog, Honeycomb, and every other backend that speaks OTLP.

This package is a zero-configuration drop-in: add it to your middleware chain, point
`OTEL_EXPORTER_OTLP_ENDPOINT` at your collector, and Koi traces appear in your existing
dashboards alongside your service traces.

## Layer position

```
L0  @koi/core
    ├── RichTrajectoryStep           (step data model — received via onStep callback)
    ├── KoiMiddleware                (session lifecycle hooks)
    └── SessionContext               (sessionId for span tagging)

External  @opentelemetry/api        (peer dep — library-only, no SDK bundled)

L2  @koi/middleware-otel  ◄── THIS PACKAGE
    ├── semconv.ts          OTel GenAI attribute name constants (pinned to spec v1.29.0)
    ├── span-attrs.ts       Pure functions: RichTrajectoryStep → OTel Attributes
    └── middleware-otel.ts  OtelHandle factory (KoiMiddleware + onStep callback)

Wired to:
    @koi/event-trace (EventTraceConfig.onStep — zero coupling, callback-only)
```

**Dependencies**: `@koi/core` (L0) + `@opentelemetry/api` (peer dep, stable 1.x API).
No OTel SDK bundled — callers provide their own `TracerProvider`.

## Architecture decisions

### 1. Library-only: `@opentelemetry/api` peer dep, no SDK bundled

The OTel ecosystem has one hard rule: **instrumentation libraries depend only on
`@opentelemetry/api`**, not the SDK. The SDK is the application's responsibility.
Bundling it would conflict with any user who has OTel already initialized, causing
double registration, duplicate spans, and confusing provider conflicts.

`@opentelemetry/api` is stable (1.x, no breaking changes since 1.0). If no
`TracerProvider` is registered, all span operations are no-ops — the middleware is
completely transparent.

### 2. Integration via `EventTraceConfig.onStep` callback

Event-trace already does the work of capturing step timing, token counts, outcomes, and
metadata. The OTel middleware subscribes to that output rather than duplicating all of
event-trace's step-building logic (DRY: one path for step construction).

The callback fires synchronously before the fire-and-forget store write. All OTel span
operations (`startSpan`, `setAttribute`, `end`) are synchronous by spec, so the callback
adds zero async overhead to the request path.

### 3. Content in span Events, not Attributes

The OTel GenAI spec is explicit: prompt text and completion text are sensitive and
often large. They belong in span **events** (`gen_ai.user.message`, `gen_ai.choice`),
not attributes. Events can be filtered at the Collector level; attributes are always
exported.

Content capture is opt-in via `captureContent: true`. Default is `false` — safe for
production where prompts may contain PII, and where span attribute size limits apply.

### 4. Span hierarchy

```
invoke_agent {agentName}          [INTERNAL] — root session span, lifetime = session
  ├── chat {model}                [CLIENT]   — one per model call
  │     (events: gen_ai.user.message, gen_ai.choice when captureContent: true)
  └── chat {model}                [CLIENT]   — next turn
        └── execute_tool {tool}  [INTERNAL]  — tool spans parented to last model span
```

### 5. Cost as OTel Metric, not span attribute

`koi.gen_ai.cost` is emitted as a histogram instrument (if a `Meter` is provided),
not as a span attribute. Cost is an aggregate measure — backends can sum/average/P99
it without custom aggregation pipelines. Span attributes are for identity and context,
not numeric metrics.

### 6. Cross-agent span propagation (deferred to v2)

When a parent agent spawns a child agent, W3C `traceparent` context is not currently
propagated across the spawn boundary. Child agent sessions produce independent traces
(not linked to the parent). This is a known limitation tracked for v2.

**Workaround**: Set `OTEL_EXPORTER_OTLP_ENDPOINT` and correlate sessions via
`koi.session.id` attribute in your backend.

## Semantic convention version

Attribute names are pinned to **OTel GenAI semconv v1.29.0** (Development status as of
April 2026). All `gen_ai.*` attribute names live in `semconv.ts` — a spec update is a
one-file diff. The `SEMCONV_GEN_AI_VERSION` constant records the pinned version.

When the spec reaches Stable status, remove the "Development" note in `semconv.ts` and
drop this warning.

## API surface

```typescript
// Factory
function createOtelMiddleware(config?: OtelMiddlewareConfig): OtelHandle;

// Config
interface OtelMiddlewareConfig {
  tracerName?: string;       // Default: "@koi/middleware-otel"
  captureContent?: boolean;  // Default: false — opt-in for prompt/response events
  meter?: Meter;             // If provided, emits koi.gen_ai.cost histogram
  onSpanError?: (error: unknown) => void; // Observer-never-throws safety valve
}

// Handle
interface OtelHandle {
  onStep: (sessionId: string, step: RichTrajectoryStep) => void; // → EventTraceConfig.onStep
  middleware: KoiMiddleware;  // → middleware chain (session span lifecycle)
}
```

## Usage

### Step 1 — Install OTel SDK (your application, not Koi)

```bash
bun add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
```

### Step 2 — Initialize OTel SDK before Koi starts

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

// ALWAYS use BatchSpanProcessor in production.
// SimpleSpanProcessor blocks the request path on every span.end().
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
});
sdk.start();
```

### Step 3 — Wire into Koi

```typescript
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createOtelMiddleware } from "@koi/middleware-otel";

const otel = createOtelMiddleware({
  captureContent: false, // default — safe for production
});

const eventTrace = createEventTraceMiddleware({
  store,
  docId: sessionId,
  agentName: "my-agent",
  onStep: otel.onStep, // subscribe OTel to event-trace steps
});

// Both middlewares go in the chain
const middlewares = [eventTrace.middleware, otel.middleware, ...others];
```

### Step 4 — Optional: enable content capture for debugging

```typescript
const otel = createOtelMiddleware({ captureContent: true });
// Spans now include gen_ai.user.message and gen_ai.choice events
// WARNING: prompts may contain PII — filter at the Collector if needed
```

### Step 5 — Optional: cost metric

```typescript
import { metrics } from "@opentelemetry/api";

const otel = createOtelMiddleware({
  meter: metrics.getMeter("my-app"),
});
// koi.gen_ai.cost histogram emitted per model call when costUsd is known
```

## Backend examples (generic OTLP — no vendor lock-in)

All backends that support OTLP work identically. Set the endpoint:

```bash
# Grafana Tempo / Grafana Cloud
OTEL_EXPORTER_OTLP_ENDPOINT=https://tempo.example.com

# Any OTLP-compatible collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317

# Sampling (standard OTel env vars)
OTEL_TRACES_SAMPLER=traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

Span attribute `koi.session.id` lets you filter to a single Koi session in any backend.

## Performance notes

- **Span operations are synchronous** — `startSpan`/`setAttribute`/`end` add ~1-5µs per
  call. On a 100-tool-call turn: ~500µs total CPU. Negligible vs. model latency.
- **Export is asynchronous** — `BatchSpanProcessor` queues spans and exports in
  background batches. Tune `maxQueueSize` (default: 2048) and
  `scheduledDelayMillis` (default: 5000ms) for your volume.
- **If the OTLP endpoint is unreachable**, spans queue up to `maxQueueSize` then are
  dropped silently. The agent continues normally — the middleware never throws.

> **Biome formatting pass (#1636):** No behavioral changes — auto-formatted by biome check --write.
