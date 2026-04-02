/**
 * ATIF document store — TrajectoryDocumentStore backed by ATIF format.
 *
 * Safety invariants:
 *   - Atomic step ID allocation (assigned during append under per-doc lock)
 *   - Per-docId mutex serializes appends (prevents racy read-modify-write)
 *   - Size enforcement based on real serialized bytes (not estimates)
 *   - Idempotent appends via batch token dedup (safe for write-then-timeout retries)
 *   - Lock entries released after chain settles (no memory leak)
 *   - maxSteps eviction for smooth memory management
 */

import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { AtifExportOptions } from "./atif-mappers.js";
import { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./atif-mappers.js";
import type { AtifDocument, AtifStep } from "./atif-types.js";
import { ATIF_SCHEMA_VERSION } from "./atif-types.js";
import { pickDefined } from "./utils.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_STEPS = 500;

export interface AtifDocumentStoreConfig {
  /** Agent name for ATIF document metadata. */
  readonly agentName: string;
  /** Agent version for ATIF document metadata. */
  readonly agentVersion?: string;
  /** Maximum document size in bytes before pruning. Default: 10MB. */
  readonly maxSizeBytes?: number;
  /** Maximum number of steps to retain. Default: 500. Oldest steps dropped first. */
  readonly maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Delegate — pluggable persistence backend
// ---------------------------------------------------------------------------

/** Delegate interface for raw ATIF document persistence. */
export interface AtifDocumentDelegate {
  /** Read an ATIF document by ID. Returns undefined if not found. */
  readonly read: (docId: string) => Promise<AtifDocument | undefined>;
  /** Write an ATIF document by ID (full replace). */
  readonly write: (docId: string, doc: AtifDocument) => Promise<void>;
  /** List all document IDs. */
  readonly list: () => Promise<readonly string[]>;
  /** Delete a document by ID. Returns true if deleted. */
  readonly delete: (docId: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

/** Create an in-memory ATIF document store for testing. */
export function createInMemoryAtifDocumentStore(
  config: AtifDocumentStoreConfig,
): TrajectoryDocumentStore {
  return createAtifDocumentStore(config, createInMemoryAtifDelegate());
}

/** Create an in-memory delegate (exposed for testing). */
export function createInMemoryAtifDelegate(
  docs: Map<string, AtifDocument> = new Map(),
): AtifDocumentDelegate {
  return {
    async read(docId: string): Promise<AtifDocument | undefined> {
      return docs.get(docId);
    },
    async write(docId: string, doc: AtifDocument): Promise<void> {
      docs.set(docId, doc);
    },
    async list(): Promise<readonly string[]> {
      return [...docs.keys()];
    },
    async delete(docId: string): Promise<boolean> {
      return docs.delete(docId);
    },
  };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/** Create a TrajectoryDocumentStore backed by an ATIF document delegate. */
export function createAtifDocumentStore(
  config: AtifDocumentStoreConfig,
  delegate: AtifDocumentDelegate,
): TrajectoryDocumentStore {
  const maxSize = config.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;

  // Incremental size tracking: docId -> approximate byte size
  const sizeCache = new Map<string, number>();

  // Per-docId mutex: serializes append operations to prevent racy read-modify-write.
  const appendLocks = new Map<string, Promise<void>>();

  // Batch dedup: tracks the last successfully written batch token per docId.
  // If a retry sends the same batchToken, the append is a no-op (idempotent).
  const lastBatchToken = new Map<string, string>();

  function withAppendLock(lockDocId: string, fn: () => Promise<void>): Promise<void> {
    const prev = appendLocks.get(lockDocId) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      if (appendLocks.get(lockDocId) === next) {
        appendLocks.delete(lockDocId);
      }
    });
    appendLocks.set(lockDocId, next);
    return next;
  }

  function createEmptyDoc(docId: string): AtifDocument {
    return {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: docId,
      agent: {
        name: config.agentName,
        ...(config.agentVersion !== undefined ? { version: config.agentVersion } : {}),
      },
      steps: [],
    };
  }

  function getNextStepId(doc: AtifDocument): number {
    if (doc.steps.length === 0) return 0;
    // let: mutable accumulator for max search
    let maxId = 0;
    for (const step of doc.steps) {
      if (step.step_id > maxId) maxId = step.step_id;
    }
    return maxId + 1;
  }

  /** Compute the real serialized UTF-8 byte size of a document. */
  function computeDocSize(doc: AtifDocument): number {
    return new TextEncoder().encode(JSON.stringify(doc)).length;
  }

  return {
    async append(docId: string, steps: readonly RichTrajectoryStep[]): Promise<void> {
      if (steps.length === 0) return;

      // Generate a batch token for idempotent retries.
      // Token is based on step timestamps + count — unique per logical batch.
      const batchToken = steps
        .map((s) => `${String(s.stepIndex)}:${String(s.timestamp)}`)
        .join(",");
      if (lastBatchToken.get(docId) === batchToken) {
        // This exact batch was already written — skip (idempotent retry)
        return;
      }

      await withAppendLock(docId, async () => {
        // Re-check inside lock (another concurrent append may have written it)
        if (lastBatchToken.get(docId) === batchToken) return;

        const existing = await delegate.read(docId);
        const doc = existing ?? createEmptyDoc(docId);

        // Map steps to ATIF format
        const opts: AtifExportOptions = {
          sessionId: docId,
          agentName: config.agentName,
          ...pickDefined({ agentVersion: config.agentVersion }),
        };
        const tempDoc = mapRichTrajectoryToAtif(steps, opts);

        // Reassign step_id values atomically
        // let: mutable counter for step ID allocation
        let nextId = getNextStepId(doc);
        const reindexedSteps = tempDoc.steps.map((step) => {
          const reindexed = { ...step, step_id: nextId };
          nextId += 1;
          return reindexed;
        });

        // Merge + maxSteps eviction
        const mergedSteps = [...doc.steps, ...reindexedSteps];
        const evictedSteps =
          mergedSteps.length > maxSteps
            ? mergedSteps.slice(mergedSteps.length - maxSteps)
            : mergedSteps;

        // let: the document to write — may be pruned/truncated
        let toWrite: AtifDocument = { ...doc, steps: evictedSteps };

        // Enforce size cap using real serialized size (not estimates)
        // let: actual size for the size gate
        let actualSize = computeDocSize(toWrite);

        if (actualSize > maxSize) {
          if (toWrite.steps.length > 1) {
            // Binary search prune
            toWrite = pruneToSizeBinarySearch(toWrite, maxSize);
            actualSize = computeDocSize(toWrite);
          }
          // If still over (single oversized step, or pruning wasn't enough)
          if (actualSize > maxSize) {
            toWrite = truncateOversizedStep(toWrite, maxSize);
            actualSize = computeDocSize(toWrite);
          }
        }

        sizeCache.set(docId, actualSize);
        await delegate.write(docId, toWrite);

        // Mark batch as written — enables idempotent retry
        lastBatchToken.set(docId, batchToken);
      });
    },

    async getDocument(docId: string): Promise<readonly RichTrajectoryStep[]> {
      const doc = await delegate.read(docId);
      if (doc === undefined) return [];
      return mapAtifToRichTrajectory(doc);
    },

    async getStepRange(
      docId: string,
      startIndex: number,
      endIndex: number,
    ): Promise<readonly RichTrajectoryStep[]> {
      const doc = await delegate.read(docId);
      if (doc === undefined) return [];

      const allSteps = mapAtifToRichTrajectory(doc);
      return allSteps.filter((step) => step.stepIndex >= startIndex && step.stepIndex < endIndex);
    },

    async getSize(docId: string): Promise<number> {
      const cached = sizeCache.get(docId);
      if (cached !== undefined) return cached;

      const doc = await delegate.read(docId);
      if (doc === undefined) return 0;

      const size = computeDocSize(doc);
      sizeCache.set(docId, size);
      return size;
    },

    async prune(olderThanMs: number): Promise<number> {
      const docIds = await delegate.list();
      // let: mutable counter for pruned entries
      let pruned = 0;

      for (const docId of docIds) {
        try {
          const doc = await delegate.read(docId);
          if (doc === undefined) continue;

          const lastStep = doc.steps[doc.steps.length - 1];
          if (lastStep === undefined) continue;

          const lastTimestamp = new Date(lastStep.timestamp).getTime();
          if (lastTimestamp < olderThanMs) {
            await delegate.delete(docId);
            sizeCache.delete(docId);
            lastBatchToken.delete(docId);
            pruned += doc.steps.length;
          }
        } catch {
          // Per-doc resilience: skip failures and continue to next doc
        }
      }

      return pruned;
    },
  };
}

// ---------------------------------------------------------------------------
// Pruning helpers
// ---------------------------------------------------------------------------

function pruneToSizeBinarySearch(doc: AtifDocument, maxSize: number): AtifDocument {
  const steps = doc.steps;
  if (steps.length <= 1) return doc;

  // let: mutable binary search bounds
  let lo = 1;
  let hi = steps.length - 1;
  let bestStart = hi;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate: AtifDocument = { ...doc, steps: steps.slice(mid) };
    const size = new TextEncoder().encode(JSON.stringify(candidate)).length;

    if (size <= maxSize) {
      bestStart = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return { ...doc, steps: steps.slice(bestStart) };
}

/**
 * Truncate oversized fields on a document to fit within maxSize.
 * Progressively strips large fields until the document fits.
 */
function truncateOversizedStep(doc: AtifDocument, maxSize: number): AtifDocument {
  const step = doc.steps[doc.steps.length - 1];
  if (step === undefined) return doc;
  const otherSteps = doc.steps.slice(0, -1);

  const FIELD_LIMIT = 500;
  const SENTINEL = "...[truncated]";
  const truncated = { ...step } as Record<string, unknown>;

  // Truncate text fields
  for (const key of ["message", "reasoning_content"]) {
    if (key in truncated && typeof truncated[key] === "string") {
      const val = truncated[key] as string;
      if (val.length > FIELD_LIMIT * 2) truncated[key] = `${val.slice(0, FIELD_LIMIT)}${SENTINEL}`;
    }
  }

  // Truncate observation results
  if (truncated.observation !== undefined) {
    const obs = truncated.observation as { results?: readonly { content: string }[] };
    if (obs.results !== undefined) {
      truncated.observation = {
        results: obs.results.map((r) =>
          r.content.length > FIELD_LIMIT * 2
            ? { ...r, content: `${r.content.slice(0, FIELD_LIMIT)}${SENTINEL}` }
            : r,
        ),
      };
    }
  }

  // Truncate tool_calls arguments
  if ("tool_calls" in truncated && Array.isArray(truncated.tool_calls)) {
    truncated.tool_calls = (truncated.tool_calls as readonly Record<string, unknown>[]).map(
      (tc) => {
        if (tc.arguments !== undefined) {
          const argStr = JSON.stringify(tc.arguments);
          if (argStr.length > FIELD_LIMIT * 2) {
            return { ...tc, arguments: { _truncated: true, _originalSize: argStr.length } };
          }
        }
        return tc;
      },
    );
  }

  // Truncate extra/metadata
  if (truncated.extra !== undefined) {
    const extraStr = JSON.stringify(truncated.extra);
    if (extraStr.length > FIELD_LIMIT * 4) truncated.extra = { _truncated: true };
  }

  const candidate: AtifDocument = {
    ...doc,
    steps: [...otherSteps, truncated as unknown as AtifStep],
  };
  if (new TextEncoder().encode(JSON.stringify(candidate)).length <= maxSize) return candidate;

  // Aggressive strip: remove all optional content fields
  const stripped = { ...truncated };
  delete stripped.observation;
  delete stripped.extra;
  delete stripped.reasoning_content;
  if ("tool_calls" in stripped && Array.isArray(stripped.tool_calls)) {
    stripped.tool_calls = (stripped.tool_calls as readonly Record<string, unknown>[]).map((tc) => ({
      tool_call_id: tc.tool_call_id,
      function_name: tc.function_name,
    }));
  }

  return { ...doc, steps: [...otherSteps, stripped as unknown as AtifStep] };
}
