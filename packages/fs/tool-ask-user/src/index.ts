/**
 * @koi/tool-ask-user — Structured user elicitation tool (Layer 2)
 *
 * Asks users structured questions (multi-choice or free-text) mid-execution
 * and blocks until answered. The rendering is the handler's responsibility;
 * this package provides the tool + validation contract.
 */

export { createAskUserTool } from "./ask-user-tool.js";
export { createAskUserProvider } from "./provider.js";
// registration
export { createAskUserRegistration } from "./registration.js";
export type { AskUserConfig, ElicitationHandler } from "./types.js";
export {
  ASK_USER_TOOL_DESCRIPTOR,
  DEFAULT_MAX_OPTIONS,
  DEFAULT_TIMEOUT_MS,
} from "./types.js";
