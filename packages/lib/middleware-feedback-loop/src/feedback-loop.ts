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

function hasTransportRetry(config: FeedbackLoopConfig): boolean {
  const maxAttempts = config.retry?.transport?.maxAttempts;
  return maxAttempts !== undefined && maxAttempts > 1;
}

function hasToolChecks(config: FeedbackLoopConfig): boolean {
  return (
    config.forgeHealth !== undefined ||
    (config.toolValidators !== undefined && config.toolValidators.length > 0) ||
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
      if (!hasModelChecks(config) && !hasTransportRetry(config)) {
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

    // Fail closed: when validators or gates are configured, streaming cannot be validated
    // (validators need a complete ModelResponse). Yield a non-retryable error so callers
    // get an explicit failure rather than a silent policy bypass. Callers that need
    // real-time streaming must leave validators/gates unconfigured and use wrapModelCall
    // for validated responses.
    async *wrapModelStream(
      _ctx: ModelCallCtx,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (hasModelChecks(config)) {
        yield {
          kind: "error",
          message:
            "Streaming is not supported when validators or gates are configured. Use wrapModelCall instead.",
          retryable: false,
        };
        return;
      }
      yield* next(request);
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
      if (tracker !== undefined && (await tracker.isQuarantined(request.toolId))) {
        const feedback: ForgeToolErrorFeedback = {
          kind: "forge_tool_quarantined",
          brickId: config.forgeHealth?.resolveBrickId(request.toolId),
          toolId: request.toolId,
          message: `Tool "${request.toolId}" is quarantined and cannot execute.`,
        };
        return { output: feedback };
      }

      // Pre-execution validation — fail closed before any side effects
      if (config.toolValidators !== undefined && config.toolValidators.length > 0) {
        const validationErrors: string[] = [];
        for (const validator of config.toolValidators) {
          const result = await validator.validate(request);
          if (!result.valid) {
            for (const e of result.errors ?? []) {
              validationErrors.push(`[${validator.name}] ${e.message}`);
            }
          }
        }
        if (validationErrors.length > 0) {
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Tool request validation failed for "${request.toolId}": ${validationErrors.join("; ")}`,
          );
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
