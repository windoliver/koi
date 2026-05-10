import type { SpawnFn, SpawnRequest, SpawnResult } from "@koi/core";

export interface SpawnFitnessOutcome {
  readonly agentName: string;
  readonly description: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string | undefined;
}

export interface SpawnFitnessWrapperConfig {
  readonly recordOutcome: (outcome: SpawnFitnessOutcome) => Promise<void> | void;
  readonly now?: (() => number) | undefined;
}

function isErrorWithMessage(error: unknown): error is { readonly message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof Reflect.get(error, "message") === "string"
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown spawn error";
}

function recordOutcomeBestEffort(
  config: SpawnFitnessWrapperConfig,
  outcome: SpawnFitnessOutcome,
): Promise<void> {
  return Promise.resolve()
    .then(() => config.recordOutcome(outcome))
    .then(
      () => undefined,
      () => undefined,
    );
}

export function createSpawnFitnessWrapper(
  spawn: SpawnFn,
  config: SpawnFitnessWrapperConfig,
): SpawnFn {
  const now = config.now ?? Date.now;

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    const startedAt = now();
    try {
      const result = await spawn(request);
      const durationMs = now() - startedAt;
      void recordOutcomeBestEffort(config, {
        agentName: request.agentName,
        description: request.description,
        durationMs,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error.message }),
      });
      return result;
    } catch (error: unknown) {
      const durationMs = now() - startedAt;
      void recordOutcomeBestEffort(config, {
        agentName: request.agentName,
        description: request.description,
        durationMs,
        ok: false,
        error: getErrorMessage(error),
      });
      throw error;
    }
  };
}
