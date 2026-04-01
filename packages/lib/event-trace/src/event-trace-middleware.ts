import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  RichTrajectoryStep,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TrajectoryDocumentStore,
  TurnContext,
} from "@koi/core";
import type { AtifWriteBehindBuffer, WriteBehindBufferConfig } from "./atif-buffer.js";
import { createWriteBehindBuffer } from "./atif-buffer.js";

function omitUndefined<T>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Config & Handle
// ---------------------------------------------------------------------------

export interface EventTraceConfig {
  readonly store: TrajectoryDocumentStore;
  readonly clock?: () => number;
  readonly bufferConfig?: WriteBehindBufferConfig;
}

export interface EventTraceHandle {
  readonly middleware: KoiMiddleware;
  readonly getTrajectory: (sessionId: string) => Promise<readonly RichTrajectoryStep[]>;
  readonly getStepCount: (sessionId: string) => number;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  stepIndex: number;
  turnStartTime: number;
  readonly buffer: AtifWriteBehindBuffer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventTraceMiddleware(config: EventTraceConfig): EventTraceHandle {
  const { store } = config;
  const clock = config.clock ?? Date.now;
  const sessions = new Map<string, SessionState>();

  function getSession(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  function docId(sessionId: string): string {
    return `trace:${sessionId}`;
  }

  function recordStep(sessionId: string, step: RichTrajectoryStep): void {
    const session = getSession(sessionId);
    if (!session) return;
    session.buffer.append(docId(sessionId), step);
  }

  const middleware: KoiMiddleware = {
    name: "event-trace",
    priority: 100,
    phase: "observe",

    describeCapabilities() {
      return { label: "tracing", description: "Per-event trajectory recording" };
    },

    async onSessionStart(ctx: SessionContext) {
      const buffer = createWriteBehindBuffer(store, config.bufferConfig);
      sessions.set(ctx.sessionId, {
        stepIndex: 0,
        turnStartTime: clock(),
        buffer,
      });
    },

    async onSessionEnd(ctx: SessionContext) {
      const session = getSession(ctx.sessionId);
      if (session) {
        await session.buffer.flush();
        session.buffer.dispose();
        sessions.delete(ctx.sessionId);
      }
    },

    async onBeforeTurn(ctx: TurnContext) {
      const session = getSession(ctx.session.sessionId);
      if (session) {
        session.turnStartTime = clock();
      }
    },

    async onAfterTurn(ctx: TurnContext) {
      const session = getSession(ctx.session.sessionId);
      if (session) {
        await session.buffer.flush(docId(ctx.session.sessionId));
      }
    },

    async wrapModelCall(ctx: TurnContext, request: ModelRequest, next) {
      const session = getSession(ctx.session.sessionId);
      const startTime = clock();
      let response: ModelResponse | undefined;
      let outcome: "success" | "failure" = "success";

      try {
        response = await next(request);
        return response;
      } catch (err: unknown) {
        outcome = "failure";
        throw err;
      } finally {
        if (session) {
          const stepIndex = session.stepIndex++;
          const step: RichTrajectoryStep = omitUndefined({
            stepIndex,
            timestamp: startTime,
            source: "agent" as const,
            kind: "model_call" as const,
            identifier: request.model ?? "unknown",
            outcome,
            durationMs: clock() - startTime,
            request: { text: request.messages.map((m) => String(m.content ?? "")).join("\n") },
            response: response ? { text: response.content } : undefined,
            metrics: response?.usage
              ? {
                  promptTokens: response.usage.inputTokens,
                  completionTokens: response.usage.outputTokens,
                }
              : undefined,
          });
          recordStep(ctx.session.sessionId, step);
        }
      }
    },

    wrapModelStream(ctx: TurnContext, request: ModelRequest, next) {
      const session = getSession(ctx.session.sessionId);
      const startTime = clock();

      return {
        async *[Symbol.asyncIterator]() {
          let lastResponse: ModelResponse | undefined;
          let outcome: "success" | "failure" = "success";

          try {
            for await (const chunk of next(request)) {
              if (chunk.kind === "done") {
                lastResponse = chunk.response;
              }
              yield chunk;
            }
          } catch (err: unknown) {
            outcome = "failure";
            throw err;
          } finally {
            if (session) {
              const stepIndex = session.stepIndex++;
              const step: RichTrajectoryStep = omitUndefined({
                stepIndex,
                timestamp: startTime,
                source: "agent" as const,
                kind: "model_call" as const,
                identifier: request.model ?? "unknown",
                outcome,
                durationMs: clock() - startTime,
                response: lastResponse ? { text: lastResponse.content } : undefined,
                metrics: lastResponse?.usage
                  ? {
                      promptTokens: lastResponse.usage.inputTokens,
                      completionTokens: lastResponse.usage.outputTokens,
                    }
                  : undefined,
              });
              recordStep(ctx.session.sessionId, step);
            }
          }
        },
      } satisfies AsyncIterable<ModelChunk>;
    },

    async wrapToolCall(ctx: TurnContext, request: ToolRequest, next) {
      const session = getSession(ctx.session.sessionId);
      const startTime = clock();
      let response: ToolResponse | undefined;
      let outcome: "success" | "failure" = "success";

      try {
        response = await next(request);
        return response;
      } catch (err: unknown) {
        outcome = "failure";
        throw err;
      } finally {
        if (session) {
          const stepIndex = session.stepIndex++;
          const step: RichTrajectoryStep = omitUndefined({
            stepIndex,
            timestamp: startTime,
            source: "tool" as const,
            kind: "tool_call" as const,
            identifier: request.toolId,
            outcome,
            durationMs: clock() - startTime,
            request: { data: request.input },
            response: response ? { text: String(response.output) } : undefined,
          });
          recordStep(ctx.session.sessionId, step);
        }
      }
    },
  };

  return {
    middleware,

    async getTrajectory(sessionId: string) {
      // Flush pending before reading
      const session = getSession(sessionId);
      if (session) {
        await session.buffer.flush(docId(sessionId));
      }
      return store.getDocument(docId(sessionId));
    },

    getStepCount(sessionId: string) {
      return getSession(sessionId)?.stepIndex ?? 0;
    },
  };
}
