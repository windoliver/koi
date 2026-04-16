/**
 * Shared OTel SDK bootstrap for CLI hosts (koi tui, koi start).
 *
 * Initialises a BasicTracerProvider with BatchSpanProcessor and a
 * mode-aware exporter, then registers it globally so @koi/middleware-otel's
 * `trace.getTracer()` calls return a real tracer instead of a no-op.
 *
 * Design decisions (see #1770 design spec):
 *   - BatchSpanProcessor (not Simple) — onStep is synchronous/CPU-only,
 *     synchronous export would violate the middleware hot-path contract
 *   - CLI owns SDK init, not middleware-otel — keeps the library SDK-free
 *   - Mode-aware exporter — TUI defaults to OTLP (console corrupts renderer),
 *     headless defaults to ConsoleSpanExporter (safe for stderr)
 */

import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

/** Return value from initOtelSdk — call shutdown() for graceful flush. */
export interface OtelSdkHandle {
  /** Flush pending spans and shut down the provider. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Initialise the OTel SDK and register a global TracerProvider.
 *
 * @param mode - `"tui"` uses OTLP exporter by default (console corrupts the
 *   TUI renderer). `"headless"` uses ConsoleSpanExporter to stderr.
 *   Override with `OTEL_TRACES_EXPORTER=console` to force console export
 *   (useful when stderr is redirected: `koi tui 2>/tmp/spans.log`).
 *
 * Safe to call multiple times — subsequent calls after the first return a
 * no-op handle (the global provider is already registered).
 */
export function initOtelSdk(mode: "tui" | "headless"): OtelSdkHandle {
  // Guard: if a real provider is already registered, skip.
  // trace.getTracerProvider() returns a ProxyTracerProvider wrapping the
  // real one; checking for a registered provider is done via the noop check.
  const testSpan = trace.getTracer("__otel_bootstrap_probe__").startSpan("probe");
  const isNoop = testSpan.spanContext().traceId === "00000000000000000000000000000000";
  testSpan.end();

  if (!isNoop) {
    // Provider already registered (e.g. user brought their own) — no-op.
    return { shutdown: async () => {} };
  }

  const exporter = createExporter(mode);

  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(provider);

  return {
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

/**
 * Select span exporter based on mode and env vars.
 *
 * Priority:
 *   1. OTEL_TRACES_EXPORTER=console → ConsoleSpanExporter (any mode)
 *   2. headless → ConsoleSpanExporter (stderr is safe)
 *   3. tui → OTLPTraceExporter (console corrupts renderer)
 */
function createExporter(mode: "tui" | "headless"): SpanExporter {
  const envExporter = process.env.OTEL_TRACES_EXPORTER;

  // Explicit console override — user knows what they're doing
  if (envExporter === "console") {
    return new ConsoleSpanExporter();
  }

  // Headless mode — console is always safe
  if (mode === "headless") {
    return new ConsoleSpanExporter();
  }

  // TUI mode — use OTLP exporter (direct dependency, static import at top).
  // Console output would corrupt the TUI renderer; OTLP sends spans to a
  // collector over HTTP without touching stdout/stderr.
  const url =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "http://localhost:4318/v1/traces";
  return new OTLPTraceExporter({ url });
}
