import type { GovernanceBackend, PolicyEvaluator } from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import type { ApprovalStore } from "./types.js";

/**
 * Wrap a GovernanceBackend so that ok:"ask" verdicts are short-circuited
 * to GOVERNANCE_ALLOW when the persistent allowlist already contains a
 * matching grant. All other verdicts pass through unchanged.
 */
export function wrapBackendWithPersistedAllowlist(
  inner: GovernanceBackend,
  store: ApprovalStore,
): GovernanceBackend {
  const evaluator: PolicyEvaluator = {
    async evaluate(request) {
      const verdict = await inner.evaluator.evaluate(request);
      if (verdict.ok !== "ask") return verdict;
      const hit = await store.match({ kind: request.kind, payload: request.payload });
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
