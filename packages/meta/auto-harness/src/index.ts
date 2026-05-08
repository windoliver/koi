/**
 * @koi/auto-harness — minimal L3 package boundary for auto-harness session
 * controls, synthesis callbacks, and policy-cache composition.
 */

export { createAutoHarnessStack } from "./create-auto-harness-stack.js";
export type {
  AutoHarnessConfig,
  AutoHarnessDeployCandidate,
  AutoHarnessEvaluatePolicy,
  AutoHarnessGenerate,
  AutoHarnessRefinementFailure,
  AutoHarnessRequestDeploymentApproval,
  AutoHarnessStack,
  AutoHarnessStage,
  AutoHarnessStageError,
  AutoHarnessSynthesisResult,
  AutoHarnessSynthesizeHarness,
  AutoHarnessVerifyCandidate,
} from "./types.js";
export { DEFAULT_MAX_SYNTHESES_PER_SESSION } from "./types.js";
