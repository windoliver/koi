import type { AgentId } from "@koi/core";
import type {
  GovernanceBackend,
  PolicyEvaluator,
  PolicyRequest,
} from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import type { ApprovalStore } from "./types.js";

export interface WrapBackendOptions {
  /**
   * Resolve the actor scope used for `match()` lookups. Defaults to the
   * live `request.agentId`. Hosts that need a stable scope across
   * process restarts (e.g. the CLI uses its manifest-derived `hostId`)
   * pass a function returning that stable id; the same function MUST
   * be passed to `createPersistSink` so writes and reads use the same
   * key.
   */
  readonly resolveAgentId?: (request: PolicyRequest) => AgentId;
}

/**
 * Wrap a GovernanceBackend so that ok:"ask" verdicts are short-circuited
 * to GOVERNANCE_ALLOW when the persistent allowlist already contains a
 * matching grant. All other verdicts pass through unchanged.
 */
export function wrapBackendWithPersistedAllowlist(
  inner: GovernanceBackend,
  store: ApprovalStore,
  options: WrapBackendOptions = {},
): GovernanceBackend {
  const resolveAgentId = options.resolveAgentId ?? ((req: PolicyRequest) => req.agentId);
  const evaluator: PolicyEvaluator = {
    async evaluate(request) {
      const verdict = await inner.evaluator.evaluate(request);
      if (verdict.ok !== "ask") return verdict;
      const hit = await store.match({
        kind: request.kind,
        agentId: resolveAgentId(request),
        payload: request.payload,
      });
      return hit === undefined ? verdict : GOVERNANCE_ALLOW;
    },
    ...(inner.evaluator.scope !== undefined ? { scope: inner.evaluator.scope } : {}),
  };

  return {
    evaluator,
    ...(inner.constraints !== undefined ? { constraints: inner.constraints } : {}),
    ...(inner.compliance !== undefined ? { compliance: inner.compliance } : {}),
    ...(inner.violations !== undefined ? { violations: inner.violations } : {}),
    ...(inner.dispose !== undefined ? { dispose: inner.dispose } : {}),
    ...(inner.describeRules !== undefined ? { describeRules: inner.describeRules } : {}),
  };
}
