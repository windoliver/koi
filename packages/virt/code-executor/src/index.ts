/**
 * @koi/code-executor — Code Mode for programmatic tool orchestration.
 *
 * Provides the `execute_script` tool, which lets agents write scripts that
 * call multiple tools in a single turn via a Wasm sandbox.
 */

export type { ConsoleEntry } from "./console-bridge.js";
export type { ScriptConfig, ScriptResult } from "./execute-script.js";
export { executeScript } from "./execute-script.js";
export { createExecuteScriptTool } from "./execute-script-tool.js";
export { createCodeExecutorProvider } from "./provider.js";
