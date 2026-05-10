import type { JsonValue } from "@koi/core";

export type CheckpointPhase = "in_progress" | "completed" | "failed";

export interface CheckpointSnapshot {
  readonly executionId: string;
  /**
   * Stable hash of the plan being executed. On `load`, the executor
   * compares this with the hash of its current plan and discards the
   * snapshot if they diverge (plan rewritten between attempts).
   */
  readonly planHash: string;
  /**
   * Index of the NEXT step to execute. `0` = nothing run yet.
   * `plan.steps.length` = all steps complete.
   */
  readonly nextStepIndex: number;
  /**
   * Results of steps already executed, in order. `stepResults.length`
   * MUST equal `nextStepIndex`.
   */
  readonly stepResults: readonly JsonValue[];
  readonly phase: CheckpointPhase;
  /**
   * Wall-clock from injected `now()` at the time of save. Useful for
   * stale-snapshot detection by callers (executor decides policy).
   */
  readonly savedAt: number;
}

export interface CompositionCheckpointStore {
  readonly save: (snapshot: CheckpointSnapshot) => void | Promise<void>;
  readonly load: (
    executionId: string,
  ) => CheckpointSnapshot | undefined | Promise<CheckpointSnapshot | undefined>;
  readonly delete: (executionId: string) => void | Promise<void>;
}

function validateSnapshot(snapshot: CheckpointSnapshot): void {
  if (snapshot.executionId === "") {
    throw new Error("executionId must be non-empty");
  }
  if (snapshot.planHash === "") {
    throw new Error("planHash must be non-empty");
  }
  if (snapshot.nextStepIndex < 0 || !Number.isInteger(snapshot.nextStepIndex)) {
    throw new Error("nextStepIndex must be >= 0 and an integer");
  }
  if (snapshot.stepResults.length !== snapshot.nextStepIndex) {
    throw new Error(
      `stepResults.length must equal nextStepIndex (got ${snapshot.stepResults.length} vs ${snapshot.nextStepIndex})`,
    );
  }
}

export function createInMemoryCheckpointStore(): CompositionCheckpointStore {
  const snapshots = new Map<string, CheckpointSnapshot>();
  return {
    save: (snapshot) => {
      validateSnapshot(snapshot);
      snapshots.set(snapshot.executionId, snapshot);
    },
    load: (id) => snapshots.get(id),
    delete: (id) => {
      snapshots.delete(id);
    },
  };
}
