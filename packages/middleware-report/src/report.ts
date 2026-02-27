/**
 * Report middleware factory — generates structured run reports.
 */

import type {
  ActionEntry,
  CapabilityFragment,
  IssueEntry,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  RunReport,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId as toAgentId } from "@koi/core/ecs";
import { swallowError } from "@koi/errors";
import { createAccumulator } from "./accumulator.js";
import type { ProgressSnapshot, ReportConfig, ReportData } from "./config.js";
import { DEFAULT_MAX_ACTIONS, DEFAULT_SUMMARIZER_TIMEOUT_MS } from "./config.js";
import { mapReportToMarkdown } from "./formatters.js";
import type { ReportHandle } from "./types.js";

function generateTemplateSummary(
  totalActions: number,
  totalTurns: number,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  issues: readonly IssueEntry[],
): string {
  const totalTokens = inputTokens + outputTokens;
  const resolved = issues.filter((i) => i.resolved).length;
  return (
    `Completed ${totalActions} actions across ${totalTurns} turns in ${durationMs}ms. ` +
    `Used ${totalTokens} tokens (${inputTokens} input, ${outputTokens} output). ` +
    `${issues.length} issues encountered, ${resolved} resolved.`
  );
}

export function createReportMiddleware(config: ReportConfig = {}): ReportHandle {
  const maxActions = config.maxActions ?? DEFAULT_MAX_ACTIONS;
  const summarizerTimeoutMs = config.summarizerTimeoutMs ?? DEFAULT_SUMMARIZER_TIMEOUT_MS;
  const formatter = config.formatter ?? mapReportToMarkdown;
  const accumulator = createAccumulator(maxActions);

  let startedAt = 0;
  let turnCount = 0;
  let report: RunReport | undefined;

  const capabilityFragment: CapabilityFragment = {
    label: "report",
    description: "Structured run report will be generated at session end",
  };

  const middleware: KoiMiddleware = {
    name: "report",
    priority: 275,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      startedAt = Date.now();
      turnCount = 0;
      accumulator.reset();
      report = undefined;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const callStart = Date.now();
      let response: ModelResponse | undefined;
      let error: unknown;

      try {
        response = await next(request);
        return response;
      } catch (e: unknown) {
        error = e;
        accumulator.recordIssue({
          severity: "critical",
          message: e instanceof Error ? e.message : String(e),
          turnIndex: ctx.turnIndex,
          resolved: false,
        });
        throw e;
      } finally {
        const durationMs = Date.now() - callStart;
        const action: ActionEntry = {
          kind: "model_call",
          name: request.model ?? "unknown",
          turnIndex: ctx.turnIndex,
          durationMs,
          success: error === undefined,
          errorMessage: error instanceof Error ? error.message : undefined,
          tokenUsage: response?.usage,
        };
        accumulator.recordAction(action);
        if (response?.usage) {
          accumulator.addTokens(response.usage.inputTokens, response.usage.outputTokens);
        }
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const callStart = Date.now();
      let error: unknown;
      let streamInputTokens = 0;
      let streamOutputTokens = 0;

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "usage") {
            streamInputTokens += chunk.inputTokens;
            streamOutputTokens += chunk.outputTokens;
          }
          yield chunk;
        }
      } catch (e: unknown) {
        error = e;
        accumulator.recordIssue({
          severity: "critical",
          message: e instanceof Error ? e.message : String(e),
          turnIndex: ctx.turnIndex,
          resolved: false,
        });
        throw e;
      } finally {
        const durationMs = Date.now() - callStart;
        accumulator.recordAction({
          kind: "model_call",
          name: request.model ?? "unknown",
          turnIndex: ctx.turnIndex,
          durationMs,
          success: error === undefined,
          errorMessage: error instanceof Error ? error.message : undefined,
          tokenUsage:
            streamInputTokens > 0 || streamOutputTokens > 0
              ? {
                  inputTokens: streamInputTokens,
                  outputTokens: streamOutputTokens,
                }
              : undefined,
        });
        if (streamInputTokens > 0 || streamOutputTokens > 0) {
          accumulator.addTokens(streamInputTokens, streamOutputTokens);
        }
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const callStart = Date.now();
      let error: unknown;

      try {
        const response = await next(request);
        return response;
      } catch (e: unknown) {
        error = e;
        accumulator.recordIssue({
          severity: "warning",
          message: `Tool ${request.toolId} failed: ${e instanceof Error ? e.message : String(e)}`,
          turnIndex: ctx.turnIndex,
          resolved: false,
        });
        throw e;
      } finally {
        const durationMs = Date.now() - callStart;
        accumulator.recordAction({
          kind: "tool_call",
          name: request.toolId,
          turnIndex: ctx.turnIndex,
          durationMs,
          success: error === undefined,
          errorMessage: error instanceof Error ? error.message : undefined,
        });
      }
    },

    async onAfterTurn(_ctx: TurnContext): Promise<void> {
      turnCount += 1;

      if (config.onProgress) {
        const snap = accumulator.snapshot();
        const progress: ProgressSnapshot = {
          turnIndex: turnCount - 1,
          totalActions: snap.totalActions,
          inputTokens: snap.inputTokens,
          outputTokens: snap.outputTokens,
          totalTokens: snap.inputTokens + snap.outputTokens,
          issueCount: snap.issues.length,
          elapsedMs: Date.now() - startedAt,
          truncated: snap.truncated,
        };
        try {
          await config.onProgress(progress);
        } catch (e: unknown) {
          swallowError(e, {
            package: "middleware-report",
            operation: "onProgress",
          });
        }
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const completedAt = Date.now();
      const snap = accumulator.snapshot();
      const durationMs = completedAt - startedAt;

      const duration = {
        startedAt,
        completedAt,
        durationMs,
        totalTurns: turnCount,
        totalActions: snap.totalActions,
        truncated: snap.truncated,
      };

      let costEstimate: number | undefined;
      if (config.costProvider) {
        try {
          const snapshot = await config.costProvider();
          costEstimate = snapshot.estimatedCostUsd;
        } catch (e: unknown) {
          swallowError(e, {
            package: "middleware-report",
            operation: "costProvider",
          });
        }
      }

      const cost = {
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        totalTokens: snap.inputTokens + snap.outputTokens,
        estimatedCostUsd: costEstimate,
      };

      const reportData: ReportData = {
        objective: config.objective,
        actions: snap.actions,
        artifacts: snap.artifacts,
        issues: snap.issues,
        duration,
        cost,
      };

      let summary: string;
      let recommendations: readonly string[];

      if (config.summarizer) {
        try {
          let timerId: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            config.summarizer(reportData),
            new Promise<never>((_resolve, reject) => {
              timerId = setTimeout(
                () => reject(new Error("Summarizer timed out")),
                summarizerTimeoutMs,
              );
            }),
          ]).finally(() => {
            if (timerId !== undefined) {
              clearTimeout(timerId);
            }
          });
          summary = result.summary;
          recommendations = result.recommendations;
        } catch (e: unknown) {
          swallowError(e, {
            package: "middleware-report",
            operation: "summarizer",
          });
          summary = generateTemplateSummary(
            snap.totalActions,
            turnCount,
            durationMs,
            snap.inputTokens,
            snap.outputTokens,
            snap.issues,
          );
          recommendations = [];
        }
      } else {
        summary = generateTemplateSummary(
          snap.totalActions,
          turnCount,
          durationMs,
          snap.inputTokens,
          snap.outputTokens,
          snap.issues,
        );
        recommendations = [];
      }

      report = {
        agentId: toAgentId(ctx.agentId),
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        summary,
        objective: config.objective,
        duration,
        actions: snap.actions,
        artifacts: snap.artifacts,
        issues: snap.issues,
        cost,
        recommendations,
      };

      if (config.onReport) {
        try {
          const formatted = formatter(report);
          await config.onReport(report, formatted);
        } catch (e: unknown) {
          swallowError(e, {
            package: "middleware-report",
            operation: "onReport",
          });
        }
      }
    },
  };

  return {
    middleware,
    getReport: (): RunReport | undefined => report,
    getProgress: (): ProgressSnapshot => {
      const snap = accumulator.snapshot();
      return {
        turnIndex: turnCount > 0 ? turnCount - 1 : 0,
        totalActions: snap.totalActions,
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        totalTokens: snap.inputTokens + snap.outputTokens,
        issueCount: snap.issues.length,
        elapsedMs: startedAt > 0 ? Date.now() - startedAt : 0,
        truncated: snap.truncated,
      };
    },
  };
}
