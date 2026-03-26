/**
 * @koi/rlm-stack — L3 composition bundle for code-execution RLM.
 *
 * Wires @koi/code-executor (QuickJS WASM sandbox) into @koi/middleware-rlm
 * so the model writes JavaScript code to analyze large inputs instead of
 * calling predefined tools.
 *
 * Usage:
 *
 *   const { middleware, providers } = createRlmStack({
 *     contextWindowTokens: 128_000,
 *   });
 */

export { createRlmStack } from "./create-rlm-stack.js";
export { createScriptRunner, type ScriptRunnerConfig } from "./create-script-runner.js";
export { createRlmStackFromPreset, type RlmPresetTier } from "./presets.js";
export type { RlmStackConfig } from "./types.js";
