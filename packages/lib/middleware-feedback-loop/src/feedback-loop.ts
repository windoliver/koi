import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

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
const TRANSPORT_DEFAULT_MAX_ATTEMPTS = 1;

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
    await tracker.checkAndQuarantine(toolId);
    await tracker.checkAndDemote(toolId);
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
  // let-binding: mutable session-scoped tracker (reset each session)
  let tracker: ToolHealthTracker | undefined;

  return {
    name: "feedback-loop",
    priority: 450,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },

    async onSessionStart(_ctx: SessionContext): Promise<void> {
      if (config.forgeHealth !== undefined) {
        tracker = createToolHealthTracker(config.forgeHealth);
      }
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      if (tracker !== undefined) {
        await tracker.dispose();
        tracker = undefined;
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

    async wrapToolCall(
      _ctx: ToolCallCtx,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!hasToolChecks(config)) {
        return next(request);
      }

      if (tracker !== undefined) {
        const brickId = config.forgeHealth?.resolveBrickId(request.toolId);
        if (brickId !== undefined && tracker.isQuarantined(request.toolId)) {
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
      try {
        const response = await next(request);
        return handleToolSuccess(request.toolId, response, startMs, tracker, config);
      } catch (err: unknown) {
        return handleToolError(request.toolId, err, startMs, tracker);
      }
    },
  };
}
