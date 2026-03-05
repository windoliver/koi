import { describe, expect, it } from "bun:test";
import type { ExaptationSignal, ModelRequest, ModelResponse, ToolResponse } from "@koi/core";
import { createMockSessionContext, createMockTurnContext } from "@koi/test-utils";
import { createExaptationDetector } from "./exaptation-detector.js";
import type { ExaptationConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createToolRequest(toolId: string): {
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
} {
  return { toolId, input: {} };
}

function createModelRequest(
  tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
  }[],
): ModelRequest {
  return {
    messages: [],
    tools,
  } as unknown as ModelRequest;
}

function createModelResponse(text: string): ModelResponse {
  return {
    content: text,
    model: "test-model",
    usage: { inputTokens: 0, outputTokens: 0 },
  } as unknown as ModelResponse;
}

function createSuccessToolResponse(): ToolResponse {
  return { output: "success" };
}

function createConfig(overrides?: Partial<ExaptationConfig>): ExaptationConfig {
  return {
    cooldownMs: 0, // disable cooldown for tests
    ...overrides,
  };
}

/**
 * Simulate a full observation cycle: model call (captures context + caches tool descriptions),
 * then tool call (observes divergence).
 */
function createTurnCtxForAgent(agentId: string): ReturnType<typeof createMockTurnContext> {
  return createMockTurnContext({
    session: createMockSessionContext({ agentId }),
  });
}

