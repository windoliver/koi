/**
 * createForgePipeline — composition root that wires L2 sub-packages into a ForgePipeline.
 *
 * Lives in the L3 @koi/forge bundle because it imports from multiple L2 peers
 * (forge-verifier, forge-integrity, forge-policy), which only L3 may do.
 */

import { createForgeProvenance, extractBrickContent, signAttestation } from "@koi/forge-integrity";
import {
  checkGovernance,
  checkMutationPressure,
  checkScopePromotion,
  validateTrustTransition,
} from "@koi/forge-policy";
import type { ForgePipeline } from "@koi/forge-types";
import { verify } from "@koi/forge-verifier";

/**
 * Create a wired ForgePipeline instance.
 *
 * Pass the result as `pipeline` in ForgeDeps so that @koi/forge-tools
 * can call cross-package operations without direct L2→L2 imports.
 */
export function createForgePipeline(): ForgePipeline {
  return {
    verify,
    checkGovernance,
    checkMutationPressure,
    createProvenance: createForgeProvenance,
    signAttestation,
    extractBrickContent,
    checkScopePromotion,
    validateTrustTransition,
  };
}
