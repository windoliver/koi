/**
 * Parallel fetch + classification for the three ledger sinks.
 *
 * Each fetch outcome is normalized into a `{status, records}` pair so the
 * caller can assemble the ledger without knowing about Promise.allSettled.
 *
 * Invariant: a single sink failure never poisons the others. Per-sink errors
 * are surfaced via SourceStatus, not by throwing.
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
}

export interface AuditFetch {
  readonly status: SourceStatus;
  readonly records: readonly AuditEntry[];
}

export interface ReportFetch {
  readonly status: SourceStatus;
  readonly latest: RunReport | undefined;
}

export async function fetchTrajectory(
  store: TrajectoryReader,
  sessionId: string,
): Promise<TrajectoryFetch> {
  try {
    const records = await store.getDocument(sessionId);
    if (records.length === 0) {
      return { status: { state: "missing" }, records };
    }
    return { status: { state: "present" }, records };
  } catch (cause) {
    return {
      status: {
        state: "error",
        error: externalError("trajectory store fetch failed", cause),
      },
      records: [],
    };
  }
}

export async function fetchAudit(
  sink: AuditSink | undefined,
  sessionId: string,
): Promise<AuditFetch> {
  if (!sink?.query) {
    return { status: { state: "unqueryable" }, records: [] };
  }
  try {
    const records = await sink.query(sessionId);
    if (records.length === 0) {
      return { status: { state: "missing" }, records };
    }
    return { status: { state: "present" }, records };
  } catch (cause) {
    return {
      status: {
        state: "error",
        error: externalError("audit sink query failed", cause),
      },
      records: [],
    };
  }
}

export async function fetchReport(
  store: ReportStore | undefined,
  sessionId: string,
): Promise<ReportFetch> {
  if (!store) {
    return { status: { state: "unqueryable" }, latest: undefined };
  }
  try {
    const reports = await store.getBySession(brandSessionId(sessionId));
    if (reports.length === 0) {
      return { status: { state: "missing" }, latest: undefined };
    }
    return { status: { state: "present" }, latest: pickLatest(reports) };
  } catch (cause) {
    return {
      status: {
        state: "error",
        error: externalError("report store fetch failed", cause),
      },
      latest: undefined,
    };
  }
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
