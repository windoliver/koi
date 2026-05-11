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
  /**
   * Monotonic version stamped by the producer. Backends MUST refuse to
   * commit a `save` whose `seq` is less than or equal to the stored row's
   * `seq` for the same `executionId` — guards against a slow/abandoned
   * write completing after a newer save or `delete()` and resurrecting
   * stale state. Optional for backward compatibility; when omitted on
   * save, backends treat the write as last-writer-wins (legacy behavior).
   * The executor stamps each emitted snapshot with a strictly increasing
   * counter so its serialized writes are always ordered at the backend
   * even when the in-process chain has been reset after a timeout.
   */
  readonly seq?: number;
}

export interface CompositionCheckpointStore {
  readonly save: (snapshot: CheckpointSnapshot) => void | Promise<void>;
  readonly load: (
    executionId: string,
  ) => CheckpointSnapshot | undefined | Promise<CheckpointSnapshot | undefined>;
  /**
   * Delete the snapshot for an executionId. Optional `seq` lets the
   * caller carry the high-watermark into the deletion so a stale save
   * arriving AFTER this delete cannot resurrect the execution by
   * inserting a fresh row. Backends honoring seq SHOULD persist a
   * tombstone at the supplied seq even if no row currently exists for
   * this id. Callers that omit `seq` get last-writer-wins delete
   * semantics (legacy behavior).
   */
  readonly delete: (executionId: string, seq?: number) => void | Promise<void>;
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
  /**
   * Capability flag declaring that this store rejects stale writes via
   * the `seq` watermark — versioned saves drop when `seq <= stored.seq`,
   * versioned deletes leave a tombstone that blocks late saves at
   * `seq <= tombstone.seq`. Both built-in backends set this `true`.
   *
   * The executor uses this to decide whether it is safe to reset its
   * internal store-op chain after a `withTimeout` stall: a chain reset
   * lets the abandoned op race ahead of subsequent writes, which is
   * only safe when the store rejects out-of-order commits. Custom
   * stores that don't honor `seq` must leave this `undefined` / `false`
   * — the executor then keeps the chain serialized so a late save
   * cannot resurrect terminal state.
   */
  readonly seqAware?: boolean;
  /**
   * Return the highest `seq` ever observed for `executionId`, INCLUDING
   * tombstones from versioned deletes. `load()` intentionally hides
   * tombstone rows so a deleted execution looks gone — but the seq
   * watermark from that delete is still authoritative for ordering.
   * The executor uses this on first save/delete to seed its in-process
   * seq counter so a reused `executionId` whose tombstone watermark
   * exceeds wall-clock `now()` (NTP rollback, clock-skewed restart,
   * very large prior seq) does not silently emit writes that the store
   * guard then drops.
   *
   * Optional: stores that don't expose tombstones can omit this. The
   * executor falls back to `load(id)?.seq`, which works for in-progress
   * snapshots but cannot recover the watermark after a terminal delete.
   * Both built-in backends implement it.
   *
   * Returns `undefined` when no watermark exists for `executionId`.
   */
  readonly getWatermark?: (executionId: string) => number | undefined | Promise<number | undefined>;
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

  // Per-id high-watermark of the `seq` ever observed on save() or delete().
  // Guards against a slow/abandoned save committing AFTER a newer save or a
  // delete on the same execution, which would otherwise resurrect stale
  // state. Tombstones (deleted executions) keep their watermark so a late
  // save with an older seq is rejected.
  const seqWatermarks = new Map<string, number>();

  return {
    save: (snapshot) => {
      // Stale-write guard: drop if a strictly-newer write was already
      // observed for this executionId.
      if (snapshot.seq !== undefined) {
        const hw = seqWatermarks.get(snapshot.executionId);
        if (hw !== undefined && snapshot.seq <= hw) {
          // Late write — silently drop to preserve recovery correctness.
          return;
        }
        // NOTE: do NOT advance the watermark yet — encode/validate may
        // throw below. Advancing pre-validation would let a single bad
        // payload permanently suppress later legitimate saves at
        // <= snapshot.seq, hiding real progress and breaking restart
        // visibility. Watermark is committed only after the snapshot
        // actually lands in `snapshots`.
      } else if (seqWatermarks.has(snapshot.executionId)) {
        // Mixed-version writer guard, mirroring the SQLite backend's
        // `WHERE tombstone = 0 AND seq IS NULL` UPSERT clause. Once any
        // versioned write or versioned delete has claimed this row, an
        // unversioned save() from a legacy/older caller in a rolling
        // deploy must NOT overwrite or resurrect it. Pure legacy rows
        // (no watermark ever set) still accept last-writer-wins.
        return;
      }
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
      // Watermark commit happens only after the snapshot actually
      // persisted — a thrown encode/validate above leaves the previous
      // watermark intact so retrying with a fixed payload succeeds.
      if (snapshot.seq !== undefined) {
        seqWatermarks.set(snapshot.executionId, snapshot.seq);
      }
    },
    load: (id) => {
      const stored = snapshots.get(id);
      // Defensive deep-clone on read so callers cannot mutate persisted
      // state by editing the returned reference's nested fields.
      return stored === undefined ? undefined : structuredClone(stored);
    },
    delete: (id, seq) => {
      // Update the watermark before deleting the visible row so a late
      // save() with an older seq cannot resurrect the row by inserting
      // fresh. The watermark stays even after delete (tombstone). The
      // explicit `seq` parameter ensures the watermark is set even when
      // NO row exists yet — a timed-out save can finish later, and
      // without a pre-emptive watermark its insert would succeed.
      const stored = snapshots.get(id);
      const candidates: number[] = [];
      if (stored?.seq !== undefined) candidates.push(stored.seq);
      if (seq !== undefined) candidates.push(seq);
      if (candidates.length > 0) {
        const prev = seqWatermarks.get(id) ?? 0;
        seqWatermarks.set(id, Math.max(prev, ...candidates));
      }
      snapshots.delete(id);
    },
    list: () => {
      const out: CheckpointSnapshot[] = [];
      for (const stored of snapshots.values()) {
        out.push(structuredClone(stored));
      }
      return out;
    },
    seqAware: true,
    getWatermark: (id) => seqWatermarks.get(id),
  };
}
