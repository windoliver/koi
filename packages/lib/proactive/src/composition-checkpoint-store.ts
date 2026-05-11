export type CheckpointPhase = "in_progress" | "completed" | "failed";

/**
 * JSON-serializable value type for checkpoint payloads. Constrained so
 * future durable backends (Temporal, SQLite, Redis) can persist
 * snapshots without runtime serialization surprises — `unknown` would
 * accept functions, Error instances, class instances, and cyclic
 * structures that the in-memory store can hold but a wire format
 * cannot.
 */
export type CheckpointValue =
  | string
  | number
  | boolean
  | null
  | readonly CheckpointValue[]
  | { readonly [key: string]: CheckpointValue };

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
   * MUST equal `nextStepIndex`. Validated at runtime to be JSON-serializable
   * (no functions, no Error instances, no cycles) so durable backends
   * can persist without surprises.
   */
  readonly stepResults: readonly CheckpointValue[];
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

function isCheckpointValue(value: unknown, seen: Set<unknown>): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (t === "function" || t === "undefined" || t === "symbol" || t === "bigint") return false;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false; // cycle
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isCheckpointValue(item, seen)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false; // class instance, Error, etc.
  for (const key of Object.keys(value)) {
    if (!isCheckpointValue((value as Record<string, unknown>)[key], seen)) return false;
  }
  return true;
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
  for (let i = 0; i < snapshot.stepResults.length; i++) {
    if (!isCheckpointValue(snapshot.stepResults[i], new Set())) {
      throw new Error(
        `stepResults[${i}] is not JSON-serializable (no functions, class instances, BigInt, Symbol, undefined, NaN/Infinity, or cycles)`,
      );
    }
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
