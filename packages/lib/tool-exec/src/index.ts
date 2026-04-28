/**
 * @koi/tool-exec — Programmatic tool orchestration.
 *
 * Exposes an `execute_code` tool that runs multi-step TypeScript/JavaScript
 * scripts in an isolated Bun Worker thread. Inner tool calls go through the
 * registered tool map (and optionally the middleware chain). Only the script's
 * final return value is injected into the model's context window.
 */

export type { ExecuteCodeToolConfig } from "./execute-code-tool.js";
export {
  ACKNOWLEDGE_UNSANDBOXED_EXECUTION,
  createExecuteCodeTool,
} from "./execute-code-tool.js";
export {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_TIMEOUT_MS,
  executeScript,
  MAX_TIMEOUT_MS,
} from "./execute-script.js";
export type { ScriptConfig, ScriptResult } from "./types.js";
