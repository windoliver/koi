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
import { runValidators } from "./validators.js";

/** Creates a feedback-loop middleware with validation, retry, and gate hooks. */
export function createFeedbackLoopMiddleware(config: FeedbackLoopConfig): KoiMiddleware {
  const validators = config.validators ?? [];
  const gates = config.gates ?? [];
  const toolValidators = config.toolValidators ?? [];
  const toolGates = config.toolGates ?? [];
  const repair = config.repairStrategy ?? defaultRepairStrategy;
  const retryLoop = createRetryLoop(config.retry ?? {});

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
      // Fast path: no tool validators and no tool gates
      if (toolValidators.length === 0 && toolGates.length === 0) {
        return next(request);
      }

      // Pre-flight: validate tool input before execution
      if (toolValidators.length > 0) {
        const inputResult = await runValidators(request.input, toolValidators, ctx);
        if (!inputResult.valid) {
          throw KoiRuntimeError.from("VALIDATION", "Tool input validation failed", {
            context: {
              toolId: request.toolId,
              errors: inputResult.errors.map((err) => ({
                validator: err.validator,
                message: err.message,
              })),
            },
          });
        }
      }

      const response = await next(request);

      // Post-flight: gate tool output
      if (toolGates.length > 0) {
        const outputResult = await runGates(response.output, toolGates, ctx);
        if (!outputResult.valid) {
          config.onGateFail?.(outputResult.failedGate, outputResult.errors);
          throw KoiRuntimeError.from(
            "VALIDATION",
            `Tool output gate "${outputResult.failedGate}" failed`,
            {
              context: {
                toolId: request.toolId,
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

      return response;
    },
  };
}
