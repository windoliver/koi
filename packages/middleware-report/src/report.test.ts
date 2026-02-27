import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelChunk, ModelResponse, RunReport } from "@koi/core";
import { agentId, runId, sessionId } from "@koi/core/ecs";
import {
  createMockModelStreamHandler,
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createReportMiddleware } from "./report.js";
import type { ReportHandle } from "./types.js";

async function runSession(
  handle: ReportHandle,
  options: {
    readonly turns?: number;
    readonly modelCalls?: number;
    readonly toolCalls?: number;
    readonly modelResponse?: Partial<ModelResponse>;
    readonly failModel?: boolean;
    readonly failTool?: boolean;
    readonly stream?: boolean;
    readonly streamChunks?: readonly ModelChunk[];
  } = {},
): Promise<void> {
  const {
    turns = 1,
    modelCalls = 1,
    toolCalls = 0,
    modelResponse,
    failModel = false,
    failTool = false,
    stream = false,
    streamChunks,
  } = options;

  const { middleware } = handle;
  const sessionCtx = createMockSessionContext();

  await middleware.onSessionStart?.(sessionCtx);

  for (let t = 0; t < turns; t++) {
    const turnCtx = createMockTurnContext({ turnIndex: t });

    await middleware.onBeforeTurn?.(turnCtx);

    for (let m = 0; m < modelCalls; m++) {
      if (stream) {
        const chunks: readonly ModelChunk[] = streamChunks ?? [
          { kind: "text_delta", delta: "hello" },
          { kind: "usage", inputTokens: 100, outputTokens: 50 },
          {
            kind: "done",
            response: {
              content: "hello",
              model: "test-model",
              usage: { inputTokens: 100, outputTokens: 50 },
            },
          },
        ];
        const streamHandler = createMockModelStreamHandler(chunks);
        const iter = middleware.wrapModelStream?.(
          turnCtx,
          { messages: [], model: "test-model" },
          streamHandler,
        );
        if (iter) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of iter) {
            // consume
          }
        }
      } else if (failModel) {
        const failingHandler = async (): Promise<ModelResponse> => {
          throw new Error("Model call failed");
        };
        try {
          await middleware.wrapModelCall?.(
            turnCtx,
            { messages: [], model: "test-model" },
            failingHandler,
          );
        } catch {
          // expected
        }
      } else {
        const spy = createSpyModelHandler(modelResponse);
        await middleware.wrapModelCall?.(
          turnCtx,
          { messages: [], model: "test-model" },
          spy.handler,
        );
      }
    }

    for (let tc = 0; tc < toolCalls; tc++) {
      if (failTool) {
        const failingHandler = async () => {
          throw new Error("Tool execution failed");
        };
        try {
          await middleware.wrapToolCall?.(
            turnCtx,
            { toolId: "file_write", input: {} },
            failingHandler,
          );
        } catch {
          // expected
        }
      } else {
        const spy = createSpyToolHandler();
        await middleware.wrapToolCall?.(turnCtx, { toolId: "file_write", input: {} }, spy.handler);
      }
    }

    await middleware.onAfterTurn?.(turnCtx);
  }

  await middleware.onSessionEnd?.(sessionCtx);
}

