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
 *   - Mode-aware exporter — TUI defaults to OTLP (stdout writes corrupt
 *     renderer), headless defaults to StderrSpanExporter (JSON to stderr)
 */

import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ExportResult,
  type ReadableSpan,
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
 * @param mode - `"tui"` uses OTLP exporter (defaults to localhost:4318).
 *   `"headless"` uses StderrSpanExporter (JSON to stderr, not stdout).
 *   Override with `OTEL_TRACES_EXPORTER=console|otlp|none`.
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
    // Provider already registered (e.g. user brought their own).
    // Attempt forceFlush on shutdown so buffered spans are exported before
    // process exit. Don't call shutdown() — we didn't create this provider.
    return {
      shutdown: async () => {
        try {
          const provider = trace.getTracerProvider();
          if ("forceFlush" in provider && typeof provider.forceFlush === "function") {
            await Promise.race([
              (provider as { forceFlush: () => Promise<void> }).forceFlush(),
              new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
            ]);
          }
        } catch {
          // Best-effort — don't destabilize shutdown.
        }
      },
    };
  }

  const exporter = createExporter(mode);

  // No exporter = export disabled for this session. Middleware still wires
  // (spans are created but discarded by the no-op tracer), so switching to
  // a real provider at runtime or in a future session is zero-config.
  if (exporter === undefined) {
    return { shutdown: async () => {} };
  }

  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  trace.setGlobalTracerProvider(provider);

  return {
    shutdown: async () => {
      // Best-effort: OTel export must never block or crash host shutdown.
      // Bound flush to 5s — if the exporter is slow or the collector is
      // absent, we give up and exit cleanly.
      try {
        await Promise.race([
          provider.shutdown(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch {
        // Swallow — telemetry export failure must not destabilize shutdown.
      }
      trace.disable();
    },
  };
}

/**
 * Select span exporter based on OTEL_TRACES_EXPORTER env var and mode.
 *
 * Honors the standard OTel env var first, then applies mode defaults:
 *   - "console" → StderrSpanExporter (JSON to stderr, not stdout)
 *   - "otlp"    → OTLPTraceExporter (requires OTEL_EXPORTER_OTLP_*ENDPOINT)
 *   - "none"    → no export (returns undefined)
 *   - unset     → mode default: headless=stderr, tui=otlp (localhost:4318)
 *
 * Returns undefined when export should be disabled (no exporter to wire).
 */
function createExporter(mode: "tui" | "headless"): SpanExporter | undefined {
  const envExporter = process.env.OTEL_TRACES_EXPORTER;
  // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is signal-specific (full URL with path).
  // OTEL_EXPORTER_OTLP_ENDPOINT is the generic base URL — needs /v1/traces appended.
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const genericEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otlpUrl =
    tracesEndpoint ??
    (genericEndpoint !== undefined
      ? `${genericEndpoint.replace(/\/+$/, "")}/v1/traces`
      : undefined);

  // Explicit "none" — user wants OTel middleware wired but no export.
  if (envExporter === "none") {
    return undefined;
  }

  // Explicit "console" — writes spans as JSON to stderr (not stdout).
  // User knows what they're doing — may need to redirect stderr in TUI mode.
  if (envExporter === "console") {
    return new StderrSpanExporter();
  }

  // Explicit "otlp" — require an endpoint.
  if (envExporter === "otlp") {
    if (otlpUrl === undefined) {
      process.stderr.write(
        "[koi] OTel: OTEL_TRACES_EXPORTER=otlp but no OTLP endpoint configured.\n" +
          "  Set OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318\n" +
          "  OTel export disabled for this session.\n",
      );
      return undefined;
    }
    return new OTLPTraceExporter({ url: otlpUrl });
  }

  // Unsupported explicit value — warn and disable.
  if (envExporter !== undefined) {
    process.stderr.write(
      `[koi] OTel: unsupported OTEL_TRACES_EXPORTER="${envExporter}". ` +
        'Supported: "console", "otlp", "none". OTel export disabled.\n',
    );
    return undefined;
  }

  // --- No explicit exporter — apply mode defaults ---

  // Headless mode — stderr is safe (no renderer to corrupt).
  if (mode === "headless") {
    return new StderrSpanExporter();
  }

  // TUI mode — use OTLP. Default to localhost:4318 (the standard OTel
  // collector endpoint). Shutdown is bounded to 5s, so a missing collector
  // won't stall exit — it just means spans are lost (acceptable for local dev).
  const url = otlpUrl ?? "http://localhost:4318/v1/traces";
  if (otlpUrl === undefined) {
    process.stderr.write(
      "[koi] OTel: using default OTLP endpoint http://localhost:4318/v1/traces\n" +
        "  If no collector is running, spans will be silently lost.\n" +
        "  Set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_TRACES_EXPORTER=console\n",
    );
  }
  return new OTLPTraceExporter({ url });
}

// ---------------------------------------------------------------------------
// StderrSpanExporter — like ConsoleSpanExporter but writes to stderr
// ---------------------------------------------------------------------------

/**
 * Span exporter that serialises spans as JSON to stderr.
 *
 * The upstream `ConsoleSpanExporter` uses `console.dir()` which writes
 * to **stdout**, corrupting CLI output and TUI rendering. This exporter
 * uses `process.stderr.write()` so span dumps stay on the diagnostic
 * stream where redirection (`2>/tmp/spans.log`) captures them cleanly.
 */
class StderrSpanExporter implements SpanExporter {
  export(spans: readonly ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      const obj = {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        name: span.name,
        kind: span.kind,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration,
        attributes: span.attributes,
        status: span.status,
        events: span.events,
      };
      process.stderr.write(`${JSON.stringify(obj)}\n`);
    }
    resultCallback({ code: 0 });
  }

  async shutdown(): Promise<void> {
    // No resources to release.
  }

  async forceFlush(): Promise<void> {
    // Writes are synchronous — nothing to flush.
  }
}
