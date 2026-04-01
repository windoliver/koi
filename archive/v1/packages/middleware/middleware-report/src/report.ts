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
import type { Accumulator } from "./accumulator.js";
import { createAccumulator } from "./accumulator.js";
import type { ProgressSnapshot, ReportConfig, ReportData } from "./config.js";
import { DEFAULT_MAX_ACTIONS, DEFAULT_SUMMARIZER_TIMEOUT_MS } from "./config.js";
import { mapReportToMarkdown } from "./formatters.js";
import type { ReportHandle } from "./types.js";

/** Per-session mutable state for the report middleware. */
interface ReportSessionState {
  readonly accumulator: Accumulator;
  readonly startedAt: number;
  readonly turnCount: number;
}

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
  const sessions = new Map<string, ReportSessionState>();
  const lastReports = new Map<string, RunReport>();

  const middleware: KoiMiddleware = {
    name: "report",
    priority: 275,
    describeCapabilities: (ctx: TurnContext): CapabilityFragment => {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) {
        return {
          label: "report",
          description: "Run report tracking: no active session",
        };
      }
      const snap = state.accumulator.snapshot();
      const tokens = snap.inputTokens + snap.outputTokens;
      return {
        label: "report",
        description: `Run report tracking: ${String(snap.totalActions)} actions, ${String(tokens)} tokens, ${String(snap.issues.length)} issues across ${String(state.turnCount)} turns`,
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, {
        accumulator: createAccumulator(maxActions),
        startedAt: Date.now(),
        turnCount: 0,
      });
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return next(request);

      const callStart = Date.now();
      let response: ModelResponse | undefined;
      let error: unknown;

      try {
        response = await next(request);
        return response;
      } catch (e: unknown) {
        error = e;
        state.accumulator.recordIssue({
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
        state.accumulator.recordAction(action);
        if (response?.usage) {
          state.accumulator.addTokens(response.usage.inputTokens, response.usage.outputTokens);
        }
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) {
        yield* next(request);
        return;
      }

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
          // Capture usage from done.response as fallback
          if (
            chunk.kind === "done" &&
            chunk.response.usage &&
            streamInputTokens === 0 &&
            streamOutputTokens === 0
          ) {
            streamInputTokens = chunk.response.usage.inputTokens;
            streamOutputTokens = chunk.response.usage.outputTokens;
          }
          yield chunk;
        }
      } catch (e: unknown) {
        error = e;
        state.accumulator.recordIssue({
          severity: "critical",
          message: e instanceof Error ? e.message : String(e),
          turnIndex: ctx.turnIndex,
          resolved: false,
        });
        throw e;
      } finally {
        const durationMs = Date.now() - callStart;
        state.accumulator.recordAction({
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
          state.accumulator.addTokens(streamInputTokens, streamOutputTokens);
        }
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return next(request);

      const callStart = Date.now();
      let error: unknown;

      try {
        const response = await next(request);
        return response;
      } catch (e: unknown) {
        error = e;
        state.accumulator.recordIssue({
          severity: "warning",
          message: `Tool ${request.toolId} failed: ${e instanceof Error ? e.message : String(e)}`,
          turnIndex: ctx.turnIndex,
          resolved: false,
        });
        throw e;
      } finally {
        const durationMs = Date.now() - callStart;
        state.accumulator.recordAction({
          kind: "tool_call",
          name: request.toolId,
          turnIndex: ctx.turnIndex,
          durationMs,
          success: error === undefined,
          errorMessage: error instanceof Error ? error.message : undefined,
        });
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return;

      const newTurnCount = state.turnCount + 1;
      sessions.set(ctx.session.sessionId as string, {
        ...state,
        turnCount: newTurnCount,
      });

      if (config.onProgress) {
        const snap = state.accumulator.snapshot();
        const progress: ProgressSnapshot = {
          turnIndex: newTurnCount - 1,
          totalActions: snap.totalActions,
          inputTokens: snap.inputTokens,
          outputTokens: snap.outputTokens,
          totalTokens: snap.inputTokens + snap.outputTokens,
          issueCount: snap.issues.length,
          elapsedMs: Date.now() - state.startedAt,
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
      const state = sessions.get(ctx.sessionId as string);
      if (!state) return;

      const completedAt = Date.now();
      const snap = state.accumulator.snapshot();
      const durationMs = completedAt - state.startedAt;

      const duration = {
        startedAt: state.startedAt,
        completedAt,
        durationMs,
        totalTurns: state.turnCount,
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
            state.turnCount,
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
          state.turnCount,
          durationMs,
          snap.inputTokens,
          snap.outputTokens,
          snap.issues,
        );
        recommendations = [];
      }

      const report: RunReport = {
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
      lastReports.set(ctx.sessionId as string, report);

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

      // Clean up session state
      sessions.delete(ctx.sessionId as string);
    },
  };

  return {
    middleware,
    getReport: (sessionId?: string): RunReport | undefined => {
      if (sessionId) return lastReports.get(sessionId);
      const entries = [...lastReports.values()];
      return entries.length > 0 ? entries[entries.length - 1] : undefined;
    },
    getProgress: (sessionId?: string): ProgressSnapshot => {
      const state = sessionId ? sessions.get(sessionId) : [...sessions.values()].pop();
      if (!state) {
        return {
          turnIndex: 0,
          totalActions: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          issueCount: 0,
          elapsedMs: 0,
          truncated: false,
        };
      }
      const snap = state.accumulator.snapshot();
      return {
        turnIndex: state.turnCount > 0 ? state.turnCount - 1 : 0,
        totalActions: snap.totalActions,
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        totalTokens: snap.inputTokens + snap.outputTokens,
        issueCount: snap.issues.length,
        elapsedMs: state.startedAt > 0 ? Date.now() - state.startedAt : 0,
        truncated: snap.truncated,
      };
    },
  };
}
