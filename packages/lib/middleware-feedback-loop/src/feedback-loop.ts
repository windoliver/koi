import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { ModelChunk } from "@koi/core/middleware";

type ModelCallCtx = Parameters<NonNullable<KoiMiddleware["wrapModelCall"]>>[0];
type ToolCallCtx = Parameters<NonNullable<KoiMiddleware["wrapToolCall"]>>[0];

import { KoiRuntimeError } from "@koi/errors";
import type { FeedbackLoopConfig } from "./config.js";
import { defaultRepairStrategy } from "./repair.js";
import { runWithRetry } from "./retry.js";
import type { ToolHealthTracker } from "./tool-health.js";
import { createToolHealthTracker } from "./tool-health.js";
import type { ForgeToolErrorFeedback } from "./types.js";

const VALIDATION_DEFAULT_MAX_ATTEMPTS = 3;
const TRANSPORT_DEFAULT_MAX_ATTEMPTS = 2;

function hasModelChecks(config: FeedbackLoopConfig): boolean {
  return (
    (config.validators !== undefined && config.validators.length > 0) ||
    (config.gates !== undefined && config.gates.length > 0)
  );
}

function hasToolChecks(config: FeedbackLoopConfig): boolean {
  return (
    config.forgeHealth !== undefined ||
    (config.toolGates !== undefined && config.toolGates.length > 0)
  );
}

async function handleToolSuccess(
  toolId: string,
  response: ToolResponse,
  startMs: number,
  tracker: ToolHealthTracker | undefined,
  config: FeedbackLoopConfig,
): Promise<ToolResponse> {
  const latencyMs = Date.now() - startMs;

  // Gates run BEFORE health accounting — one invocation = exactly one health outcome
  if (config.toolGates !== undefined && config.toolGates.length > 0) {
    for (const gate of config.toolGates) {
      const result = await gate.validate(response);
      if (!result.valid) {
        const errors = result.errors ?? [];
        config.onGateFail?.(gate, errors);
        if (gate.countAsHealthFailure === true && tracker !== undefined) {
          tracker.recordFailure(toolId, latencyMs, `gate "${gate.name}" failed`);
          void tracker.checkAndQuarantine(toolId);
          void tracker.checkAndDemote(toolId);
        }
        throw KoiRuntimeError.from(
          "VALIDATION",
          `Gate "${gate.name}" rejected the tool response: ${errors.map((e) => e.message).join("; ")}`,
        );
      }
    }
  }

  if (tracker !== undefined) {
    tracker.recordSuccess(toolId, latencyMs);
    // Fire-and-forget: health I/O must not turn a successful tool call into a failure
    void tracker.checkAndQuarantine(toolId);
    void tracker.checkAndDemote(toolId);
  }

  return response;
}

function handleToolError(
  toolId: string,
  err: unknown,
  startMs: number,
  tracker: ToolHealthTracker | undefined,
): never {
  const latencyMs = Date.now() - startMs;

  if (tracker !== undefined) {
    tracker.recordFailure(toolId, latencyMs, String(err));
    // checkAndQuarantine/checkAndDemote are fire-and-forget here; errors surface via onHealthTransitionError
    void tracker.checkAndQuarantine(toolId);
    void tracker.checkAndDemote(toolId);
  }

  throw err;
}

/**
 * Creates a middleware that validates model responses and tracks tool health.
 *
 * - Model calls: runs validators + gates with automatic retry on validation failure.
 * - Tool calls: checks quarantine status, records health metrics, runs tool gates.
 * - Session lifecycle: creates/disposes a ToolHealthTracker when forgeHealth is configured.
 */
