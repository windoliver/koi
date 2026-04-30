/**
 * @koi/middleware-tool-disclosure — Progressive disclosure for large tool sets (L2).
 *
 * Above a configurable threshold, swaps full ToolDescriptor[] for summaries in
 * the model request. Tools are lifted back to full descriptors on demand via the
 * `promote_tools` companion tool. Depends on @koi/core only.
 */

export type { ToolDisclosureBundle } from "./disclosure-bundle.js";
export { createToolDisclosureBundle } from "./disclosure-bundle.js";
export type {
  ToolDisclosureConfig,
  ToolDisclosureMiddleware,
} from "./tool-disclosure-middleware.js";
export {
  createPromoteToolDescriptor,
  createToolDisclosureMiddleware,
  DEFAULT_DISCLOSURE_THRESHOLD,
  PROMOTE_TOOL_NAME,
} from "./tool-disclosure-middleware.js";
