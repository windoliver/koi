/**
 * Middleware factory — creates the feedback-loop middleware instance.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolHandler,
  ToolHealthSnapshot,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { extractMessage, KoiRuntimeError } from "@koi/errors";
import type { FeedbackLoopConfig } from "./config.js";
import { runGates } from "./gate.js";
import { defaultRepairStrategy } from "./repair.js";
import { createRetryLoop, ValidationFailure } from "./retry.js";
import { createToolHealthTracker, type ToolHealthTracker } from "./tool-health.js";
import type { ForgeToolErrorFeedback } from "./types.js";
import { runValidators } from "./validators.js";

/** Handle returned by the feedback-loop factory — bundles middleware + health read API. */
export interface FeedbackLoopHandle {
  readonly middleware: KoiMiddleware;
  readonly getHealthSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  readonly getAllHealthSnapshots: () => readonly ToolHealthSnapshot[];
  readonly isQuarantined: (toolId: string) => boolean;
}

/** Creates a feedback-loop middleware with validation, retry, and gate hooks. */
export function createFeedbackLoopMiddleware(config: FeedbackLoopConfig): FeedbackLoopHandle {
  const validators = config.validators ?? [];
  const gates = config.gates ?? [];
  const toolValidators = config.toolValidators ?? [];
  const toolGates = config.toolGates ?? [];
  const repair = config.repairStrategy ?? defaultRepairStrategy;
  const retryLoop = createRetryLoop(config.retry ?? {});

  // Health tracking: only created when forgeHealth config is present
  const healthTracker: ToolHealthTracker | undefined = config.forgeHealth
    ? createToolHealthTracker(config.forgeHealth)
    : undefined;
  const healthClock = config.forgeHealth?.clock ?? Date.now;
  const resolveBrickId = config.forgeHealth?.resolveBrickId;

  const middleware: KoiMiddleware = {
    name: "feedback-loop",
    priority: 450,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "feedback",
      description:
        `Model validation (${String(validators.length)} validators, ${String(gates.length)} gates)` +
        (toolValidators.length > 0 || toolGates.length > 0
          ? `, tool validation (${String(toolValidators.length)} validators, ${String(toolGates.length)} gates)`
          : "") +
        (healthTracker !== undefined ? ", forge tool health tracking with quarantine" : ""),
    }),

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // Fast path: no validators and no gates → zero overhead pass-through
      if (validators.length === 0 && gates.length === 0) {
        return next(request);
      }

      const response = await retryLoop.execute(
        async (currentRequest) => {
          const resp = await next(currentRequest);
          if (validators.length === 0) return resp;

          const result = await runValidators(resp.content, validators, ctx);
          if (!result.valid) {
            throw new ValidationFailure(result.errors, resp);
          }
          return resp;
        },
        request,
        repair,
        config.onRetry,
      );

      // Gate check — no retry on failure
      if (gates.length > 0) {
        const gateResult = await runGates(response.content, gates, ctx);
        if (!gateResult.valid) {
          config.onGateFail?.(gateResult.failedGate, gateResult.errors);
          throw KoiRuntimeError.from("VALIDATION", `Gate "${gateResult.failedGate}" failed`, {
            context: {
              gate: gateResult.failedGate,
              errors: gateResult.errors.map((err) => ({
                validator: err.validator,
                message: err.message,
              })),
            },
          });
        }
      }

      return response;
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const { toolId } = request;
      const isForgedTool =
        healthTracker !== undefined &&
        resolveBrickId !== undefined &&
        resolveBrickId(toolId) !== undefined;

      // Fast path: no tool validators, no tool gates, and not a forged tool
      if (toolValidators.length === 0 && toolGates.length === 0 && !isForgedTool) {
        return next(request);
      }

      // --- Quarantine check (forged tools only, async to survive session boundaries) ---
      if (healthTracker !== undefined && (await healthTracker.isQuarantinedAsync(toolId))) {
        const snapshot = healthTracker.getSnapshot(toolId);
        const feedback: ForgeToolErrorFeedback = {
          error: `Tool "${toolId}" has been quarantined due to excessive failures`,
          errorRate: snapshot?.metrics.errorRate ?? 1,
          recentFailures: snapshot?.recentFailures ?? [],
          suggestion:
            "This tool has been permanently disabled. The agent must re-forge a replacement.",
        };
        return { output: feedback };
      }

      // --- Pre-flight: validate tool input before execution ---
      if (toolValidators.length > 0) {
        const inputResult = await runValidators(request.input, toolValidators, ctx);
        if (!inputResult.valid) {
          throw KoiRuntimeError.from("VALIDATION", "Tool input validation failed", {
            context: {
              toolId,
              errors: inputResult.errors.map((err) => ({
                validator: err.validator,
                message: err.message,
              })),
            },
          });
        }
      }

      // --- Execute with latency tracking ---
      const start = healthClock();
      // let: assigned inside try block, used after it (deferred init pattern)
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (e: unknown) {
        // Record failure for forged tools
        if (isForgedTool && healthTracker !== undefined) {
          const latencyMs = healthClock() - start;
          healthTracker.recordFailure(toolId, latencyMs, extractMessage(e));
          const quarantined = await healthTracker.checkAndQuarantine(toolId);
          if (!quarantined) {
            await healthTracker.checkAndDemote(toolId).catch((demotionErr: unknown) => {
              config.forgeHealth?.onDemotionError?.(toolId, demotionErr);
            });
          }
          maybeFlush(healthTracker, toolId, config.forgeHealth?.onFlushError);
        }
        throw e;
      }

      // --- Post-flight: gate tool output ---
      if (toolGates.length > 0) {
        const outputResult = await runGates(response.output, toolGates, ctx);
        if (!outputResult.valid) {
          // Gate failure counts as tool failure for health tracking
          if (isForgedTool && healthTracker !== undefined) {
            const latencyMs = healthClock() - start;
            healthTracker.recordFailure(
              toolId,
              latencyMs,
              `Gate "${outputResult.failedGate}" failed`,
            );
            const quarantined = await healthTracker.checkAndQuarantine(toolId);
            if (!quarantined) {
              await healthTracker.checkAndDemote(toolId).catch((demotionErr: unknown) => {
                config.forgeHealth?.onDemotionError?.(toolId, demotionErr);
              });
            }
            maybeFlush(healthTracker, toolId, config.forgeHealth?.onFlushError);
          }
          config.onGateFail?.(outputResult.failedGate, outputResult.errors);
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Tool output gate "${outputResult.failedGate}" failed`,
            {
              context: {
                toolId,
                gate: outputResult.failedGate,
                errors: outputResult.errors.map((err) => ({
                  validator: err.validator,
                  message: err.message,
                })),
              },
            },
          );
        }
      }

      // --- Record success for forged tools ---
      if (isForgedTool && healthTracker !== undefined) {
        const latencyMs = healthClock() - start;
        healthTracker.recordSuccess(toolId, latencyMs);
        maybeFlush(healthTracker, toolId, config.forgeHealth?.onFlushError);
      }

      return response;
    },
  };

  // Attach session lifecycle hook when health tracking is active
  const fullMiddleware: KoiMiddleware =
    healthTracker !== undefined
      ? {
          ...middleware,
          async onSessionEnd(_ctx: SessionContext): Promise<void> {
            await healthTracker.dispose();
          },
        }
      : middleware;

  return {
    middleware: fullMiddleware,
    getHealthSnapshot: (toolId: string): ToolHealthSnapshot | undefined =>
      healthTracker?.getSnapshot(toolId),
    getAllHealthSnapshots: (): readonly ToolHealthSnapshot[] =>
      healthTracker?.getAllSnapshots() ?? [],
    isQuarantined: (toolId: string): boolean => healthTracker?.isQuarantined(toolId) ?? false,
  };
}

/** Fire-and-forget flush check — errors routed to onFlushError callback. */
function maybeFlush(
  tracker: ToolHealthTracker,
  toolId: string,
  onFlushError: ((toolId: string, error: unknown) => void) | undefined,
): void {
  if (tracker.shouldFlushTool(toolId)) {
    tracker.flushTool(toolId).catch((e: unknown) => {
      onFlushError?.(toolId, e);
    });
  }
}
