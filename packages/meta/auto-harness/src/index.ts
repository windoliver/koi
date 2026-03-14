/**
 * @koi/auto-harness — Auto-harness middleware synthesis (L3 meta-package).
 *
 * Wires @koi/harness-synth (LLM synthesis) + @koi/harness-search (Thompson
 * sampling refinement) + @koi/middleware-policy-cache (deterministic short-circuit)
 * into the forge middleware pipeline.
 *
 * The closed loop:
 *   observed failures → synthesis → refinement → verification → deployment
 *   → policy promotion (100% success) → zero-cost interception
 */

export { createAutoHarnessStack } from "./create-auto-harness-stack.js";
export type { AutoHarnessConfig, AutoHarnessStack } from "./types.js";
