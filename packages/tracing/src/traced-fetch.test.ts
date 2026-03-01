import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { Context, TextMapPropagator, TextMapSetter } from "@opentelemetry/api";
import { propagation } from "@opentelemetry/api";
import { createTracedFetch } from "./traced-fetch.js";

// ---------------------------------------------------------------------------
// Mock propagator that injects a fixed traceparent header
// ---------------------------------------------------------------------------

const MOCK_TRACEPARENT = "00-abcd1234abcd1234abcd1234abcd1234-abcd1234abcd1234-01";

const mockPropagator: TextMapPropagator = {
  inject(_context: Context, carrier: unknown, setter: TextMapSetter): void {
    setter.set(carrier, "traceparent", MOCK_TRACEPARENT);
  },
  extract(context: Context): Context {
    return context;
  },
  fields(): string[] {
    return ["traceparent"];
  },
};

/** Creates a spy fetch that captures headers from the init argument. */
function createSpyFetch(): {
  readonly spy: ReturnType<typeof mock>;
  readonly getHeaders: () => Record<string, string> | undefined;
} {
  // let: captured in closure, read by getHeaders
  let capturedHeaders: Record<string, string> | undefined;
  const spy = mock((_input: Request | string | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return Promise.resolve(new Response("ok"));
  });
  return { spy, getHeaders: () => capturedHeaders };
}

describe("createTracedFetch", () => {
  afterEach(() => {
    // OTel API is "set once" — disable() is the only way to reset
    propagation.disable();
  });

  afterAll(() => {
    propagation.disable();
  });

  test("injects traceparent header when propagator is registered", async () => {
    propagation.setGlobalPropagator(mockPropagator);

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    await tracedFetch("https://example.com/api", { method: "POST" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(getHeaders()?.traceparent).toBe(MOCK_TRACEPARENT);
  });

  test("preserves existing headers (plain object)", async () => {
    propagation.setGlobalPropagator(mockPropagator);

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    await tracedFetch("https://example.com/api", {
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    });

    expect(getHeaders()?.["Content-Type"]).toBe("application/json");
    expect(getHeaders()?.Authorization).toBe("Bearer tok");
    expect(getHeaders()?.traceparent).toBe(MOCK_TRACEPARENT);
  });

  test("preserves existing headers (Headers instance)", async () => {
    propagation.setGlobalPropagator(mockPropagator);

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    const headers = new Headers({ "X-Custom": "value" });
    await tracedFetch("https://example.com/api", { headers });

    expect(getHeaders()?.["x-custom"]).toBe("value");
    expect(getHeaders()?.traceparent).toBe(MOCK_TRACEPARENT);
  });

  test("preserves existing headers (array of tuples)", async () => {
    propagation.setGlobalPropagator(mockPropagator);

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    await tracedFetch("https://example.com/api", {
      headers: [
        ["X-Foo", "bar"],
        ["X-Baz", "qux"],
      ],
    });

    expect(getHeaders()?.["X-Foo"]).toBe("bar");
    expect(getHeaders()?.["X-Baz"]).toBe("qux");
    expect(getHeaders()?.traceparent).toBe(MOCK_TRACEPARENT);
  });

  test("does not inject headers when no propagator is active", async () => {
    // afterEach disabled the propagator, so no propagator is active here

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    await tracedFetch("https://example.com/api", {
      headers: { "Content-Type": "application/json" },
    });

    expect(getHeaders()?.["Content-Type"]).toBe("application/json");
    // No traceparent should be injected with noop/disabled propagator
    expect(getHeaders()?.traceparent).toBeUndefined();
  });

  test("works with no init argument", async () => {
    propagation.setGlobalPropagator(mockPropagator);

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    await tracedFetch("https://example.com/api");

    expect(getHeaders()?.traceparent).toBe(MOCK_TRACEPARENT);
  });

  test("works with undefined headers in init", async () => {
    propagation.setGlobalPropagator(mockPropagator);

    const { spy, getHeaders } = createSpyFetch();
    const tracedFetch = createTracedFetch(spy);
    await tracedFetch("https://example.com/api", { method: "GET", headers: undefined });

    expect(getHeaders()?.traceparent).toBe(MOCK_TRACEPARENT);
  });

  test("defaults to globalThis.fetch when no baseFetch provided", () => {
    const tracedFetch = createTracedFetch();
    expect(typeof tracedFetch).toBe("function");
  });
});
