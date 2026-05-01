export type TaskVerdict = "verified" | "approved" | "failed";

export interface TaskOutcome {
  readonly traceId: string;
  readonly verdict: TaskVerdict;
  readonly turnCount: number;
  readonly toolCallCount: number;
}

export interface DistillationPolicyConfig {
  /** Minimum number of turns. Default 2 — single-turn traces lack procedural value. */
  readonly minTurns?: number;
  /** Minimum tool calls. Default 1 — text-only chats rarely yield reusable skills. */
  readonly minToolCalls?: number;
  /** Verdicts that pass the gate. Default ["verified", "approved"]. */
  readonly acceptedVerdicts?: readonly TaskVerdict[];
}

export interface DistillationPolicy {
  /** Returns true when the outcome qualifies for distillation. */
  readonly shouldDistill: (outcome: TaskOutcome) => boolean;
  /** Returns a one-line explanation suitable for telemetry / decision audit. */
  readonly explain: (outcome: TaskOutcome) => string;
}

const DEFAULT_ACCEPTED_VERDICTS: readonly TaskVerdict[] = ["verified", "approved"];

export function createDistillationPolicy(
  config: DistillationPolicyConfig = {},
): DistillationPolicy {
  const minTurns = config.minTurns ?? 2;
  const minToolCalls = config.minToolCalls ?? 1;
  const accepted = new Set<TaskVerdict>(config.acceptedVerdicts ?? DEFAULT_ACCEPTED_VERDICTS);

  return {
    shouldDistill: (outcome: TaskOutcome): boolean => {
      if (!accepted.has(outcome.verdict)) return false;
      if (outcome.turnCount < minTurns) return false;
      if (outcome.toolCallCount < minToolCalls) return false;
      return true;
    },
    explain: (outcome: TaskOutcome): string => {
      if (!accepted.has(outcome.verdict)) {
        return `rejected: verdict ${outcome.verdict} not in accepted set`;
      }
      if (outcome.turnCount < minTurns) {
        return `rejected: turnCount ${outcome.turnCount} < minTurns ${minTurns}`;
      }
      if (outcome.toolCallCount < minToolCalls) {
        return `rejected: toolCallCount ${outcome.toolCallCount} < minToolCalls ${minToolCalls}`;
      }
      return `accepted: verdict=${outcome.verdict} turns=${outcome.turnCount} tools=${outcome.toolCallCount}`;
    },
  };
}
