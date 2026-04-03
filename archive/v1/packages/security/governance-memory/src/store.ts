/**
 * In-memory governance store — compliance recording + violation storage + constraint checking.
 *
 * Uses ring buffers for bounded memory:
 * - Compliance records: single ring buffer (configurable capacity)
 * - Violations: per-agent ring buffers (configurable per-agent capacity)
 */

import type { AgentId } from "@koi/core/ecs";
import type {
  ComplianceRecord,
  ComplianceRecorder,
  ConstraintChecker,
  ConstraintQuery,
  GovernanceVerdict,
  PolicyRequest,
  Violation,
  ViolationFilter,
  ViolationPage,
  ViolationStore,
} from "@koi/core/governance-backend";
import {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  VIOLATION_SEVERITY_ORDER,
} from "@koi/core/governance-backend";
import type { MemoryEvaluator } from "./evaluator.js";
import { createRingBuffer } from "./ring-buffer.js";

// ---------------------------------------------------------------------------
// StoredViolation — internal violation record with metadata
// ---------------------------------------------------------------------------

interface StoredViolation {
  readonly violation: Violation;
  readonly agentId: AgentId;
  readonly sessionId?: string | undefined;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// GovernanceMemoryStore
// ---------------------------------------------------------------------------

/** Combined store implementing ComplianceRecorder + ViolationStore + ConstraintChecker. */
export interface GovernanceMemoryStore {
  readonly compliance: ComplianceRecorder;
  readonly violations: ViolationStore;
  readonly constraints: ConstraintChecker;
  /** Record violations from a governance verdict for an agent. */
  readonly recordViolationsFromVerdict: (
    agentId: AgentId,
    verdict: GovernanceVerdict,
    timestamp: number,
    sessionId?: string | undefined,
  ) => void;
  /** Clear all stored data. */
  readonly clear: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_COMPLIANCE_CAPACITY = 10_000;
const DEFAULT_VIOLATION_CAPACITY = 1_000;

/** Create an in-memory governance store. */
export function createGovernanceMemoryStore(
  evaluator: MemoryEvaluator,
  complianceCapacity?: number | undefined,
  violationCapacity?: number | undefined,
): GovernanceMemoryStore {
  const compCap = complianceCapacity ?? DEFAULT_COMPLIANCE_CAPACITY;
  const violCap = violationCapacity ?? DEFAULT_VIOLATION_CAPACITY;

  const complianceBuffer = createRingBuffer<ComplianceRecord>(compCap);
  const violationBuffers = new Map<string, ReturnType<typeof createRingBuffer<StoredViolation>>>();

  function getViolationBuffer(
    agentId: AgentId,
  ): ReturnType<typeof createRingBuffer<StoredViolation>> {
    const existing = violationBuffers.get(agentId);
    if (existing !== undefined) return existing;
    const buf = createRingBuffer<StoredViolation>(violCap);
    violationBuffers.set(agentId, buf);
    return buf;
  }

  const compliance: ComplianceRecorder = {
    recordCompliance(record: ComplianceRecord): ComplianceRecord {
      complianceBuffer.append(record);
      return record;
    },
  };

  const violations: ViolationStore = {
    getViolations(filter: ViolationFilter): ViolationPage {
      const limit = filter.limit ?? DEFAULT_VIOLATION_QUERY_LIMIT;
      // O(total violations across all agents). Acceptable because ring buffers
      // bound total violations to violationCapacity * number_of_agents.
      const allViolations: StoredViolation[] = [];

      if (filter.agentId !== undefined) {
        // Query specific agent
        const buf = violationBuffers.get(filter.agentId);
        if (buf !== undefined) {
          for (const v of buf.items()) {
            allViolations.push(v);
          }
        }
      } else {
        // Query all agents
        for (const buf of violationBuffers.values()) {
          for (const v of buf.items()) {
            allViolations.push(v);
          }
        }
      }

      // Apply filters
      const filtered = allViolations.filter((sv) => {
        if (filter.severity !== undefined) {
          const minIdx = VIOLATION_SEVERITY_ORDER.indexOf(filter.severity);
          const actualIdx = VIOLATION_SEVERITY_ORDER.indexOf(sv.violation.severity);
          if (actualIdx < minIdx) return false;
        }
        if (filter.rule !== undefined && sv.violation.rule !== filter.rule) return false;
        if (filter.since !== undefined && sv.timestamp < filter.since) return false;
        if (filter.until !== undefined && sv.timestamp >= filter.until) return false;
        if (filter.sessionId !== undefined && sv.sessionId !== filter.sessionId) return false;
        return true;
      });

      // Apply offset-based pagination
      const rawOffset = filter.offset !== undefined ? Number.parseInt(filter.offset, 10) : 0;
      const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
      const page = filtered.slice(offset, offset + limit);
      const hasMore = offset + limit < filtered.length;

      return {
        items: page.map((sv) => sv.violation),
        total: filtered.length,
        ...(hasMore ? { cursor: String(offset + limit) } : {}),
      };
    },
  };

  const constraints: ConstraintChecker = {
    checkConstraint(query: ConstraintQuery): boolean {
      // Validate kind is a non-empty string (fail-closed)
      if (typeof query.kind !== "string" || query.kind.length === 0) {
        return false;
      }
      // Delegate to evaluator: construct a synthetic policy request and evaluate
      const request: PolicyRequest = {
        kind: `custom:constraint:${query.kind}`,
        agentId: query.agentId,
        payload: {
          constraintKind: query.kind,
          ...(query.value !== undefined ? { value: query.value } : {}),
          ...(query.context ?? {}),
        },
        timestamp: Date.now(),
      };
      const verdict = evaluator.evaluate(request);
      // Sync only — constraint checks are synchronous for in-memory backend
      if (typeof verdict === "object" && "ok" in verdict) {
        return verdict.ok;
      }
      // Promise case — should not happen for in-memory, fail-closed
      return false;
    },
  };

  function recordViolationsFromVerdict(
    agentId: AgentId,
    verdict: GovernanceVerdict,
    timestamp: number,
    sessionId?: string | undefined,
  ): void {
    if (verdict.ok) return;
    const buf = getViolationBuffer(agentId);
    for (const v of verdict.violations) {
      buf.append({ violation: v, agentId, sessionId, timestamp });
    }
  }

  function clear(): void {
    complianceBuffer.clear();
    violationBuffers.clear();
  }

  return {
    compliance,
    violations,
    constraints,
    recordViolationsFromVerdict,
    clear,
  };
}
