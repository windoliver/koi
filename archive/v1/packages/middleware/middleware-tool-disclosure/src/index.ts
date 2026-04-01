/**
 * @koi/middleware-tool-disclosure — Progressive disclosure for forged tools.
 *
 * Exposes tools at summary level (~20 tokens each) when the tool count
 * exceeds a threshold. Full descriptors (~200-500 tokens) are loaded on
 * demand via the promote_tools companion tool.
 */

export type { ToolDisclosureBundle } from "./disclosure-bundle.js";
export { createToolDisclosureBundle } from "./disclosure-bundle.js";
export type {
  PromoteToolsConfig,
  ToolDisclosureConfig,
  ToolDisclosureMiddleware,
} from "./tool-disclosure-middleware.js";
export {
  brickSummaryToToolSummary,
  createPromoteToolDescriptor,
  createToolDisclosureMiddleware,
  DEFAULT_DISCLOSURE_THRESHOLD,
} from "./tool-disclosure-middleware.js";
