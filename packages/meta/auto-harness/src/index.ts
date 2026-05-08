/**
 * @koi/auto-harness — minimal L3 package boundary for auto-harness session
 * controls, synthesis callbacks, and policy-cache composition.
 */

export { createAutoHarnessStack } from "./create-auto-harness-stack.js";
export type {
  AutoHarnessConfig,
  AutoHarnessDeployResult,
  AutoHarnessEvent,
  AutoHarnessPolicyResult,
  AutoHarnessStack,
  AutoHarnessVerificationResult,
} from "./types.js";
