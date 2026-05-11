export type CheckpointPhase = "in_progress" | "completed" | "failed";

/**
 * JSON-serializable value type for checkpoint payloads. Constrained so
 * future durable backends (Temporal, SQLite, Redis) can persist
 * snapshots without runtime serialization surprises.
 */
export type CheckpointValue =
  | string
  | number
  | boolean
  | null
  | readonly CheckpointValue[]
  | { readonly [key: string]: CheckpointValue };

/**
 * Codec converting an arbitrary executor step output into a
 * `CheckpointValue`. Returns `{ ok: true, value }` on success or
 * `{ ok: false, error }` to surface a save-time failure to the caller
 * (rather than throwing). Hosts wire this so the executor — whose
 * `CompositionStepResult.output` is `unknown` — can persist progress
 * without aborting on, e.g., a `Date`, `Map`, or class instance.
 *
 * The package ships `safeJsonEncoder` as a default that round-trips
 * through `JSON.parse(JSON.stringify(...))`, accepts the JSON subset
 * (objects, arrays, strings, finite numbers, booleans, null), drops
 * `undefined`/functions/symbols silently (matching `JSON.stringify`),
 * and rejects cycles, `NaN`/`Infinity`, and BigInt.
 */
export interface CheckpointEncoder {
  readonly encode: (
    value: unknown,
  ) => { ok: true; value: CheckpointValue } | { ok: false; error: string };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`non-finite number (${String(value)}) is not JSON-serializable`);
  }
  if (typeof value === "bigint") {
    throw new Error("bigint is not JSON-serializable");
  }
  return value;
}

export const safeJsonEncoder: CheckpointEncoder = {
  encode: (value) => {
    try {
      const json = JSON.stringify(value, jsonReplacer);
      if (json === undefined) {
        // top-level undefined / function / symbol
        return {
          ok: false,
          error: "value is not JSON-serializable (undefined / function / symbol)",
        };
      }
      return { ok: true, value: JSON.parse(json) as CheckpointValue };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : "JSON encode failed" };
    }
  },
};

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
   * MUST equal `nextStepIndex`. On `save`, each entry is passed through
   * the configured encoder (default: `safeJsonEncoder`) which converts
   * arbitrary executor `unknown` outputs into `CheckpointValue` — so
   * hosts can pass raw step results without pre-sanitizing. On `load`,
   * results are returned as `CheckpointValue[]` (already encoded).
   */
  readonly stepResults: readonly unknown[];
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
  /**
   * Enumerate stored snapshots. The primary restart-recovery primitive:
   * after a crash the host typically does NOT know which execution ids
   * were in flight, so it cannot use `load(id)` directly. `list()` gives
   * the host an authoritative inventory so it can re-trigger or
   * reconcile each surviving execution. Implementations MAY return them
   * in any order. Hosts that only care about in-flight work should
   * filter by `phase === "in_progress"` (or `"failed"`); a successful
   * execution has already been `delete()`d by the executor.
   *
   * Optional for backward compatibility with hosts that wired an
   * existing store before enumeration was part of the contract. Hosts
   * that need restart recovery MUST implement it; hosts that only do
   * keyed lookup (e.g. workflow engines that track executionId
   * externally, such as Temporal) MAY omit it. Callers should feature-
   * detect via `typeof store.list === "function"` before relying on it.
   * Both backends shipped in this package (`createInMemoryCheckpointStore`,
   * `sqliteCompositionCheckpointStore`) implement it.
   */
  readonly list?: () => readonly CheckpointSnapshot[] | Promise<readonly CheckpointSnapshot[]>;
}

function isCheckpointValue(value: unknown, ancestors: Set<unknown>): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (t === "function" || t === "undefined" || t === "symbol" || t === "bigint") return false;
  if (typeof value !== "object") return false;
  // Cycle detection: only the current recursion path counts as a cycle.
  // A repeated reference in sibling positions of an acyclic graph is valid
  // JSON-serializable data and must be accepted.
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isCheckpointValue(item, ancestors)) return false;
      }
      return true;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return false; // class instance, Error, etc.
    for (const key of Object.keys(value)) {
      if (!isCheckpointValue((value as Record<string, unknown>)[key], ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
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

export interface InMemoryCheckpointStoreConfig {
  /**
   * Optional encoder applied to each `stepResults[i]` BEFORE structural
   * validation. Lets executors hand in `unknown` outputs (Date, Map, class
   * instances, etc.) and have the store sanitize them via the configured
   * codec instead of throwing. Defaults to `safeJsonEncoder` (JSON
   * round-trip) — set to `null` to opt out and require pre-encoded
   * `CheckpointValue` inputs (legacy strict behavior).
   */
  readonly encoder?: CheckpointEncoder | null;
}

export function createInMemoryCheckpointStore(
  config: InMemoryCheckpointStoreConfig = {},
): CompositionCheckpointStore {
  const encoder = config.encoder === undefined ? safeJsonEncoder : config.encoder;
  const snapshots = new Map<string, CheckpointSnapshot>();

  function encodeStepResults(stepResults: readonly unknown[]): readonly CheckpointValue[] {
    if (encoder === null) return stepResults as readonly CheckpointValue[];
    const out: CheckpointValue[] = [];
    for (let i = 0; i < stepResults.length; i++) {
      const result = encoder.encode(stepResults[i]);
      if (!result.ok) {
        throw new Error(`stepResults[${i}] could not be encoded: ${result.error}`);
      }
      out.push(result.value);
    }
    return out;
  }

  return {
    save: (snapshot) => {
      // Encode first so executor `unknown` outputs are sanitized before
      // structural validation. validateSnapshot still enforces invariants
      // (length match, non-empty ids, valid index, no cycles in encoded
      // result) so opting out of the encoder still yields safe storage.
      const encoded: CheckpointSnapshot = {
        ...snapshot,
        stepResults: encodeStepResults(snapshot.stepResults),
      };
      validateSnapshot(encoded);
      // Defensive deep-clone so post-save mutation of the caller's object
      // (or its nested objects/arrays) cannot rewrite persisted state.
      // Validation has already proven the snapshot is JSON-serializable.
      snapshots.set(encoded.executionId, structuredClone(encoded));
    },
    load: (id) => {
      const stored = snapshots.get(id);
      // Defensive deep-clone on read so callers cannot mutate persisted
      // state by editing the returned reference's nested fields.
      return stored === undefined ? undefined : structuredClone(stored);
    },
    delete: (id) => {
      snapshots.delete(id);
    },
    list: () => {
      const out: CheckpointSnapshot[] = [];
      for (const stored of snapshots.values()) {
        out.push(structuredClone(stored));
      }
      return out;
    },
  };
}
