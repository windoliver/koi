/**
 * Report middleware — tracks all model/tool calls and produces RunReport.
 */

import type {
  ActionEntry,
  CapabilityFragment,
  IssueEntry,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  RunReport,
  SessionId,
  TurnContext,
} from "@koi/core";
import { agentId } from "@koi/core";
import { KoiRuntimeError, swallowError } from "@koi/errors";

import type { Accumulator } from "./accumulator.js";
import { createAccumulator } from "./accumulator.js";
import {
  DEFAULT_MAX_ACTIONS,
  DEFAULT_MAX_REPORTS,
  type ReportMiddlewareConfig,
  validateReportConfig,
} from "./config.js";
import { mapReportToMarkdown } from "./formatter.js";
import type { ProgressSnapshot, ReportHandle } from "./types.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface ReportSessionState {
  readonly accumulator: Accumulator;
  readonly startedAt: number;
  turnCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateTemplateSummary(
  totalActions: number,
  totalTurns: number,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  issueCount: number,
): string {
  const totalTokens = inputTokens + outputTokens;
  const parts = [
    `Completed ${String(totalActions)} actions across ${String(totalTurns)} turns in ${String(durationMs)}ms.`,
    `Used ${String(totalTokens)} tokens (${String(inputTokens)} input, ${String(outputTokens)} output).`,
  ];
  if (issueCount > 0) {
    parts.push(`${String(issueCount)} issues encountered.`);
  }
  return parts.join(" ");
}

