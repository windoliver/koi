/**
 * Integration tests for the full exaptation detection pipeline.
 *
 * Simulates multi-agent scenarios end-to-end: model call → tool call → detection → signal.
 */

import { describe, expect, it } from "bun:test";
import type { ExaptationSignal, ModelRequest, ModelResponse, ToolResponse } from "@koi/core";
import { createMockSessionContext, createMockTurnContext } from "@koi/test-utils";
import { createExaptationDetector } from "../exaptation-detector.js";
import type { ExaptationConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides?: Partial<ExaptationConfig>): ExaptationConfig {
  return {
    cooldownMs: 0,
    ...overrides,
  };
}

function createModelRequest(
  tools: readonly { readonly name: string; readonly description: string }[],
): ModelRequest {
  return {
    messages: [],
    tools: tools.map((t) => ({ ...t, inputSchema: {} })),
  } as unknown as ModelRequest;
}

function createModelResponse(text: string): ModelResponse {
  return {
    content: text,
    model: "test-model",
    usage: { inputTokens: 0, outputTokens: 0 },
  } as unknown as ModelResponse;
}

async function simulateToolUsage(
  handle: ReturnType<typeof createExaptationDetector>,
  agentId: string,
  toolId: string,
  toolDescription: string,
  contextText: string,
): Promise<void> {
  const ctx = createMockTurnContext({ session: createMockSessionContext({ agentId }) });
  const modelReq = createModelRequest([{ name: toolId, description: toolDescription }]);

  await handle.middleware.wrapModelCall?.(ctx, modelReq, async () =>
    createModelResponse(contextText),
  );

  await handle.middleware.wrapToolCall?.(
    ctx,
    { toolId, input: {} },
    async (): Promise<ToolResponse> => ({
      output: "ok",
    }),
  );
}

// ---------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------

describe("exaptation pipeline", () => {
  it("detects purpose drift when 2 agents repurpose the same tool", async () => {
    const signals: ExaptationSignal[] = [];
    const handle = createExaptationDetector(
      createConfig({
        thresholds: {
          minObservations: 4,
          divergenceThreshold: 0.5,
          minDivergentAgents: 2,
          confidenceWeight: 0.8,
        },
        onSignal: (s) => signals.push(s),
      }),
    );

    const toolId = "code-formatter";
    const toolDesc = "Format source code files according to project style guide conventions";

    // Agent A: using the formatter for security scanning purposes
    await simulateToolUsage(
      handle,
      "agent-security",
      toolId,
      toolDesc,
      "scan the application for SQL injection vulnerabilities and cross-site scripting attack vectors",
    );
    await simulateToolUsage(
      handle,
      "agent-security",
      toolId,
      toolDesc,
      "analyze authentication tokens and check for credential exposure in server logs",
    );

    // Agent B: using it for deployment orchestration
    await simulateToolUsage(
      handle,
      "agent-deploy",
      toolId,
      toolDesc,
      "deploy container images to kubernetes cluster and manage rolling updates",
    );
    await simulateToolUsage(
      handle,
      "agent-deploy",
      toolId,
      toolDesc,
      "configure load balancer routing rules and update DNS records for the staging environment",
    );

    expect(signals.length).toBe(1);
    const signal = signals[0];
    expect(signal).toBeDefined();
    expect(signal?.kind).toBe("exaptation");
    expect(signal?.exaptationKind).toBe("purpose_drift");
    expect(signal?.brickId).toBe(toolId);
    expect(signal?.agentCount).toBeGreaterThanOrEqual(2);
    expect(signal?.divergenceScore).toBeGreaterThan(0.5);
    expect(signal?.confidence).toBeGreaterThan(0);
    expect(signal?.confidence).toBeLessThanOrEqual(1);
    expect(signal?.statedPurpose).toContain("Format source code");
    expect(signal?.observedContexts.length).toBeGreaterThan(0);
  });

  it("full signal lifecycle: emission → query → dismissal", async () => {
    const emitted: ExaptationSignal[] = [];
    const dismissed: string[] = [];

    const handle = createExaptationDetector(
      createConfig({
        thresholds: {
          minObservations: 2,
          divergenceThreshold: 0.5,
          minDivergentAgents: 2,
          confidenceWeight: 0.8,
        },
        onSignal: (s) => emitted.push(s),
        onDismiss: (id) => dismissed.push(id),
      }),
    );

    const toolId = "file-reader";
    const toolDesc = "Read files from the filesystem and return their contents";

    // Phase 1: Emission
    await simulateToolUsage(
      handle,
      "agent-1",
      toolId,
      toolDesc,
      "network monitoring traffic analysis and bandwidth utilization tracking",
    );
    await simulateToolUsage(
      handle,
      "agent-2",
      toolId,
      toolDesc,
      "database query optimization and transaction statistics aggregation",
    );

    expect(emitted.length).toBe(1);
    expect(handle.getActiveSignalCount()).toBe(1);

    // Phase 2: Query
    const queriedSignals = handle.getSignals();
    expect(queriedSignals.length).toBe(1);
    expect(queriedSignals[0]?.id).toBe(emitted[0]?.id);

    // Phase 3: Dismissal
    const signalId = queriedSignals[0]?.id ?? "";
    handle.dismiss(signalId);
    expect(dismissed).toEqual([signalId]);
    expect(handle.getSignals().length).toBe(0);
    expect(handle.getActiveSignalCount()).toBe(0);
  });

  it("does not cross-contaminate observations between different tools", async () => {
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

    // Tool A: 2 divergent observations (below threshold of 3)
    await simulateToolUsage(
      handle,
      "agent-1",
      "tool-a",
      "Read files",
      "network monitoring traffic",
    );
    await simulateToolUsage(handle, "agent-2", "tool-a", "Read files", "database query statistics");

    // Tool B: 2 divergent observations (below threshold of 3)
    await simulateToolUsage(
      handle,
      "agent-1",
      "tool-b",
      "Write files",
      "server deployment automation",
    );
    await simulateToolUsage(
      handle,
      "agent-2",
      "tool-b",
      "Write files",
      "cloud infrastructure management",
    );

    // Neither tool should have triggered (each has only 2 observations)
    expect(signals.length).toBe(0);
  });
});
