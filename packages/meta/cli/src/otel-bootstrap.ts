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
 *   - "console" → ConsoleSpanExporter (any mode)
 *   - "otlp"    → OTLPTraceExporter (requires OTEL_EXPORTER_OTLP_*ENDPOINT)
 *   - "none"    → no export (returns undefined)
 *   - unset     → mode default: headless=console, tui=otlp (if endpoint set) else none
 *
 * Returns undefined when export should be disabled (no exporter to wire).
 */
function createExporter(mode: "tui" | "headless"): SpanExporter | undefined {
  const envExporter = process.env.OTEL_TRACES_EXPORTER;
  const otlpUrl =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // Explicit "none" — user wants OTel middleware wired but no export.
  if (envExporter === "none") {
    return undefined;
  }

  // Explicit "console" — user knows what they're doing (may corrupt TUI).
  if (envExporter === "console") {
    return new ConsoleSpanExporter();
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

  // Headless mode — console is safe (no renderer to corrupt).
  if (mode === "headless") {
    return new ConsoleSpanExporter();
  }

  // TUI mode — use OTLP only when endpoint is explicitly configured.
  // Console output would corrupt the TUI renderer, and defaulting to
  // localhost:4318 when no collector is running causes silent failures.
  // Fail closed: no endpoint = no export.
  if (otlpUrl !== undefined) {
    return new OTLPTraceExporter({ url: otlpUrl });
  }

  process.stderr.write(
    "[koi] OTel: TUI mode requires an OTLP endpoint for span export.\n" +
      "  Console export would corrupt the renderer. Options:\n" +
      "  - Set OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318\n" +
      "  - Set OTEL_TRACES_EXPORTER=console and redirect stderr: 2>/tmp/spans.log\n" +
      "  OTel export disabled for this session.\n",
  );
  return undefined;
}