function makeProgressSnapshot(state: ReportSessionState): ProgressSnapshot {
  const snap = state.accumulator.snapshot();
  return {
    turnIndex: state.turnCount,
    totalActions: snap.totalActions,
    inputTokens: snap.inputTokens,
    outputTokens: snap.outputTokens,
    totalTokens: snap.inputTokens + snap.outputTokens,
    issueCount: snap.issues.length,
    elapsedMs: Date.now() - state.startedAt,
    truncated: snap.truncated,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReportMiddleware(config?: ReportMiddlewareConfig): ReportHandle {
  if (config !== undefined) {
    const result = validateReportConfig(config);
    if (!result.ok) {
      throw KoiRuntimeError.from(result.error.code, result.error.message);
    }
  }

  const maxActions = config?.maxActions ?? DEFAULT_MAX_ACTIONS;
  const maxReports = config?.maxReports ?? DEFAULT_MAX_REPORTS;
  const formatter = config?.formatter ?? mapReportToMarkdown;
  const sessions = new Map<SessionId, ReportSessionState>();
  const reports = new Map<SessionId, RunReport>();

  const middleware: KoiMiddleware = {
    name: "report",
    priority: 275,
    phase: "observe",

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return undefined;
      const snap = state.accumulator.snapshot();
      const totalTokens = snap.inputTokens + snap.outputTokens;
      return {
        label: "report",
        description: `${String(snap.totalActions)} actions, ${String(totalTokens)} tokens used`,
      };
    },

    async onSessionStart(ctx) {
      sessions.set(ctx.sessionId, {
        accumulator: createAccumulator(maxActions),
        startedAt: Date.now(),
        turnCount: 0,
      });
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      const start = Date.now();

      try {
        const response = await next(request);

        if (state && response.usage) {
          state.accumulator.addTokens(response.usage.inputTokens, response.usage.outputTokens);
        }

        if (state) {
          const action: ActionEntry = {
            kind: "model_call",
            name: response.model,
            turnIndex: ctx.turnIndex,
            durationMs: Date.now() - start,
            success: true,
            tokenUsage: response.usage
              ? {
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                }
              : undefined,
          };
          state.accumulator.recordAction(action);
        }

        return response;
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);

        if (state) {
          const action: ActionEntry = {
            kind: "model_call",
            name: request.model ?? "unknown",
            turnIndex: ctx.turnIndex,
            durationMs: Date.now() - start,
            success: false,
            errorMessage,
          };
          state.accumulator.recordAction(action);

          const issue: IssueEntry = {
            severity: "critical",
            message: `Model call failed: ${errorMessage}`,
            turnIndex: ctx.turnIndex,
            resolved: false,
          };
          state.accumulator.recordIssue(issue);
        }

        throw e;
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId);
      const start = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      let modelName = request.model ?? "unknown";
      let failed = false;
      let errorMessage: string | undefined;

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "usage") {
            inputTokens += chunk.inputTokens;
            outputTokens += chunk.outputTokens;
          } else if (chunk.kind === "done") {
            modelName = chunk.response.model;
            if (chunk.response.usage) {
              // Prefer final usage if no incremental usage chunks were seen
              if (inputTokens === 0 && outputTokens === 0) {
                inputTokens = chunk.response.usage.inputTokens;
                outputTokens = chunk.response.usage.outputTokens;
              }
            }
          } else if (chunk.kind === "error") {
            failed = true;
            errorMessage = chunk.message;
            if (chunk.usage) {
              inputTokens += chunk.usage.inputTokens;
              outputTokens += chunk.usage.outputTokens;
            }
          }
          yield chunk;
        }
      } catch (e: unknown) {
        failed = true;
        errorMessage = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (state) {
          state.accumulator.addTokens(inputTokens, outputTokens);
          const action: ActionEntry = {
            kind: "model_call",
            name: modelName,
            turnIndex: ctx.turnIndex,
            durationMs: Date.now() - start,
            success: !failed,
            errorMessage,
            tokenUsage:
              inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : undefined,
          };
          state.accumulator.recordAction(action);

          if (failed && errorMessage) {
            const issue: IssueEntry = {
              severity: "critical",
              message: `Model stream failed: ${errorMessage}`,
              turnIndex: ctx.turnIndex,
              resolved: false,
            };
            state.accumulator.recordIssue(issue);
          }
        }
      }
    },

    async wrapToolCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      const start = Date.now();

      try {
        const response = await next(request);

        if (state) {
          const action: ActionEntry = {
            kind: "tool_call",
            name: request.toolId,
            turnIndex: ctx.turnIndex,
            durationMs: Date.now() - start,
            success: true,
          };
          state.accumulator.recordAction(action);
        }

        return response;
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);

        if (state) {
          const action: ActionEntry = {
            kind: "tool_call",
            name: request.toolId,
            turnIndex: ctx.turnIndex,
            durationMs: Date.now() - start,
            success: false,
            errorMessage,
          };
          state.accumulator.recordAction(action);

          const issue: IssueEntry = {
            severity: "warning",
            message: `Tool ${request.toolId} failed: ${errorMessage}`,
            turnIndex: ctx.turnIndex,
            resolved: false,
          };
          state.accumulator.recordIssue(issue);
        }

        throw e;
      }
    },

    async onAfterTurn(ctx) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;

      state.turnCount++;

      if (config?.onProgress) {
        const snap = makeProgressSnapshot(state);
        try {
          await config.onProgress(snap);
        } catch (e: unknown) {
          swallowError(e, { package: "@koi/middleware-report", operation: "onProgress" });
        }
      }
    },

    async onSessionEnd(ctx) {
      const state = sessions.get(ctx.sessionId);
      if (!state) return;

      const completedAt = Date.now();
      const snap = state.accumulator.snapshot();
      const durationMs = completedAt - state.startedAt;

      const summary = generateTemplateSummary(
        snap.totalActions,
        state.turnCount,
        durationMs,
        snap.inputTokens,
        snap.outputTokens,
        snap.issues.length,
      );

      const report: RunReport = {
        agentId: agentId(ctx.agentId),
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        summary,
        objective: config?.objective,
        duration: {
          startedAt: state.startedAt,
          completedAt,
          durationMs,
          totalTurns: state.turnCount,
          totalActions: snap.totalActions,
          truncated: snap.truncated,
        },
        actions: snap.actions,
        artifacts: snap.artifacts,
        issues: snap.issues,
        cost: {
          inputTokens: snap.inputTokens,
          outputTokens: snap.outputTokens,
          totalTokens: snap.inputTokens + snap.outputTokens,
        },
        recommendations: [],
      };

      reports.set(ctx.sessionId, report);

      // Evict oldest reports if exceeding retention limit
      if (reports.size > maxReports) {
        const oldest = reports.keys().next().value;
        if (oldest !== undefined) {
          reports.delete(oldest);
        }
      }

      if (config?.onReport) {
        const formatted = formatter(report);
        try {
          await config.onReport(report, formatted);
        } catch (e: unknown) {
          swallowError(e, { package: "@koi/middleware-report", operation: "onReport" });
        }
      }

      sessions.delete(ctx.sessionId);
    },
  };

  return {
    middleware,
    getReport(sid: SessionId): RunReport | undefined {
      return reports.get(sid);
    },
    getProgress(sid: SessionId): ProgressSnapshot {
      const state = sessions.get(sid);
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
      return makeProgressSnapshot(state);
    },
  };
}
