/**
 * Compactor governance contributor — declares the context_occupancy
 * governance variable via the GovernanceVariableContributor pattern.
 *
 * Informational-only: check() always returns {ok: true}.
 * The compactor middleware handles enforcement directly.
 *
 * Attached as an ECS component under "governance:contrib:compactor".
 */

import type { GovernanceVariable, GovernanceVariableContributor, SubsystemToken } from "@koi/core";
import { GOVERNANCE_VARIABLES, governanceContributorToken } from "@koi/core";

export const COMPACTOR_GOVERNANCE: SubsystemToken<GovernanceVariableContributor> =
  governanceContributorToken("compactor");

export function createCompactorGovernanceContributor(
  readTokenCount: () => number,
  contextWindowSize: number,
): GovernanceVariableContributor {
  const occupancyVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.CONTEXT_OCCUPANCY,
    read: readTokenCount,
    limit: contextWindowSize,
    retryable: false,
    description: "Context window occupancy (informational)",
    check() {
      return { ok: true };
    },
  };

  return {
    variables: () => [occupancyVar],
  };
}
