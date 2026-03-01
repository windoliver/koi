import { describe, expect, it } from "bun:test";
import type { ForgeBudget, ForgeDemandSignal, ModelResponse, ToolResponse } from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import { createMockTurnContext } from "@koi/test-utils";
import { createForgeDemandDetector } from "./demand-detector.js";
import type { ForgeDemandConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolRequest(toolId: string): {
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
} {
  return { toolId, input: {} };
}

function createModelResponse(text: string): ModelResponse {
  return {
    content: [{ kind: "text", text }],
    usage: { inputTokens: 0, outputTokens: 0 },
  } as unknown as ModelResponse;
}

function createSuccessToolResponse(): ToolResponse {
  return { output: "success" };
}

const defaultBudget: ForgeBudget = {
  ...DEFAULT_FORGE_BUDGET,
  cooldownMs: 0, // disable cooldown for tests
};

function createConfig(overrides?: Partial<ForgeDemandConfig>): ForgeDemandConfig {
  return {
    budget: defaultBudget,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeDemandDetector", () => {
  describe("wrapToolCall — repeated failure detection", () => {
    it("emits signal after repeated failures reach threshold", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 3 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const failNext = async () => {
        throw new Error("tool failed");
      };

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
        } catch {
          // expected
        }
      }

      expect(signals.length).toBe(1);
      expect(signals[0]?.trigger.kind).toBe("repeated_failure");
    });

    it("does not emit signal before threshold", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 5 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const failNext = async () => {
        throw new Error("tool failed");
      };

      // Fail 4 times (below threshold of 5)
      for (let i = 0; i < 4; i++) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
        } catch {
          // expected
        }
      }

      expect(signals.length).toBe(0);
    });

    it("resets failure counter on success", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 3 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const failNext = async () => {
        throw new Error("tool failed");
      };
      const successNext = async () => createSuccessToolResponse();

      // Fail 2 times, then succeed, then fail 2 more times
      for (let i = 0; i < 2; i++) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
        } catch {
          // expected
        }
      }
      await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), successNext);
      for (let i = 0; i < 2; i++) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
        } catch {
          // expected
        }
      }

      // Should not have emitted (reset at success, only 2 consecutive after)
      expect(signals.length).toBe(0);
    });

    it("re-throws the original error", async () => {
      const handle = createForgeDemandDetector(createConfig());
      const ctx = createMockTurnContext();
      const error = new Error("original error");

      await expect(
        handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), async () => {
          throw error;
        }),
      ).rejects.toThrow("original error");
    });
  });

  describe("wrapModelCall — capability gap detection", () => {
    it("emits signal when capability gap pattern matches", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { capabilityGapOccurrences: 1 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const response = createModelResponse("I don't have a tool for that.");
      const next = async () => response;

      await handle.middleware.wrapModelCall?.(ctx, {} as never, next);

      expect(signals.length).toBe(1);
      expect(signals[0]?.trigger.kind).toBe("capability_gap");
    });

    it("skips gap detection with empty patterns", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          capabilityGapPatterns: [],
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const response = createModelResponse("I don't have a tool for that.");
      const next = async () => response;

      await handle.middleware.wrapModelCall?.(ctx, {} as never, next);
      expect(signals.length).toBe(0);
    });

    it("returns the original model response", async () => {
      const handle = createForgeDemandDetector(createConfig());
      const ctx = createMockTurnContext();
      const response = createModelResponse("Hello");
      const next = async () => response;

      const result = await handle.middleware.wrapModelCall?.(ctx, {} as never, next);
      expect(result).toBe(response);
    });
  });

  describe("signal management", () => {
    it("returns signals via getSignals", async () => {
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 1 },
        }),
      );

      const ctx = createMockTurnContext();
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), async () => {
          throw new Error("fail");
        });
      } catch {
        // expected
      }

      expect(handle.getSignals().length).toBe(1);
      expect(handle.getActiveSignalCount()).toBe(1);
    });

    it("dismiss removes signal", async () => {
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 1 },
        }),
      );

      const ctx = createMockTurnContext();
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), async () => {
          throw new Error("fail");
        });
      } catch {
        // expected
      }

      const signalId = handle.getSignals()[0]?.id ?? "";
      expect(signalId).not.toBe("");
      handle.dismiss(signalId);
      expect(handle.getSignals().length).toBe(0);
      expect(handle.getActiveSignalCount()).toBe(0);
    });

    it("dismiss calls onDismiss callback", async () => {
      const dismissed: string[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 1 },
          onDismiss: (id) => dismissed.push(id),
        }),
      );

      const ctx = createMockTurnContext();
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), async () => {
          throw new Error("fail");
        });
      } catch {
        // expected
      }

      const signalId = handle.getSignals()[0]?.id ?? "";
      handle.dismiss(signalId);
      expect(dismissed).toEqual([signalId]);
    });

    it("dismiss with unknown id is a no-op", () => {
      const handle = createForgeDemandDetector(createConfig());
      handle.dismiss("nonexistent");
      expect(handle.getSignals().length).toBe(0);
    });

    it("enforces bounded signal queue", async () => {
      const handle = createForgeDemandDetector(
        createConfig({
          maxPendingSignals: 2,
          heuristics: { repeatedFailureCount: 1 },
        }),
      );

      const ctx = createMockTurnContext();
      const failNext = async () => {
        throw new Error("fail");
      };

      // Emit 3 signals for different tools
      for (const toolId of ["tool-a", "tool-b", "tool-c"]) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest(toolId), failNext);
        } catch {
          // expected
        }
      }

      // Only 2 should be retained (oldest evicted)
      expect(handle.getSignals().length).toBe(2);
    });
  });

  describe("cooldown", () => {
    it("suppresses duplicate signals within cooldown period", async () => {
      // let: mutable clock for test control
      let now = 1000;
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          budget: { ...defaultBudget, cooldownMs: 5000 },
          heuristics: { repeatedFailureCount: 1 },
          clock: () => now,
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const failNext = async () => {
        throw new Error("fail");
      };

      // First failure → signal emitted
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
      } catch {
        // expected
      }
      expect(signals.length).toBe(1);

      // Second failure at same time → cooldown suppresses
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
      } catch {
        // expected
      }
      expect(signals.length).toBe(1);

      // Advance past cooldown
      now = 7000;
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), failNext);
      } catch {
        // expected
      }
      expect(signals.length).toBe(2);
    });
  });

  describe("describeCapabilities", () => {
    it("returns undefined when no signals", () => {
      const handle = createForgeDemandDetector(createConfig());
      const ctx = createMockTurnContext();
      const result = handle.middleware.describeCapabilities(ctx);
      expect(result).toBeUndefined();
    });

    it("returns capability fragment when signals exist", async () => {
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 1 },
        }),
      );

      const ctx = createMockTurnContext();
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), async () => {
          throw new Error("fail");
        });
      } catch {
        // expected
      }

      const result = handle.middleware.describeCapabilities(ctx);
      expect(result).toBeDefined();
      expect(result?.label).toBe("forge-demand");
      expect(result?.description).toContain("1 capability gap");
    });
  });

  describe("middleware properties", () => {
    it("has correct name", () => {
      const handle = createForgeDemandDetector(createConfig());
      expect(handle.middleware.name).toBe("forge-demand-detector");
    });

    it("has correct priority", () => {
      const handle = createForgeDemandDetector(createConfig());
      expect(handle.middleware.priority).toBe(455);
    });
  });
});