async function simulateToolUsage(
  handle: ReturnType<typeof createExaptationDetector>,
  agentId: string,
  toolId: string,
  toolDescription: string,
  contextText: string,
): Promise<void> {
  const ctx = createTurnCtxForAgent(agentId);
  const modelReq = createModelRequest([
    { name: toolId, description: toolDescription, inputSchema: {} },
  ]);
  const modelRes = createModelResponse(contextText);

  // wrapModelCall — captures text + caches tool description
  await handle.middleware.wrapModelCall?.(ctx, modelReq, async () => modelRes);

  // wrapToolCall — creates observation + checks drift
  await handle.middleware.wrapToolCall?.(ctx, createToolRequest(toolId), async () =>
    createSuccessToolResponse(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExaptationDetector", () => {
  describe("signal emission", () => {
    it("emits signal after purpose drift detected across multiple agents", async () => {
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 3,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          onSignal: (s) => signals.push(s),
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem and return contents";

      // Agent 1: using file-reader for completely different purpose (network monitoring)
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "analyze network traffic patterns and detect anomalies in the connection logs",
      );
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "monitor server performance metrics and track bandwidth utilization",
      );

      // Agent 2: also using it for a divergent purpose (database querying)
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "query database records and aggregate transaction statistics from tables",
      );

      expect(signals.length).toBe(1);
      expect(signals[0]?.kind).toBe("exaptation");
      expect(signals[0]?.exaptationKind).toBe("purpose_drift");
      expect(signals[0]?.brickId).toBe(toolId);
    });

    it("does not emit below observation threshold", async () => {
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 10, // high threshold
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          onSignal: (s) => signals.push(s),
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      await simulateToolUsage(handle, "agent-1", toolId, toolDesc, "network monitoring traffic");
      await simulateToolUsage(handle, "agent-2", toolId, toolDesc, "database query statistics");

      expect(signals.length).toBe(0);
    });

    it("does not emit below divergence threshold", async () => {
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.99, // extremely high — nearly impossible to trigger
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          onSignal: (s) => signals.push(s),
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem and return contents";

      // Using with similar context — low divergence
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "read files from the filesystem and return their contents",
      );
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "read files from disk and return file contents",
      );
      await simulateToolUsage(
        handle,
        "agent-3",
        toolId,
        toolDesc,
        "reading file content from filesystem",
      );

      expect(signals.length).toBe(0);
    });

    it("does not emit with single agent (below minDivergentAgents)", async () => {
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 3,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          onSignal: (s) => signals.push(s),
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      // Only agent-1 — even with high divergence
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "network monitoring traffic analysis",
      );
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "database query optimization statistics",
      );
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "server performance benchmark results",
      );

      expect(signals.length).toBe(0);
    });
  });

  describe("cooldown", () => {
    it("suppresses duplicate signals within cooldown period", async () => {
      // let: mutable clock for test control
      let now = 1000;
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          cooldownMs: 5000,
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          clock: () => now,
          onSignal: (s) => signals.push(s),
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      // Trigger first signal
      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "network monitoring traffic analysis",
      );
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "database query optimization statistics",
      );
      expect(signals.length).toBe(1);

      // Same tool within cooldown — suppressed
      await simulateToolUsage(
        handle,
        "agent-3",
        toolId,
        toolDesc,
        "server performance benchmark results",
      );
      expect(signals.length).toBe(1);

      // Advance past cooldown
      now = 7000;
      await simulateToolUsage(
        handle,
        "agent-4",
        toolId,
        toolDesc,
        "cloud infrastructure deployment automation",
      );
      expect(signals.length).toBe(2);
    });
  });

  describe("signal management", () => {
    it("returns signals via getSignals", async () => {
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "network monitoring traffic analysis",
      );
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "database query optimization statistics",
      );

      expect(handle.getSignals().length).toBe(1);
      expect(handle.getActiveSignalCount()).toBe(1);
    });

    it("dismiss removes signal and resets cooldown", async () => {
      // let: mutable clock for test control
      let now = 1000;
      const handle = createExaptationDetector(
        createConfig({
          cooldownMs: 60_000,
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          clock: () => now,
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "network monitoring traffic analysis",
      );
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "database query optimization statistics",
      );

      const signalId = handle.getSignals()[0]?.id ?? "";
      expect(signalId).not.toBe("");

      handle.dismiss(signalId);
      expect(handle.getSignals().length).toBe(0);
      expect(handle.getActiveSignalCount()).toBe(0);

      // Can emit again immediately (cooldown cleared by dismiss)
      now = 1001;
      await simulateToolUsage(
        handle,
        "agent-3",
        toolId,
        toolDesc,
        "cloud infrastructure deployment automation",
      );
      expect(handle.getSignals().length).toBe(1);
    });

    it("dismiss calls onDismiss callback", async () => {
      const dismissed: string[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
          onDismiss: (id) => dismissed.push(id),
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "network monitoring traffic analysis",
      );
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "database query optimization statistics",
      );

      const signalId = handle.getSignals()[0]?.id ?? "";
      handle.dismiss(signalId);
      expect(dismissed).toEqual([signalId]);
    });

    it("dismiss with unknown id is a no-op", () => {
      const handle = createExaptationDetector(createConfig());
      handle.dismiss("nonexistent");
      expect(handle.getSignals().length).toBe(0);
    });

    it("enforces bounded signal queue", async () => {
      const handle = createExaptationDetector(
        createConfig({
          maxPendingSignals: 2,
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
        }),
      );

      // Emit signals for 3 different tools
      for (const toolId of ["tool-a", "tool-b", "tool-c"]) {
        const toolDesc = "Read files from the filesystem";
        await simulateToolUsage(
          handle,
          "agent-1",
          toolId,
          toolDesc,
          "network monitoring traffic analysis",
        );
        await simulateToolUsage(
          handle,
          "agent-2",
          toolId,
          toolDesc,
          "database query optimization statistics",
        );
      }

      // Only 2 should be retained (oldest evicted)
      expect(handle.getSignals().length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("skips observation when no tool description cached", async () => {
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 1,
            divergenceThreshold: 0.1,
            minDivergentAgents: 1,
            confidenceWeight: 0.8,
          },
          onSignal: (s) => signals.push(s),
        }),
      );

      // Call wrapToolCall without prior wrapModelCall — no cached description
      const ctx = createTurnCtxForAgent("agent-1");
      await handle.middleware.wrapToolCall?.(ctx, createToolRequest("unknown-tool"), async () =>
        createSuccessToolResponse(),
      );

      expect(signals.length).toBe(0);
    });

    it("skips observation when model response is empty", async () => {
      const signals: ExaptationSignal[] = [];
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 1,
            divergenceThreshold: 0.1,
            minDivergentAgents: 1,
            confidenceWeight: 0.8,
          },
          onSignal: (s) => signals.push(s),
        }),
      );

      const ctx = createTurnCtxForAgent("agent-1");
      const modelReq = createModelRequest([
        { name: "file-reader", description: "Read files", inputSchema: {} },
      ]);

      // Model returns empty content
      await handle.middleware.wrapModelCall?.(ctx, modelReq, async () => createModelResponse(""));

      await handle.middleware.wrapToolCall?.(ctx, createToolRequest("file-reader"), async () =>
        createSuccessToolResponse(),
      );

      expect(signals.length).toBe(0);
    });

    it("handles empty tool description gracefully", async () => {
      const handle = createExaptationDetector(createConfig());

      const ctx = createTurnCtxForAgent("agent-1");
      const modelReq = createModelRequest([
        { name: "file-reader", description: "", inputSchema: {} },
      ]);

      // Should not crash — empty descriptions are skipped
      await handle.middleware.wrapModelCall?.(ctx, modelReq, async () =>
        createModelResponse("some context text for analysis"),
      );

      await handle.middleware.wrapToolCall?.(ctx, createToolRequest("file-reader"), async () =>
        createSuccessToolResponse(),
      );

      // No crash, no signal (description was empty so no tokens cached)
      expect(handle.getSignals().length).toBe(0);
    });

    it("passes through tool call result unchanged", async () => {
      const handle = createExaptationDetector(createConfig());
      const ctx = createMockTurnContext();
      const expected: ToolResponse = { output: "original result" };

      const result = await handle.middleware.wrapToolCall?.(
        ctx,
        createToolRequest("tool-a"),
        async () => expected,
      );

      expect(result).toBe(expected);
    });

    it("passes through model response unchanged", async () => {
      const handle = createExaptationDetector(createConfig());
      const ctx = createMockTurnContext();
      const expected = createModelResponse("hello world");

      const result = await handle.middleware.wrapModelCall?.(
        ctx,
        createModelRequest(),
        async () => expected,
      );

      expect(result).toBe(expected);
    });
  });

  describe("describeCapabilities", () => {
    it("returns undefined when no signals", () => {
      const handle = createExaptationDetector(createConfig());
      const ctx = createMockTurnContext();
      const result = handle.middleware.describeCapabilities(ctx);
      expect(result).toBeUndefined();
    });

    it("returns capability fragment when signals exist", async () => {
      const handle = createExaptationDetector(
        createConfig({
          thresholds: {
            minObservations: 2,
            divergenceThreshold: 0.5,
            minDivergentAgents: 2,
            confidenceWeight: 0.8,
          },
        }),
      );

      const toolId = "file-reader";
      const toolDesc = "Read files from the filesystem";

      await simulateToolUsage(
        handle,
        "agent-1",
        toolId,
        toolDesc,
        "network monitoring traffic analysis",
      );
      await simulateToolUsage(
        handle,
        "agent-2",
        toolId,
        toolDesc,
        "database query optimization statistics",
      );

      const ctx = createMockTurnContext();
      const result = handle.middleware.describeCapabilities(ctx);
      expect(result).toBeDefined();
      expect(result?.label).toBe("forge-exaptation");
      expect(result?.description).toContain("1 purpose drift");
    });
  });

  describe("middleware properties", () => {
    it("has correct name", () => {
      const handle = createExaptationDetector(createConfig());
      expect(handle.middleware.name).toBe("forge-exaptation-detector");
    });

    it("has correct priority", () => {
      const handle = createExaptationDetector(createConfig());
      expect(handle.middleware.priority).toBe(465);
    });
  });
});