describe("createReportMiddleware", () => {
  let handle: ReportHandle;

  beforeEach(() => {
    handle = createReportMiddleware({});
  });

  test("generates report on session end with correct structure", async () => {
    await runSession(handle, { turns: 2, modelCalls: 1, toolCalls: 1 });
    const report = handle.getReport();

    expect(report).toBeDefined();
    expect(report?.agentId).toBe(agentId("agent-test-1"));
    expect(report?.sessionId).toBe(sessionId("session-test-1"));
    expect(report?.runId).toBe(runId("run-test-1"));
    expect(report?.duration.totalTurns).toBe(2);
    expect(report?.actions.length).toBeGreaterThan(0);
    expect(report?.summary).toContain("actions");
  });

  test("accumulates actions across multiple turns", async () => {
    await runSession(handle, { turns: 3, modelCalls: 1, toolCalls: 1 });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    // 3 turns * (1 model + 1 tool) = 6 actions
    expect(report.actions).toHaveLength(6);
    expect(report.duration.totalTurns).toBe(3);
  });

  test("invokes summarizer and uses returned summary/recommendations", async () => {
    handle = createReportMiddleware({
      summarizer: async () => ({
        summary: "Custom summary from AI",
        recommendations: ["Use caching", "Add retries"],
      }),
    });

    await runSession(handle, { turns: 1 });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    expect(report.summary).toBe("Custom summary from AI");
    expect(report.recommendations).toEqual(["Use caching", "Add retries"]);
  });

  test("generates valid report with zero turns (empty session)", async () => {
    const sessionCtx = createMockSessionContext();
    await handle.middleware.onSessionStart?.(sessionCtx);
    await handle.middleware.onSessionEnd?.(sessionCtx);

    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.duration.totalTurns).toBe(0);
    expect(report.duration.totalActions).toBe(0);
    expect(report.actions).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
    expect(report.summary).toContain("0 actions");
  });

  test("records issue when model call throws, re-throws error", async () => {
    await runSession(handle, { turns: 1, modelCalls: 1, failModel: true });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    const criticalIssues = report.issues.filter((i) => i.severity === "critical");
    expect(criticalIssues.length).toBeGreaterThan(0);
    expect(criticalIssues[0]?.message).toContain("Model call failed");

    const failedActions = report.actions.filter((a) => !a.success);
    expect(failedActions.length).toBeGreaterThan(0);
  });

  test("accumulates token usage from wrapModelStream chunks", async () => {
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "hello " },
      { kind: "usage", inputTokens: 200, outputTokens: 100 },
      { kind: "text_delta", delta: "world" },
      {
        kind: "done",
        response: {
          content: "hello world",
          model: "test-model",
          usage: { inputTokens: 200, outputTokens: 100 },
        },
      },
    ];

    await runSession(handle, {
      turns: 1,
      stream: true,
      streamChunks: chunks,
    });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    expect(report.cost.inputTokens).toBe(200);
    expect(report.cost.outputTokens).toBe(100);
    expect(report.cost.totalTokens).toBe(300);
  });

  test("falls back to template when summarizer throws", async () => {
    handle = createReportMiddleware({
      summarizer: async () => {
        throw new Error("Summarizer crashed");
      },
    });

    await runSession(handle, { turns: 1 });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    // Should still have a summary (template fallback)
    expect(report.summary).toContain("actions");
    expect(report.summary).toContain("turns");
    expect(report.recommendations).toEqual([]);
  });

  test("generates report with partial data on abort", async () => {
    const sessionCtx = createMockSessionContext();
    await handle.middleware.onSessionStart?.(sessionCtx);

    // Run one turn, then end abruptly (simulating abort)
    const turnCtx = createMockTurnContext({ turnIndex: 0 });
    const spy = createSpyModelHandler();
    await handle.middleware.wrapModelCall?.(
      turnCtx,
      { messages: [], model: "test-model" },
      spy.handler,
    );
    // No onAfterTurn — simulates abort mid-turn

    await handle.middleware.onSessionEnd?.(sessionCtx);

    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.actions).toHaveLength(1);
    // turnCount is 0 because onAfterTurn was never called
    expect(report.duration.totalTurns).toBe(0);
  });

  test("caps actions at maxActions with FIFO truncation", async () => {
    handle = createReportMiddleware({ maxActions: 3 });

    await runSession(handle, { turns: 5, modelCalls: 1 });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    expect(report.actions).toHaveLength(3);
    expect(report.duration.totalActions).toBe(5);
    expect(report.duration.truncated).toBe(true);
  });

  test("getReport() returns undefined before session end", () => {
    expect(handle.getReport()).toBeUndefined();
  });

  test("getReport() returns RunReport after session end", async () => {
    await runSession(handle);
    expect(handle.getReport()).toBeDefined();
  });

  test("onReport callback receives both report and formatted string", async () => {
    let receivedReport: RunReport | undefined;
    let receivedFormatted: string | undefined;

    handle = createReportMiddleware({
      onReport: (report, formatted) => {
        receivedReport = report;
        receivedFormatted = formatted;
      },
    });

    await runSession(handle);

    expect(receivedReport).toBeDefined();
    expect(receivedFormatted).toBeDefined();
    expect(receivedFormatted).toContain("Summary");
  });

  test("uses custom formatter when configured", async () => {
    let formattedOutput = "";

    handle = createReportMiddleware({
      formatter: (report) => `CUSTOM: ${report.summary}`,
      onReport: (_report, formatted) => {
        formattedOutput = formatted;
      },
    });

    await runSession(handle);

    expect(formattedOutput).toStartWith("CUSTOM:");
  });

  test("populates cost from costProvider", async () => {
    handle = createReportMiddleware({
      costProvider: () => ({ estimatedCostUsd: 1.23 }),
    });

    await runSession(handle);
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.cost.estimatedCostUsd).toBe(1.23);
  });

  test("handles costProvider failure gracefully", async () => {
    handle = createReportMiddleware({
      costProvider: () => {
        throw new Error("Cost API down");
      },
    });

    await runSession(handle);
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.cost.estimatedCostUsd).toBeUndefined();
  });

  test("records tool call errors as warning issues", async () => {
    await runSession(handle, { turns: 1, toolCalls: 1, failTool: true });
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;

    const warnings = report.issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.message).toContain("file_write");
  });

  test("sets objective from config", async () => {
    handle = createReportMiddleware({ objective: "Refactor auth module" });
    await runSession(handle);
    const report = handle.getReport();
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.objective).toBe("Refactor auth module");
  });

  test("getProgress() returns live snapshot mid-run", async () => {
    const sessionCtx = createMockSessionContext();
    await handle.middleware.onSessionStart?.(sessionCtx);

    const spy = createSpyModelHandler({
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const turnCtx = createMockTurnContext({ turnIndex: 0 });
    await handle.middleware.wrapModelCall?.(
      turnCtx,
      { messages: [], model: "test-model" },
      spy.handler,
    );
    await handle.middleware.onAfterTurn?.(turnCtx);

    const progress = handle.getProgress();
    expect(progress.totalActions).toBe(1);
    expect(progress.inputTokens).toBe(100);
    expect(progress.outputTokens).toBe(50);
    expect(progress.totalTokens).toBe(150);
    expect(progress.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("getProgress() returns zeroes before session start", () => {
    const progress = handle.getProgress();
    expect(progress.totalActions).toBe(0);
    expect(progress.totalTokens).toBe(0);
    expect(progress.elapsedMs).toBe(0);
  });

  test("onProgress callback fires after each turn", async () => {
    const snapshots: Array<{ readonly turnIndex: number; readonly totalActions: number }> = [];

    handle = createReportMiddleware({
      onProgress: (progress) => {
        snapshots.push({
          turnIndex: progress.turnIndex,
          totalActions: progress.totalActions,
        });
      },
    });

    await runSession(handle, { turns: 3, modelCalls: 1 });

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.turnIndex).toBe(0);
    expect(snapshots[1]?.turnIndex).toBe(1);
    expect(snapshots[2]?.turnIndex).toBe(2);
    expect(snapshots[2]?.totalActions).toBe(3);
  });

  test("onProgress callback failure is swallowed", async () => {
    handle = createReportMiddleware({
      onProgress: () => {
        throw new Error("Progress callback crashed");
      },
    });

    // Should not throw
    await runSession(handle, { turns: 1 });
    const report = handle.getReport();
    expect(report).toBeDefined();
  });
});
