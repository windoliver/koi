import type { KoiError, Result } from "@koi/core";
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

function assertOk(result: Result<void, KoiError>): void {
  if (!result.ok) {
    throw result.error;
  }
}

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  const middleware = Object.freeze([
    parts.harness.createMiddleware(),
    ...(parts.extraMiddleware ?? []),
  ]);

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware: () => middleware,
    dispose: async () => {
      let schedulerError: unknown;

      try {
        await parts.scheduler.dispose();
      } catch (error) {
        schedulerError = error;
      }

      try {
        assertOk(await parts.harness.dispose());
      } catch (error) {
        if (schedulerError !== undefined) {
          throw new AggregateError(
            [schedulerError, error],
            "autonomous dispose failed during scheduler and harness cleanup",
          );
        }
        throw error;
      }

      if (schedulerError !== undefined) {
        throw schedulerError;
      }
    },
    agentResolver: parts.agentResolver,
  };
}