export function createFeedbackLoopMiddleware(config: FeedbackLoopConfig): KoiMiddleware {
  // Per-session tracker map: keyed by sessionId to isolate concurrent sessions
  const trackers = new Map<string, ToolHealthTracker>();

  return {
    name: "feedback-loop",
    priority: 450,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      if (config.forgeHealth !== undefined) {
        trackers.set(ctx.sessionId, createToolHealthTracker(config.forgeHealth));
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const tracker = trackers.get(ctx.sessionId);
      if (tracker !== undefined) {
        trackers.delete(ctx.sessionId);
        await tracker.dispose();
      }
    },

    async wrapModelCall(
      _ctx: ModelCallCtx,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (!hasModelChecks(config)) {
        return next(request);
      }

      return runWithRetry(request, next, {
        validators: config.validators ?? [],
        gates: config.gates ?? [],
        repairStrategy: config.repairStrategy ?? defaultRepairStrategy,
        validationMaxAttempts:
          config.retry?.validation?.maxAttempts ?? VALIDATION_DEFAULT_MAX_ATTEMPTS,
        transportMaxAttempts:
          config.retry?.transport?.maxAttempts ?? TRANSPORT_DEFAULT_MAX_ATTEMPTS,
        onRetry: config.onRetry,
        onGateFail: config.onGateFail,
      });
    },

    async *wrapModelStream(
      _ctx: ModelCallCtx,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (!hasModelChecks(config)) {
        yield* next(request);
        return;
      }

      // Buffer the full stream, then run validators + gates on the complete response.
      // On validation failure: repair and restart the stream (same semantics as wrapModelCall).
      // Buffering is necessary because validators operate on the complete ModelResponse.
      const validationMaxAttempts =
        config.retry?.validation?.maxAttempts ?? VALIDATION_DEFAULT_MAX_ATTEMPTS;
      const transportMaxAttempts =
        config.retry?.transport?.maxAttempts ?? TRANSPORT_DEFAULT_MAX_ATTEMPTS;
      const repairStrategy = config.repairStrategy ?? defaultRepairStrategy;

      let currentRequest = request;
      let feedbackMessageId: string | undefined;
      let validationAttempts = 0;
      let transportErrors = 0;

      while (true) {
        const buffer: ModelChunk[] = [];
        let finalResponse: ModelResponse | undefined;
        let transportError: unknown;

        try {
          for await (const chunk of next(currentRequest)) {
            buffer.push(chunk);
            if (chunk.kind === "done") {
              finalResponse = chunk.response;
            } else if (chunk.kind === "error" && chunk.retryable === true) {
              // Stream signalled a retryable transport error
              transportError = new Error(chunk.message);
              break;
            }
          }
        } catch (err: unknown) {
          transportError = err;
        }

        if (transportError !== undefined) {
          transportErrors++;
          if (transportErrors > transportMaxAttempts) throw transportError;
          config.onRetry?.(validationAttempts + transportErrors, []);
          continue; // restart stream without yielding buffered chunks
        }

        if (finalResponse === undefined) {
          // Stream ended without a done chunk — pass through whatever was buffered
          yield* buffer;
          return;
        }

        // Run validators on the complete response
        const { runValidators } = await import("./validators.js");
        const errors = await runValidators(config.validators ?? [], finalResponse);

        if (errors.length === 0) {
          // Run gates — throws on failure (we've consumed the stream so no partial output)
          const { runGates } = await import("./gate.js");
          await runGates(config.gates ?? [], finalResponse, config.onGateFail);
          yield* buffer;
          return;
        }

        validationAttempts++;
        if (validationAttempts >= validationMaxAttempts) {
          const { KoiRuntimeError } = await import("@koi/errors");
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Validation budget exhausted after ${validationMaxAttempts} attempt(s): ${errors.map((e) => e.message).join("; ")}`,
          );
        }

        config.onRetry?.(validationAttempts, errors);
        const built = repairStrategy.buildRetryRequest(currentRequest, errors, {
          attempt: validationAttempts,
          response: finalResponse,
          feedbackMessageId,
        });
        currentRequest = built.request;
        feedbackMessageId = built.feedbackMessageId;
      }
    },

    async wrapToolCall(
      ctx: ToolCallCtx,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!hasToolChecks(config)) {
        return next(request);
      }

      const tracker = trackers.get(ctx.session.sessionId);
      if (tracker !== undefined) {
        const brickId = config.forgeHealth?.resolveBrickId(request.toolId);
        if (brickId !== undefined && (await tracker.isQuarantined(request.toolId))) {
          const feedback: ForgeToolErrorFeedback = {
            kind: "forge_tool_quarantined",
            brickId,
            toolId: request.toolId,
            message: `Tool "${request.toolId}" is quarantined and cannot execute.`,
          };
          return { output: feedback };
        }
      }

      const startMs = Date.now();
      // Only wrap next() — gate throws from handleToolSuccess must not go through handleToolError
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (err: unknown) {
        return handleToolError(request.toolId, err, startMs, tracker);
      }
      return handleToolSuccess(request.toolId, response, startMs, tracker, config);
    },
  };
}
