/**
 * @koi/tools-bash — Bash shell execution tool with security classifiers,
 * CWD tracking, background execution, and sandbox injection.
 */

export type { BashBackgroundToolBundle, BashBackgroundToolConfig } from "./bash-background-tool.js";
export { createBashBackgroundTool } from "./bash-background-tool.js";
export type {
  BashToolConfig,
  SpawnTransform,
  SpawnTransformInput,
  SpawnTransformOutput,
} from "./bash-tool.js";
export { createBashTool } from "./bash-tool.js";
