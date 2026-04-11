/**
 * Parallel fetch + classification for the three ledger sinks.
 *
 * Each fetch outcome is normalized into a `{status, records}` pair so the
 * caller can assemble the ledger without knowing about Promise.allSettled.
 *
 * Invariant: a single sink failure never poisons the others. Per-sink errors
 * are surfaced via SourceStatus, not by throwing.
 *
 * Session-integrity filtering: audit and report sinks return session-scoped
 * data, but we re-validate that every returned record actually carries the
 * requested sessionId before including it. A buggy sink, stale index, or
 * over-broad backend read must not leak another session's decision data out
 * through this diagnostic surface.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import { sessionId as brandSessionId } from "@koi/core/ecs";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { ReportStore, RunReport } from "@koi/core/run-report";
import { externalError } from "./errors.js";
import type { SourceStatus, TrajectoryReader } from "./types.js";

export interface TrajectoryFetch {
  readonly status: SourceStatus;
  readonly records: readonly RichTrajectoryStep[];
  /**
   * Raw record count from the sink before any post-processing. Used by
   * the ledger's soft-ceiling check to detect oversized responses even
   * when most records are dropped by downstream filtering.
   */
  readonly rawCount: number;
}

export interface AuditFetch {
  readonly status: SourceStatus;
  readonly records: readonly AuditEntry[];
  /**
   * Count of records dropped by the session-integrity filter for this
   * fetch. Covers both partial leaks (some matched, some didn't) and
   * full violations (all dropped). Zero for clean fetches and for
   * fetches where the sink returned nothing at all.
   */
  readonly integrityFilteredCount: number;
  /** Raw record count returned by the sink before integrity filtering. */
  readonly rawCount: number;
}

export interface ReportFetch {
  readonly status: SourceStatus;
  readonly latest: RunReport | undefined;
  readonly integrityFilteredCount: number;
  readonly rawCount: number;
}

export async function fetchTrajectory(
  store: TrajectoryReader,
  sessionId: string,
): Promise<TrajectoryFetch> {
  try {
    const raw = await store.getDocument(sessionId);
    if (raw.length === 0) {
      return { status: { state: "missing" }, records: [], rawCount: 0 };
    }
    // Trajectory records have no sessionId field — the store's keying IS
    // the session identity, and trust is store-authoritative. We deliberately
    // use the `present-unverified` discriminant (NOT `present`) so that a
    // caller switching only on `state === "present"` cannot mistake the lane
    // for field-verified data. A buggy/stale/over-broad store that returns
    // records for the wrong docId would still flow through here, but callers
    // are now forced to handle the unverifiable-trust case explicitly.
    //
    // TrajectoryDocumentStore.getDocument() does not guarantee sorted output
    // — some backends (post-compaction, replay, backend-specific enumeration)
    // may return shuffled records. We sort by stepIndex here to give callers
    // the deterministic ordering the package contract promises.
    const ordered = [...raw].sort((a, b) => a.stepIndex - b.stepIndex);
    return {
      status: { state: "present-unverified" },
      records: ordered,
      rawCount: raw.length,
    };
  } catch (cause) {
    return {
      status: {
        state: "error",
        error: externalError("trajectory store fetch failed", cause),
      },
      records: [],
      rawCount: 0,
    };
  }
}

export async function fetchAudit(
  sink: AuditSink | undefined,
  sessionId: string,
): Promise<AuditFetch> {
  if (!sink?.query) {
    return {
      status: { state: "unqueryable" },
      records: [],
      integrityFilteredCount: 0,
      rawCount: 0,
    };
  }
  try {
    const raw = await sink.query(sessionId);
    if (raw.length === 0) {
      return {
        status: { state: "missing" },
        records: [],
        integrityFilteredCount: 0,
        rawCount: 0,
      };
    }
    const matching = raw.filter((entry) => entry.sessionId === sessionId);
    const integrityFilteredCount = raw.length - matching.length;
    if (integrityFilteredCount > 0) {
      console.warn(
        `[decision-ledger] audit sink returned ${integrityFilteredCount} of ${raw.length} records for a different session than "${sessionId}"; dropped for integrity`,
      );
    }
    if (matching.length === 0) {
      // Distinct from `missing`: the backend returned data, all of it for
      // the wrong session. Trust-boundary failure, not absence. The top-
      // level `integrityFilteredCount` mirrors the status-level count so
      // flat callers reading only the top-level signal cannot miss it.
      return {
        status: { state: "integrity-violation", integrityFilteredCount },
        records: [],
        integrityFilteredCount,
        rawCount: raw.length,
      };
    }
    // Sort by (timestamp, turnIndex, originalIndex). `AuditSink.query()`
    // does not promise stable ordering and two entries can share the same
    // ms timestamp AND the same turnIndex (bursty writes within a turn).
    // Capturing the original array index before sorting and using it as
    // the final tiebreaker makes the output deterministic given a fixed
    // sink response — `ES2019 Array.prototype.sort` stability alone is
    // not enough because the sink's own iteration order is undefined, so
    // we encode "position in the sink's response" explicitly.
    const indexed = matching.map((entry, originalIndex) => ({ entry, originalIndex }));
    indexed.sort((a, b) => {
      if (a.entry.timestamp !== b.entry.timestamp) {
        return a.entry.timestamp - b.entry.timestamp;
      }
      if (a.entry.turnIndex !== b.entry.turnIndex) {
        return a.entry.turnIndex - b.entry.turnIndex;
      }
      return a.originalIndex - b.originalIndex;
    });
    const ordered = indexed.map(({ entry }) => entry);
    const status: SourceStatus =
      integrityFilteredCount > 0
        ? { state: "present-with-leakage", integrityFilteredCount }
        : { state: "present" };
    return {
      status,
      records: ordered,
      integrityFilteredCount,
      rawCount: raw.length,
    };
  } catch (cause) {
    return {
      status: {
        state: "error",
        error: externalError("audit sink query failed", cause),
      },
      records: [],
      integrityFilteredCount: 0,
      rawCount: 0,
    };
  }
}

