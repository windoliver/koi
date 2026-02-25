/**
 * Integration tests for the KernelExtension pipeline.
 *
 * These tests verify the full extension lifecycle through createKoi(),
 * including guard composition, assembly validation, lifecycle validation,
 * and backward compatibility with sugar config fields.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineOutput,
  KernelExtension,
  KoiMiddleware,
  ValidationResult,
} from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Extension Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

function mockAdapter(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "mock-adapter",
    stream: () => {
      // let justified: mutable index for iterator position
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              const event = events[index];
              if (event === undefined) {
                return { done: true, value: undefined };
              }
              index++;
              return { done: false, value: event };
            },
          };
        },
      };
    },
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// 1. Default guards via extension
// ---------------------------------------------------------------------------

describe("default guards via extension", () => {
  test("createKoi with no extensions still creates guards", async () => {
    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({ manifest: testManifest(), adapter });
    const events = await collectEvents(runtime.run({ kind: "messages", messages: [] }));

    // Should complete normally (guards active but not triggered)
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
    expect(runtime.agent.state).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// 2. Custom extension with guard
// ---------------------------------------------------------------------------

describe("custom extension with guard", () => {
  test("extension adds extra middleware", async () => {
    const callLog: string[] = [];

    const customExtension: KernelExtension = {
      name: "test:custom-guard",
      priority: EXTENSION_PRIORITY.USER,
      guards: () => {
        const mw: KoiMiddleware = {
          name: "test:logger",
          priority: 999,
          onBeforeTurn: async () => {
            callLog.push("custom-before-turn");
          },
        };
        return [mw];
      },
    };

    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      extensions: [customExtension],
    });

    await collectEvents(runtime.run({ kind: "messages", messages: [] }));

    expect(callLog).toContain("custom-before-turn");
  });
});

// ---------------------------------------------------------------------------
// 3. Extension priority ordering
// ---------------------------------------------------------------------------

describe("extension priority ordering", () => {
  test("lower priority extension guard runs outer", async () => {
    const order: string[] = [];

    const lowPriority: KernelExtension = {
      name: "test:low",
      priority: EXTENSION_PRIORITY.PLATFORM,
      guards: () => [
        {
          name: "low-mw",
          priority: 5,
          onBeforeTurn: async () => {
            order.push("low");
          },
        },
      ],
    };

    const highPriority: KernelExtension = {
      name: "test:high",
      priority: EXTENSION_PRIORITY.ADDON,
      guards: () => [
        {
          name: "high-mw",
          priority: 6,
          onBeforeTurn: async () => {
            order.push("high");
          },
        },
      ],
    };

    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      extensions: [highPriority, lowPriority],
    });

    await collectEvents(runtime.run({ kind: "messages", messages: [] }));

    // Both should have been called (onBeforeTurn runs for all middleware)
    expect(order).toContain("low");
    expect(order).toContain("high");
    // Low priority middleware (priority 5) runs before high (priority 6)
    expect(order.indexOf("low")).toBeLessThan(order.indexOf("high"));
  });
});

// ---------------------------------------------------------------------------
// 4. Assembly validator blocks creation
// ---------------------------------------------------------------------------

describe("assembly validator blocks creation", () => {
  test("validator returns error → createKoi throws", async () => {
    const blockingExtension: KernelExtension = {
      name: "test:blocker",
      validateAssembly: (): ValidationResult => ({
        ok: false,
        diagnostics: [
          { source: "test:blocker", message: "Missing required tool", severity: "error" },
        ],
      }),
    };

    const adapter = mockAdapter([]);

    try {
      await createKoi({
        manifest: testManifest(),
        adapter,
        extensions: [blockingExtension],
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("Assembly validation failed");
        expect(e.message).toContain("Missing required tool");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Assembly validator warning passes
// ---------------------------------------------------------------------------

describe("assembly validator warning passes", () => {
  test("warning-only diagnostics do not block creation", async () => {
    const warningExtension: KernelExtension = {
      name: "test:warner",
      validateAssembly: (): ValidationResult => ({
        ok: false,
        diagnostics: [{ source: "test:warner", message: "Deprecated config", severity: "warning" }],
      }),
    };

    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    // Should succeed — warnings don't block
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      extensions: [warningExtension],
    });

    const events = await collectEvents(runtime.run({ kind: "messages", messages: [] }));
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Lifecycle validator blocks transition
// ---------------------------------------------------------------------------

describe("lifecycle validator blocks transition", () => {
  test("validator rejects created→running → state stays created", async () => {
    const blockTransitions: KernelExtension = {
      name: "test:lifecycle-blocker",
      validateTransition: (ctx) => {
        // Block created→running
        if (ctx.from === "created" && ctx.to === "running") {
          return false;
        }
        return true;
      },
    };

    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      extensions: [blockTransitions],
    });

    // The agent will try to start running but the validator blocks it
    // State should stay "created" since the transition was rejected
    await collectEvents(runtime.run({ kind: "messages", messages: [] }));
    expect(runtime.agent.state).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// 7. Hot path skip
// ---------------------------------------------------------------------------

describe("hot path skip", () => {
  test("running→waiting does not call validator", async () => {
    let validatorCallCount = 0;
    const trackingExtension: KernelExtension = {
      name: "test:tracker",
      validateTransition: (ctx) => {
        validatorCallCount++;
        // Throw if called with hot-path transition — should never happen
        if (
          (ctx.from === "running" && ctx.to === "waiting") ||
          (ctx.from === "waiting" && ctx.to === "running")
        ) {
          throw new Error("Should not be called for hot-path transitions");
        }
        return true;
      },
    };

    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      extensions: [trackingExtension],
    });

    // Should run without the throw being triggered
    await collectEvents(runtime.run({ kind: "messages", messages: [] }));

    // Validator was called for significant transitions only
    // (created→running, running→terminated)
    expect(validatorCallCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Multiple extensions compose
// ---------------------------------------------------------------------------

describe("multiple extensions compose", () => {
  test("three extensions with different slots compose correctly", async () => {
    const guardCalled: string[] = [];

    const guardExtension: KernelExtension = {
      name: "test:guard-ext",
      priority: EXTENSION_PRIORITY.PLATFORM,
      guards: () => [
        {
          name: "test:extra-guard",
          priority: 998,
          onBeforeTurn: async () => {
            guardCalled.push("guard-ext");
          },
        },
      ],
    };

    const lifecycleExtension: KernelExtension = {
      name: "test:lifecycle-ext",
      priority: EXTENSION_PRIORITY.USER,
      validateTransition: () => true, // Allow all
    };

    const assemblyExtension: KernelExtension = {
      name: "test:assembly-ext",
      priority: EXTENSION_PRIORITY.ADDON,
      validateAssembly: () => ({ ok: true }),
    };

    const adapter = mockAdapter([
      { kind: "text_delta", delta: "hello" },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      extensions: [guardExtension, lifecycleExtension, assemblyExtension],
    });

    await collectEvents(runtime.run({ kind: "messages", messages: [] }));

    expect(guardCalled).toContain("guard-ext");
    expect(runtime.agent.state).toBe("terminated");
  });
});
