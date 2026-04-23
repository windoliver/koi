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
import { defaultResource, type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

/** Standard OTLP HTTP traces endpoint — the OTel SDK default. */
const DEFAULT_OTLP_TRACES_URL = "http://localhost:4318/v1/traces";

/**
 * Build an OTel Resource from env vars and Koi-specific defaults.
 *
 * Priority (highest wins): OTEL_SERVICE_NAME > OTEL_RESOURCE_ATTRIBUTES key
 * override > Koi defaults > OTel SDK defaults (telemetry.sdk.*).
 *
 * Exported for unit testing — not part of the public CLI API.
 */
export function buildResource(mode: "tui" | "headless"): Resource {
  // Start with Koi defaults — env vars overwrite these below.
  const attrs: Record<string, string> = {
    "service.name": "koi",
    "koi.mode": mode,
    "process.runtime.name": "bun",
    "process.runtime.version": Bun.version,
  };

  // Only emit service.version when KOI_VERSION is explicitly set by the build.
  // Defaulting to a fake "dev" string collapses all unversioned builds into one
  // bucket and makes rollout/rollback triage by version misleading.
  const koiVersion = process.env.KOI_VERSION;
  if (koiVersion !== undefined && koiVersion.length > 0) {
    attrs["service.version"] = koiVersion;
  }

  // OTEL_RESOURCE_ATTRIBUTES — comma-separated key=value pairs, values may be
  // percent-encoded per OTel spec. Overwrites any matching default above.
  //
  // Fail-closed: any malformed pair or decode error discards the entire env var.
  // Partial application (some pairs applied, some skipped) creates split service
  // identity that is harder to detect than a clean "no overrides" baseline.
  const rawAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (rawAttrs !== undefined && rawAttrs.length > 0) {
    const parsed = parseOtelResourceAttributes(rawAttrs);
    if (parsed === undefined) {
      process.stderr.write(
        "[koi] OTel: OTEL_RESOURCE_ATTRIBUTES is malformed — ignoring entire value to avoid partial resource identity.\n",
      );
    } else {
      for (const [k, v] of Object.entries(parsed)) {
        attrs[k] = v;
      }
    }
  }

  // OTEL_SERVICE_NAME takes highest priority for service.name.
  const serviceName = process.env.OTEL_SERVICE_NAME;
  if (serviceName !== undefined && serviceName.length > 0) {
    attrs["service.name"] = serviceName;
  }

  // Guard service.name — empty override from variable substitution would make
  // spans ungroupable in any collector. Fall back to the Koi default.
  if (attrs["service.name"] !== undefined && attrs["service.name"].length === 0) {
    process.stderr.write(
      '[koi] OTel: "service.name" was set to an empty string — ignoring override, keeping default "koi".\n',
    );
    attrs["service.name"] = "koi";
  }

  return defaultResource().merge(resourceFromAttributes(attrs));
}

/**
 * Parse OTEL_RESOURCE_ATTRIBUTES into a key→value map.
 *
 * Follows OTel spec: comma-separated key=value pairs, values split on the
 * first "=" only (so "foo=a=b" → key "foo", value "a=b"), empty values
 * are accepted (spec-compliant), empty segments from trailing/double commas
 * are skipped.
 *
 * Returns `undefined` if any pair has a missing/empty key, missing "=", or
 * a percent-decode failure — fail-closed so operators see a clean warning
 * rather than partially-wrong resource metadata.
 *
 * Exported for unit testing — not part of the public CLI API.
 */
export function parseOtelResourceAttributes(raw: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue; // empty segment from trailing/double comma — skip
    const eq = trimmed.indexOf("=");
    if (eq < 0) return undefined; // no "=" at all → malformed
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0) return undefined; // empty key → malformed
    const rawValue = trimmed.slice(eq + 1);
    try {
      result[key] = decodeURIComponent(rawValue); // empty value is allowed per spec
    } catch {
      return undefined; // percent-decode failure → malformed
    }
  }
  return result;
}

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
    resource: buildResource(mode),
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

  // Explicit "otlp" — use configured endpoint or default to localhost.
  if (envExporter === "otlp") {
    const url = otlpUrl ?? DEFAULT_OTLP_TRACES_URL;
    return new OTLPTraceExporter({ url });
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
  const url = otlpUrl ?? DEFAULT_OTLP_TRACES_URL;
  if (otlpUrl === undefined) {
    process.stderr.write(
      `[koi] OTel: using default OTLP endpoint ${DEFAULT_OTLP_TRACES_URL}\n` +
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
  export(spans: readonly ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
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
    resultCallback({ code: 0 }); // 0 = ExportResultCode.SUCCESS
  }

  async shutdown(): Promise<void> {
    // No resources to release.
  }

  async forceFlush(): Promise<void> {
    // Writes are synchronous — nothing to flush.
  }
}
