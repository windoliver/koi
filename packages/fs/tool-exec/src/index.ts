/**
 * @koi/tool-exec — Ephemeral sandboxed code execution tool (Layer 2)
 *
 * Thin wrapper around SandboxExecutor.execute() — validates input,
 * clamps timeout, and returns the result. No Wasm, no tool bridge.
 */

export { createExecTool } from "./exec-tool.js";
export { createExecProvider } from "./provider.js";
export { EXEC_SKILL, EXEC_SKILL_CONTENT, EXEC_SKILL_NAME } from "./skill.js";
export type { ExecToolConfig } from "./types.js";
export { DEFAULT_TIMEOUT_MS, EXEC_TOOL_DESCRIPTOR, MAX_TIMEOUT_MS } from "./types.js";
