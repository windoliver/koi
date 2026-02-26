/**
 * Forge governance contributor — L2 package that declares forge-specific
 * governance variables via the GovernanceVariableContributor pattern.
 *
 * Attached as an ECS component under "governance:contrib:forge".
 * The L1 governance extension discovers it via generic prefix query.
 */

import type {
  GovernanceCheck,
  GovernanceVariable,
  GovernanceVariableContributor,
  SubsystemToken,
} from "@koi/core";
import { GOVERNANCE_VARIABLES, governanceContributorToken } from "@koi/core";
import type { ForgeConfig } from "./config.js";

export const FORGE_GOVERNANCE: SubsystemToken<GovernanceVariableContributor> =
  governanceContributorToken("forge");

export function createForgeGovernanceContributor(
  config: ForgeConfig,
  readDepth: () => number,
  readForgeCount: () => number,
): GovernanceVariableContributor {
  const forgeDepthVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.FORGE_DEPTH,
    read: readDepth,
    limit: config.maxForgeDepth,
    retryable: false,
    description: "Maximum forge nesting depth",
    check(): GovernanceCheck {
      const depth = readDepth();
      if (depth > config.maxForgeDepth) {
        return {
          ok: false,
          variable: GOVERNANCE_VARIABLES.FORGE_DEPTH,
          reason: `Forge depth ${depth} exceeds max ${config.maxForgeDepth}`,
          retryable: false,
        };
      }
      return { ok: true };
    },
  };

  const forgeBudgetVar: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.FORGE_BUDGET,
    read: readForgeCount,
    limit: config.maxForgesPerSession,
    retryable: true,
    description: "Maximum forge operations per session",
    check(): GovernanceCheck {
      const count = readForgeCount();
      if (count >= config.maxForgesPerSession) {
        return {
          ok: false,
          variable: GOVERNANCE_VARIABLES.FORGE_BUDGET,
          reason: `Session has reached max forges (${config.maxForgesPerSession})`,
          retryable: true,
        };
      }
      return { ok: true };
    },
  };

  return {
    variables: () => [forgeDepthVar, forgeBudgetVar],
  };
}
