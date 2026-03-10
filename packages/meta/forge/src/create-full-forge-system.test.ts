/**
 * Unit tests for createFullForgeSystem factory.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result, TurnTrace } from "@koi/core";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { SandboxExecutor } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createFullForgeSystem } from "./create-full-forge-system.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function emptyTraces(): Promise<Result<readonly TurnTrace[], KoiError>> {
  return Promise.resolve({ ok: true, value: [] });
}

function noopResolveBrickId(): string | undefined {
  return undefined;
}

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFullForgeSystem", () => {
  test("returns all 5 components (runtime, provider, pipeline, middlewares, handles)", () => {
    const store = createInMemoryForgeStore();
    const system = createFullForgeSystem({
      store,
      executor: mockExecutor(),
      scope: "agent",
      forgeConfig: createDefaultForgeConfig(),
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
    });

    expect(system.runtime).toBeDefined();
    expect(typeof system.runtime.resolveTool).toBe("function");
    expect(typeof system.runtime.toolDescriptors).toBe("function");

    expect(system.provider).toBeDefined();
    expect(typeof system.provider.attach).toBe("function");

    expect(system.pipeline).toBeDefined();
    expect(typeof system.pipeline.verify).toBe("function");
    expect(typeof system.pipeline.checkGovernance).toBe("function");

    expect(system.middlewares).toHaveLength(7);

    expect(system.handles.demand).toBeDefined();
    expect(system.handles.crystallize).toBeDefined();
    expect(system.handles.exaptation).toBeDefined();
    expect(system.handles.feedbackLoop).toBeDefined();
    expect(typeof system.handles.feedbackLoop.getHealthSnapshot).toBe("function");
  });

  test("middleware stack is ordered by priority", () => {
    const store = createInMemoryForgeStore();
    const system = createFullForgeSystem({
      store,
      executor: mockExecutor(),
      scope: "agent",
      forgeConfig: createDefaultForgeConfig(),
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
    });

    const priorities = system.middlewares.map((m) => m.priority);
    expect(priorities).toEqual([450, 455, 465, 900, 950, 960, 990]);
  });

  test("accepts optional signer", () => {
    const store = createInMemoryForgeStore();
    const system = createFullForgeSystem({
      store,
      executor: mockExecutor(),
      scope: "agent",
      forgeConfig: createDefaultForgeConfig(),
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      signer: {
        algorithm: "hmac-sha256",
        sign: async (_data) => new Uint8Array([1, 2, 3]),
        verify: async (_data, _sig) => true,
      },
    });

    expect(system.runtime).toBeDefined();
  });

  test("accepts optional clock and error handler", () => {
    const store = createInMemoryForgeStore();
    const errors: unknown[] = [];
    const system = createFullForgeSystem({
      store,
      executor: mockExecutor(),
      scope: "agent",
      forgeConfig: createDefaultForgeConfig(),
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      clock: () => 42_000,
      onError: (e) => {
        errors.push(e);
      },
    });

    expect(system.middlewares).toHaveLength(7);
  });
});
