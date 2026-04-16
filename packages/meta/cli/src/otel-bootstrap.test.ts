/**
 * Tests for otel-bootstrap — the shared CLI OTel SDK initializer.
 *
 * Uses InMemorySpanExporter to capture spans without I/O.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

// Will fail until otel-bootstrap.ts is created
import { initOtelSdk } from "./otel-bootstrap.js";

describe("initOtelSdk", () => {
  afterEach(() => {
    // Reset global provider between tests
    trace.disable();
  });

  test("registers a global TracerProvider", async () => {
    const handle = initOtelSdk("headless");
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-span");
    // A real provider returns spans with valid trace IDs (not all zeros)
    expect(span.spanContext().traceId).not.toBe("00000000000000000000000000000000");
    span.end();
    await handle.shutdown();
  });

  test("shutdown flushes and disables provider", async () => {
    const handle = initOtelSdk("headless");
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("flush-test");
    span.end();
    await handle.shutdown();

    // After shutdown, new spans should be no-ops (all-zero trace ID)
    const noopSpan = trace.getTracer("test").startSpan("after-shutdown");
    expect(noopSpan.spanContext().traceId).toBe("00000000000000000000000000000000");
    noopSpan.end();
  });

  test("headless mode does not throw", () => {
    expect(() => initOtelSdk("headless")).not.toThrow();
  });

  test("tui mode does not throw", () => {
    expect(() => initOtelSdk("tui")).not.toThrow();
  });

  test("calling initOtelSdk twice is safe (second call is no-op)", async () => {
    const handle1 = initOtelSdk("headless");
    const handle2 = initOtelSdk("headless");
    // Both return shutdown handles — neither throws
    await handle1.shutdown();
    await handle2.shutdown();
  });
});
