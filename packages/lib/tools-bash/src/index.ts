/**
 * @koi/tools-bash — Bash shell execution tool with security classifiers.
 */
export type { BashBackgroundToolConfig } from "./bash-background-tool.js";
export { createBashBackgroundTool } from "./bash-background-tool.js";
export type { BashToolConfig, BashToolHandle } from "./bash-tool.js";
export { createBashTool, createBashToolWithHooks } from "./bash-tool.js";
export { SIGKILL_ESCALATION_MS } from "./exec.js";
