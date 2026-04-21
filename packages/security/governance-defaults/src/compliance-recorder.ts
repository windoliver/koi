/**
 * Audit-sink-backed ComplianceRecorder — maps governance ComplianceRecord
 * entries to AuditEntry and forwards to the supplied AuditSink.
 *
 * Errors are swallowed (routed to onError) so a failing sink cannot crash
 * the governance hot path. sink.log() is fire-and-forget.
 */

import type { AuditEntry, AuditSink, ComplianceRecord, ComplianceRecorder } from "@koi/core";

/** Default AuditEntry.schema_version for compliance events when ctx omits one. */
const DEFAULT_AUDIT_SCHEMA_VERSION = 1;

export interface AuditSinkComplianceRecorderCtx {
  readonly sessionId: string;
  readonly schemaVersion?: number | undefined;
  readonly onError?: ((err: unknown) => void) | undefined;
}

export function createAuditSinkComplianceRecorder(
  sink: AuditSink,
  ctx: AuditSinkComplianceRecorderCtx,
): ComplianceRecorder {
  const schemaVersion = ctx.schemaVersion ?? DEFAULT_AUDIT_SCHEMA_VERSION;
  const onError =
    ctx.onError ??
    ((err: unknown): void => {
      console.warn("[compliance-recorder] sink.log failed:", err);
    });

  return {
    recordCompliance(record: ComplianceRecord): ComplianceRecord {
      const entry: AuditEntry = {
        schema_version: schemaVersion,
        timestamp: record.evaluatedAt,
        sessionId: ctx.sessionId,
        agentId: record.request.agentId,
        turnIndex: 0,
        kind: "compliance_event",
        request: record.request,
        response: record.verdict,
        durationMs: 0,
        metadata: {
          requestId: record.requestId,
          policyFingerprint: record.policyFingerprint,
        },
      };

      // Fire-and-forget — never await, never throw back to caller.
      sink.log(entry).catch(onError);
      return record;
    },
  };
}

/**
 * Compose multiple ComplianceRecorders so one call writes to all of them.
 * - Empty array → no-op recorder (returns the record unchanged).
 * - Single entry → passed through directly (no wrapper allocation).
 * - 2+ → each recorder's recordCompliance is invoked sequentially.
 *
 * Errors inside an individual recorder must be contained by that recorder;
 * fanOut does not catch.
 */
export function fanOutComplianceRecorder(
  recorders: readonly ComplianceRecorder[],
): ComplianceRecorder {
  if (recorders.length === 0) {
    return {
      recordCompliance(record: ComplianceRecord): ComplianceRecord {
        return record;
      },
    };
  }
  if (recorders.length === 1) {
    const sole = recorders[0];
    if (sole === undefined) {
      throw new Error("fanOutComplianceRecorder: unreachable undefined entry");
    }
    return sole;
  }
  return {
    async recordCompliance(record: ComplianceRecord): Promise<ComplianceRecord> {
      // let: justified — thread the accumulator so an enriching recorder
      // isn't silently dropped between links in the chain.
      let current = record;
      for (const r of recorders) {
        current = await r.recordCompliance(current);
      }
      return current;
    },
  };
}
