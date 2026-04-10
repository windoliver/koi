import { describe, expect, test } from "bun:test";
import { createCircuitBreaker } from "@koi/errors";
import { createHealthProbe } from "./health-probe.js";
import type { ProviderAdapter } from "./provider-adapter.js";

function makeAdapter(opts: { checkHealth?: () => Promise<boolean> } = {}): ProviderAdapter {
  return {
    id: "test",
    async complete() {
      throw new Error("not implemented");
    },
    stream(): AsyncGenerator<never> {
      throw new Error("not implemented");
    },
    ...(opts.checkHealth !== undefined ? { checkHealth: opts.checkHealth } : {}),
  };
}

describe("createHealthProbe", () => {
  test("returns undefined when no targets have local URLs", () => {
    const cb = createCircuitBreaker();
    const probe = createHealthProbe({
      targets: [
        {
          id: "openai:gpt-4o",
          adapter: makeAdapter({ checkHealth: async () => true }),
          circuitBreaker: cb,
          baseUrl: "https://api.openai.com", // remote — not local
        },
      ],
      intervalMs: 5_000,
    });
    expect(probe).toBeUndefined();
  });

  test("returns undefined when adapter has no checkHealth", () => {
    const cb = createCircuitBreaker();
    const probe = createHealthProbe({
      targets: [
        {
          id: "local:llama",
          adapter: makeAdapter(), // no checkHealth
          circuitBreaker: cb,
          baseUrl: "http://localhost:11434",
        },
      ],
      intervalMs: 5_000,
    });
    expect(probe).toBeUndefined();
  });

  test("runOnce() calls checkHealth and records success when healthy", async () => {
    const cb = createCircuitBreaker();
    let healthCalls = 0;

    const probe = createHealthProbe({
      targets: [
        {
          id: "local:llama",
          adapter: makeAdapter({
            checkHealth: async () => {
              healthCalls++;
              return true;
            },
          }),
          circuitBreaker: cb,
          baseUrl: "http://localhost:11434",
        },
      ],
      intervalMs: 60_000,
      // Use a no-op setInterval to prevent the timer from running automatically
      setInterval: ((_fn: unknown, _ms?: number) => 0 as unknown) as typeof globalThis.setInterval,
    });

    // The initial runOnce() runs on construction (but we need to await it)
    // Let any async operations settle
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(healthCalls).toBeGreaterThanOrEqual(1);
    expect(cb.getSnapshot().state).toBe("CLOSED");
    probe?.dispose();
  });

  test("runOnce() records failure when checkHealth returns false", async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });

    const probe = createHealthProbe({
      targets: [
        {
          id: "local:llama",
          adapter: makeAdapter({ checkHealth: async () => false }),
          circuitBreaker: cb,
          baseUrl: "http://127.0.0.1:11434",
        },
      ],
      intervalMs: 60_000,
      setInterval: ((_fn: unknown, _ms?: number) => 0 as unknown) as typeof globalThis.setInterval,
    });

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(cb.getSnapshot().failureCount).toBeGreaterThanOrEqual(1);
    probe?.dispose();
  });

  test("runOnce() records failure when checkHealth throws", async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });

    const probe = createHealthProbe({
      targets: [
        {
          id: "local:llama",
          adapter: makeAdapter({
            checkHealth: async () => {
              throw new Error("connection refused");
            },
          }),
          circuitBreaker: cb,
          baseUrl: "http://localhost:11434",
        },
      ],
      intervalMs: 60_000,
      setInterval: ((_fn: unknown, _ms?: number) => 0 as unknown) as typeof globalThis.setInterval,
    });

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(cb.getSnapshot().failureCount).toBeGreaterThanOrEqual(1);
    probe?.dispose();
  });

  test("dispose() is idempotent — calling twice does not throw", () => {
    const probe = createHealthProbe({
      targets: [
        {
          id: "local:llama",
          adapter: makeAdapter({ checkHealth: async () => true }),
          circuitBreaker: createCircuitBreaker(),
          baseUrl: "http://localhost:11434",
        },
      ],
      intervalMs: 60_000,
      setInterval: ((_fn: unknown, _ms?: number) => 0 as unknown) as typeof globalThis.setInterval,
    });

    expect(() => {
      probe?.dispose();
      probe?.dispose();
    }).not.toThrow();
  });

  test("injectable setInterval is called with the configured interval", () => {
    const intervals: number[] = [];
    const fakeSetInterval = ((_fn: unknown, ms?: number) => {
      intervals.push(ms ?? 0);
      return 0 as unknown;
    }) as typeof globalThis.setInterval;

    const probe = createHealthProbe({
      targets: [
        {
          id: "local:llama",
          adapter: makeAdapter({ checkHealth: async () => true }),
          circuitBreaker: createCircuitBreaker(),
          baseUrl: "http://localhost:11434",
        },
      ],
      intervalMs: 12_345,
      setInterval: fakeSetInterval,
    });

    expect(intervals).toContain(12_345);
    probe?.dispose();
  });
});
