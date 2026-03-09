import { describe, expect, it } from "bun:test";
import type { ForgeBudget, ForgeDemandSignal, ModelResponse, ToolResponse } from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
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
    content: text,
    model: "test-model",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function createSuccessToolResponse(): ToolResponse {
  return { output: "success" };
}

const defaultBudget: ForgeBudget = {
  ...DEFAULT_FORGE_BUDGET,
  cooldownMs: 0, // disable cooldown for tests
};

/** Budget with low threshold — allows signals from low-confidence triggers like no_matching_tool. */
const lowThresholdBudget: ForgeBudget = {
  ...defaultBudget,
  demandThreshold: 0.1,
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

  describe("wrapToolCall — no_matching_tool detection", () => {
    it("emits no_matching_tool when NOT_FOUND error thrown", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({ budget: lowThresholdBudget, onDemand: (s) => signals.push(s) }),
      );

      const ctx = createMockTurnContext();
      const notFoundNext = async () => {
        throw KoiRuntimeError.from("NOT_FOUND", 'Tool not found: "my-tool"');
      };

      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("my-tool"), notFoundNext);
      } catch {
        // expected
      }

      expect(signals.length).toBe(1);
      expect(signals[0]?.trigger.kind).toBe("no_matching_tool");
    });

    it("still emits repeated_failure for non-NOT_FOUND errors", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          budget: lowThresholdBudget,
          heuristics: { repeatedFailureCount: 1 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const genericFail = async () => {
        throw new Error("connection refused");
      };

      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), genericFail);
      } catch {
        // expected
      }

      expect(signals.length).toBe(1);
      expect(signals[0]?.trigger.kind).toBe("repeated_failure");
    });

    it("no_matching_tool trigger has correct query and attempts fields", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({ budget: lowThresholdBudget, onDemand: (s) => signals.push(s) }),
      );

      const ctx = createMockTurnContext();
      const notFoundNext = async () => {
        throw KoiRuntimeError.from("NOT_FOUND", 'Tool not found: "special-tool"');
      };

      try {
        await handle.middleware.wrapToolCall?.(
          ctx,
          createToolRequest("special-tool"),
          notFoundNext,
        );
      } catch {
        // expected
      }

      const trigger = signals[0]?.trigger;
      expect(trigger?.kind).toBe("no_matching_tool");
      if (trigger?.kind === "no_matching_tool") {
        expect(trigger.query).toBe("special-tool");
        expect(trigger.attempts).toBe(1);
      }
    });

    it("no_matching_tool uses capabilityGap confidence weight (0.8)", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({ budget: lowThresholdBudget, onDemand: (s) => signals.push(s) }),
      );

      const ctx = createMockTurnContext();
      const notFoundNext = async () => {
        throw KoiRuntimeError.from("NOT_FOUND", "Tool not found");
      };

      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("x"), notFoundNext);
      } catch {
        // expected
      }

      // capabilityGap base weight = 0.8, severity = min(1/3, 2) ≈ 0.333
      // confidence = 0.8 * 0.333 ≈ 0.266 (above lowThresholdBudget.demandThreshold 0.1)
      expect(signals.length).toBe(1);
      expect(signals[0]?.confidence).toBeCloseTo(0.8 * (1 / 3), 2);
    });

    it("cooldown applies to no_matching_tool via nmt: key", async () => {
      // let: mutable clock for test control
      let now = 1000;
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          budget: { ...lowThresholdBudget, cooldownMs: 5000 },
          onDemand: (s) => signals.push(s),
          clock: () => now,
        }),
      );

      const ctx = createMockTurnContext();
      const notFoundNext = async () => {
        throw KoiRuntimeError.from("NOT_FOUND", "Tool not found");
      };

      // First call → signal emitted
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-x"), notFoundNext);
      } catch {
        // expected
      }
      expect(signals.length).toBe(1);

      // Second call at same time → cooldown suppresses
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-x"), notFoundNext);
      } catch {
        // expected
      }
      expect(signals.length).toBe(1);

      // Advance past cooldown
      now = 7000;
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-x"), notFoundNext);
      } catch {
        // expected
      }
      expect(signals.length).toBe(2);
    });

    it("no_matching_tool does NOT increment consecutiveFailures counter", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          budget: lowThresholdBudget,
          heuristics: { repeatedFailureCount: 2 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const notFoundNext = async () => {
        throw KoiRuntimeError.from("NOT_FOUND", "Tool not found");
      };
      const genericFail = async () => {
        throw new Error("connection refused");
      };

      // NOT_FOUND × 3 → should emit no_matching_tool but NOT repeated_failure
      for (let i = 0; i < 3; i++) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), notFoundNext);
        } catch {
          // expected
        }
      }

      const nmtSignals = signals.filter((s) => s.trigger.kind === "no_matching_tool");
      const rfSignals = signals.filter((s) => s.trigger.kind === "repeated_failure");
      expect(nmtSignals.length).toBeGreaterThanOrEqual(1);
      expect(rfSignals.length).toBe(0);

      // Now a generic failure for the same tool — should start counting from 0
      // (one failure, below threshold of 2)
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), genericFail);
      } catch {
        // expected
      }

      const rfSignalsAfter = signals.filter((s) => s.trigger.kind === "repeated_failure");
      expect(rfSignalsAfter.length).toBe(0);
    });
  });

  describe("brick-kind selection integration", () => {
    it("suggestedBrickKind uses selectBrickKind for repeated_failure → skill", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { repeatedFailureCount: 1 },
          onDemand: (s) => signals.push(s),
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

      expect(signals.length).toBe(1);
      expect(signals[0]?.suggestedBrickKind).toBe("skill");
    });

    it("suggestedBrickKind for no_matching_tool → skill", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({ budget: lowThresholdBudget, onDemand: (s) => signals.push(s) }),
      );

      const ctx = createMockTurnContext();
      try {
        await handle.middleware.wrapToolCall?.(ctx, createToolRequest("x"), async () => {
          throw KoiRuntimeError.from("NOT_FOUND", "Tool not found");
        });
      } catch {
        // expected
      }

      expect(signals.length).toBe(1);
      expect(signals[0]?.suggestedBrickKind).toBe("skill");
    });

    it("suggestedBrickKind for capability_gap → skill", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { capabilityGapOccurrences: 1 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      const response = createModelResponse("I don't have a tool for that.");
      await handle.middleware.wrapModelCall?.(ctx, {} as never, async () => response);

      expect(signals.length).toBe(1);
      expect(signals[0]?.suggestedBrickKind).toBe("skill");
    });
  });

  describe("memory management", () => {
    it("caps failedToolCalls at MAX_FAILED_CALL_MESSAGES", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          budget: lowThresholdBudget,
          heuristics: { repeatedFailureCount: 1 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      // Fail 15 times (MAX_FAILED_CALL_MESSAGES = 10)
      for (let i = 0; i < 15; i++) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, createToolRequest("tool-a"), async () => {
            throw new Error(`failure-${String(i)}`);
          });
        } catch {
          // expected
        }
      }

      // Signal should contain at most 10 failedToolCalls
      const lastSignal = signals.at(-1);
      expect(lastSignal).toBeDefined();
      expect(lastSignal?.context.failedToolCalls.length).toBeLessThanOrEqual(10);
    });
  });

  describe("wrapModelStream — capability gap detection", () => {
    it("emits signal from streamed text chunks", async () => {
      const signals: ForgeDemandSignal[] = [];
      const handle = createForgeDemandDetector(
        createConfig({
          heuristics: { capabilityGapOccurrences: 1 },
          onDemand: (s) => signals.push(s),
        }),
      );

      const ctx = createMockTurnContext();
      async function* fakeStream() {
        yield { kind: "text_delta" as const, delta: "I don't have " };
        yield { kind: "text_delta" as const, delta: "a tool for that." };
      }

      const chunks: unknown[] = [];
      const wrapStream = handle.middleware.wrapModelStream;
      expect(wrapStream).toBeDefined();
      if (wrapStream === undefined) return;
      for await (const chunk of wrapStream(ctx, {} as never, () => fakeStream())) {
        chunks.push(chunk);
      }

      // All chunks yielded through
      expect(chunks.length).toBe(2);
      // Signal emitted from assembled text
      expect(signals.length).toBe(1);
      expect(signals[0]?.trigger.kind).toBe("capability_gap");
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