export async function fetchReport(
  store: ReportStore | undefined,
  sessionId: string,
): Promise<ReportFetch> {
  if (!store) {
    return {
      status: { state: "unqueryable" },
      latest: undefined,
      integrityFilteredCount: 0,
      rawCount: 0,
    };
  }
  try {
    const branded = brandSessionId(sessionId);
    const raw = await store.getBySession(branded);
    if (raw.length === 0) {
      return {
        status: { state: "missing" },
        latest: undefined,
        integrityFilteredCount: 0,
        rawCount: 0,
      };
    }
    // Filter ONLY at the top level. `childReports` is the L0 schema's
    // hook for delegated sub-agent runs (see kernel/engine/delivery-policy.ts
    // where spawned children get `sessionId: sessionId(\`delivery-${childId}\`)`),
    // so nested `childReports` with different sessionIds is the INTENDED
    // design, not a cross-session leak. Stripping them would destroy
    // legitimate delegation history. The top-level filter is enough to
    // catch the trust-boundary case: a sink returning other-session
    // records from `getBySession(requested)` at the top level.
    const matching = raw.filter((report) => report.sessionId === branded);
    const integrityFilteredCount = raw.length - matching.length;
    if (integrityFilteredCount > 0) {
      console.warn(
        `[decision-ledger] report store returned ${integrityFilteredCount} of ${raw.length} top-level reports for a different session than "${sessionId}"; dropped for integrity`,
      );
    }

    // rawCount is the total number of report nodes the sink returned,
    // counted recursively across legitimate `childReports` trees. A buggy
    // store returning one parent with 10k nested children should still
    // trip the soft-ceiling check because the payload size is real, even
    // if the nesting is legitimate delegation data.
    const rawTreeSize = raw.reduce<number>((acc, r) => acc + countReportTree(r), 0);

    if (matching.length === 0) {
      return {
        status: { state: "integrity-violation", integrityFilteredCount },
        latest: undefined,
        integrityFilteredCount,
        rawCount: rawTreeSize,
      };
    }
    const status: SourceStatus =
      integrityFilteredCount > 0
        ? { state: "present-with-leakage", integrityFilteredCount }
        : { state: "present" };
    return {
      status,
      latest: pickLatest(matching),
      integrityFilteredCount,
      rawCount: rawTreeSize,
    };
  } catch (cause) {
    return {
      status: {
        state: "error",
        error: externalError("report store fetch failed", cause),
      },
      latest: undefined,
      integrityFilteredCount: 0,
      rawCount: 0,
    };
  }
}

/**
 * Maximum number of report nodes the ceiling-accounting walk will visit
 * before bailing out. Iterative walk plus a visited-set guard against
 * cycles ensures a malformed or adversarially crafted report graph
 * cannot stack-overflow or DoS the report lane via the observability
 * bookkeeping path.
 */
const REPORT_TREE_WALK_LIMIT = 100_000;

/**
 * Count the total number of report nodes in a tree (self + all descendants).
 *
 * Iterative traversal with an explicit stack, a visited-set cycle guard,
 * and a hard node-count cap. If the tree is cyclic, malformed, or absurdly
 * large, we return the limit rather than throw — the caller's soft-ceiling
 * check still fires because the returned number is monotonic in actual
 * node count, and the fetch path never aborts because of accounting.
 */
function countReportTree(root: RunReport): number {
  const stack: RunReport[] = [root];
  const visited = new Set<RunReport>();
  let total = 0;
  while (stack.length > 0) {
    if (total >= REPORT_TREE_WALK_LIMIT) {
      return REPORT_TREE_WALK_LIMIT;
    }
    const node = stack.pop();
    if (!node || visited.has(node)) {
      continue;
    }
    visited.add(node);
    total += 1;
    const children = node.childReports;
    if (children && children.length > 0) {
      for (const child of children) {
        stack.push(child);
      }
    }
  }
  return total;
}

function pickLatest(reports: readonly RunReport[]): RunReport {
  let latest = reports[0];
  if (!latest) {
    throw new Error("pickLatest invariant: called with empty array");
  }
  for (let i = 1; i < reports.length; i += 1) {
    const candidate = reports[i];
    if (candidate && candidate.duration.completedAt > latest.duration.completedAt) {
      latest = candidate;
    }
  }
  return latest;
}
