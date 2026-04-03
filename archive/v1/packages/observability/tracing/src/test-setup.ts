/**
 * Test infrastructure for OTel span collection.
 *
 * Re-exports InMemorySpanExporter + NodeTracerProvider setup for use in
 * E2E scripts that cannot directly depend on OTel SDK packages.
 */

import type { Tracer } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export type { ReadableSpan };

export interface TestTracer {
  readonly tracer: Tracer;
  readonly getFinishedSpans: () => readonly ReadableSpan[];
  readonly shutdown: () => Promise<void>;
}

export function createTestTracer(name: string = "@koi/e2e-tracing"): TestTracer {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer(name);

  return {
    tracer,
    getFinishedSpans: () => exporter.getFinishedSpans(),
    shutdown: () => provider.shutdown(),
  };
}
