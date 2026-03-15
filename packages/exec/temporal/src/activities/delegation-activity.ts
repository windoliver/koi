/**
 * Delegation lifecycle Activities — manage Nexus delegation grants
 * as durable Temporal activities.
 *
 * Design decisions:
 * - #2-A: Idempotency key prevents duplicate grants on Temporal retry
 * - #7-A: Activities are compensatable via workflow cancellation handler
 * - #8-A: recordOutcome is a seam — records events but defers reputation to Phase 4
 * - #16-A: Batch spawns dispatch these activities in parallel via Promise.all()
 *
 * Activities run in normal Bun/Node.js context (NOT deterministic sandbox).
 */

import type { AgentId, DelegationId, KoiError, Result } from "@koi/core";
import { delegationId } from "@koi/core";
import { ApplicationFailure } from "@temporalio/activity";
import { mapKoiErrorToApplicationFailure } from "../temporal-errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the delegateViaNexus activity. */
export interface DelegateViaNexusInput {
  readonly parentAgentId: AgentId;
  readonly childAgentId: AgentId;
  readonly allowedOperations: readonly string[];
  readonly removeGrants: readonly string[];
  readonly resourcePatterns?: readonly string[];
  readonly namespaceMode: "COPY" | "CLEAN" | "SHARED";
  readonly maxDepth: number;
  readonly ttlSeconds: number;
  readonly canSubDelegate: boolean;
  /** Deterministic idempotency key — computed by workflow (parentId + childId + runId). */
  readonly idempotencyKey: string;
}

/** Result from the delegateViaNexus activity. */
export interface DelegateViaNexusResult {
  readonly delegationId: string;
  readonly apiKey: string;
  readonly expiresAt: string;
}

/** Input for the revokeDelegation activity. */
export interface RevokeDelegationInput {
  readonly delegationId: string;
}

/** Input for the recordDelegationOutcome activity (Phase 4 seam). */
export interface RecordDelegationOutcomeInput {
  readonly delegationId: string;
  readonly outcome: "completed" | "failed" | "timeout";
}

/** Injected dependencies for delegation activities. */
export interface DelegationActivityDeps {
  /** HTTP client for Nexus delegation API. */
  readonly nexusFetch: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Result<unknown, KoiError>>;
}

// ---------------------------------------------------------------------------
// Activity factory
// ---------------------------------------------------------------------------

const DELEGATE_BASE = "/api/v2/agents/delegate";

/**
 * Create delegation lifecycle activities for Temporal Worker registration.
 *
 * Dependencies injected via closure for testability.
 */
export function createDelegationActivities(deps: DelegationActivityDeps): {
  readonly delegateViaNexus: (input: DelegateViaNexusInput) => Promise<DelegateViaNexusResult>;
  readonly revokeDelegation: (input: RevokeDelegationInput) => Promise<void>;
  readonly recordDelegationOutcome: (input: RecordDelegationOutcomeInput) => Promise<void>;
} {
  return {
    /**
     * Create a delegation grant in Nexus.
     *
     * Idempotent: same idempotency_key returns existing delegation on retry.
     * Temporal retry policy handles transient Nexus failures automatically.
     */
    async delegateViaNexus(input: DelegateViaNexusInput): Promise<DelegateViaNexusResult> {
      const body = {
        parent_agent_id: input.parentAgentId,
        child_agent_id: input.childAgentId,
        scope: {
          allowed_operations: input.allowedOperations,
          remove_grants: input.removeGrants,
          ...(input.resourcePatterns !== undefined
            ? { resource_patterns: input.resourcePatterns }
            : {}),
        },
        namespace_mode: input.namespaceMode,
        max_depth: input.maxDepth,
        ttl_seconds: input.ttlSeconds,
        can_sub_delegate: input.canSubDelegate,
        idempotency_key: input.idempotencyKey,
      };

      const result = await deps.nexusFetch("POST", DELEGATE_BASE, body);

      if (!result.ok) {
        const payload = mapKoiErrorToApplicationFailure(result.error);
        throw ApplicationFailure.create({
          message: payload.message,
          type: payload.type,
          nonRetryable: payload.nonRetryable,
          details: [...payload.details],
        });
      }

      const resp = result.value as {
        readonly delegation_id: string;
        readonly api_key: string;
        readonly expires_at: string;
      };

      return {
        delegationId: resp.delegation_id,
        apiKey: resp.api_key,
        expiresAt: resp.expires_at,
      };
    },

    /**
     * Revoke a delegation grant in Nexus.
     *
     * Idempotent: revoking an already-revoked grant is a no-op.
     * Nexus handles cascading revocation server-side.
     */
    async revokeDelegation(input: RevokeDelegationInput): Promise<void> {
      const result = await deps.nexusFetch(
        "DELETE",
        `${DELEGATE_BASE}/${input.delegationId}`,
      );

      // NOT_FOUND is idempotent — already revoked
      if (!result.ok && result.error.code !== "NOT_FOUND") {
        const payload = mapKoiErrorToApplicationFailure(result.error);
        throw ApplicationFailure.create({
          message: payload.message,
          type: payload.type,
          nonRetryable: payload.nonRetryable,
          details: [...payload.details],
        });
      }
    },

    /**
     * Record delegation outcome — Phase 4 seam.
     *
     * Records the outcome as a Nexus event for observability.
     * The full reputation engine (Nexus trust scores → governance variable)
     * is deferred to Phase 4 — this activity just persists the signal.
     */
    async recordDelegationOutcome(input: RecordDelegationOutcomeInput): Promise<void> {
      const result = await deps.nexusFetch(
        "POST",
        `${DELEGATE_BASE}/${input.delegationId}/outcome`,
        { outcome: input.outcome },
      );

      // Best-effort — outcome recording failure doesn't break the workflow.
      // Log but don't throw on non-retryable errors.
      if (!result.ok && result.error.retryable) {
        const payload = mapKoiErrorToApplicationFailure(result.error);
        throw ApplicationFailure.create({
          message: payload.message,
          type: payload.type,
          nonRetryable: false, // Always retryable for outcome recording
          details: [...payload.details],
        });
      }
    },
  };
}
