/**
 * Middleware factory — creates the feedback-loop middleware instance.
 */

import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { FeedbackLoopConfig } from "./config.js";
import { runGates } from "./gate.js";
import { defaultRepairStrategy } from "./repair.js";
import { createRetryLoop, ValidationFailure } from "./retry.js";
import { createToolHealthTracker, type ToolHealthTracker } from "./tool-health.js";
import type { ForgeToolErrorFeedback } from "./types.js";
import { runValidators } from "./validators.js";

/** Creates a feedback-loop middleware with validation, retry, and gate hooks. */
export function createFeedbackLoopMiddleware(config: FeedbackLoopConfig): KoiMiddleware {
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

  return {
    name: "feedback-loop",
    priority: 450,

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

      // --- Quarantine check (forged tools only) ---
      if (healthTracker?.isQuarantined(toolId)) {
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
          healthTracker.recordFailure(
            toolId,
            latencyMs,
            e instanceof Error ? e.message : String(e),
          );
          await healthTracker.checkAndQuarantine(toolId);
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
            await healthTracker.checkAndQuarantine(toolId);
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
      }

      return response;
    },
  };
}
