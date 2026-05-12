/**
 * @koi/approval-zones — convert ask verdicts into auto / sandbox / ask
 * based on configured zones + risk scoring.
 */

export {
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
  SCRIPTED_CLEANUP_PROFILE,
} from "./default-profiles.js";
export type { ZoneEvaluator, ZoneEvaluatorConfig } from "./evaluator.js";
export { createZoneEvaluator } from "./evaluator.js";
export type { DefaultRiskScorerOptions } from "./risk-scorer.js";
export { createDefaultRiskScorer } from "./risk-scorer.js";
export type { RiskAssessment, RiskInputs, RiskScorer, RiskTier } from "./risk-types.js";
export { compareRisk } from "./risk-types.js";
export { matchesZone } from "./zone-match.js";
export type { ApprovalZone, ZoneAction, ZoneMatch, ZoneVerdict } from "./zone-types.js";
