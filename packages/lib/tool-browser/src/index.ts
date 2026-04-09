/**
 * @koi/tool-browser — Accessibility-tree-first browser automation tools (Layer 2)
 *
 * Provides a ComponentProvider that wraps a BrowserDriver as Tool components.
 * Both engine-claude and engine-pi discover these tools via
 * `agent.query<Tool>("tool:")` with zero engine changes.
 *
 * The driver uses [ref=eN] snapshots instead of screenshots — ~100x cheaper,
 * deterministic element targeting, works with any LLM.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 *
 * v2 changes over v1:
 * - Removed @koi/scope dependency (L2→L2 violation). URL policy is now injected
 *   via an `isUrlAllowed` callback in BrowserProviderConfig.
 * - `browser_snapshot` now accepts `maxBytes` instead of `maxTokens` for token
 *   budget control (50KB default; converted to tokens via ÷4 heuristic).
 * - createRefActionTool factory eliminates boilerplate across click/hover/type/etc.
 *
 * Usage:
 * ```ts
 * import { createBrowserProvider, OPERATIONS } from "@koi/tool-browser";
 * import { createPlaywrightDriver } from "@koi/browser-playwright";
 *
 * const provider = createBrowserProvider({
 *   backend: await createPlaywrightDriver(),
 *   // To enable evaluate (promoted tier):
 *   // operations: [...OPERATIONS, "evaluate"],
 * });
 * ```
 */

// types — re-exported from @koi/core for convenience
export type {
  BrowserActionOptions,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserConsoleOptions,
  BrowserConsoleResult,
  BrowserDriver,
  BrowserEvaluateOptions,
  BrowserEvaluateResult,
  BrowserFormField,
  BrowserNavigateOptions,
  BrowserNavigateResult,
  BrowserRefInfo,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserScrollOptions,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserTabCloseOptions,
  BrowserTabFocusOptions,
  BrowserTabInfo,
  BrowserTabNewOptions,
  BrowserTypeOptions,
  BrowserWaitOptions,
  BrowserWaitUntil,
} from "@koi/core";
// provider
export type { BrowserProviderConfig } from "./browser-component-provider.js";
export { createBrowserProvider } from "./browser-component-provider.js";
// constants
export type { BrowserOperation } from "./constants.js";
export {
  ALL_OPERATIONS,
  BROWSER_SKILL,
  BROWSER_SKILL_CONTENT,
  BROWSER_SKILL_NAME,
  BROWSER_SYSTEM_PROMPT,
  DEFAULT_PREFIX,
  EVALUATE_OPERATION,
  EVALUATE_POLICY,
  OPERATIONS,
} from "./constants.js";
export type { RefActionConfig } from "./ref-action.js";
// ref-action factory — for custom tool composition
export { createRefActionTool, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./ref-action.js";
// test helpers
export { createMockAgent, createMockDriver } from "./test-helpers.js";
// tool factories — for advanced usage (custom tool composition)
export { createBrowserClickTool } from "./tools/click.js";
export { createBrowserConsoleTool } from "./tools/console.js";
export { createBrowserEvaluateTool } from "./tools/evaluate.js";
export { createBrowserFillFormTool } from "./tools/fill-form.js";
export { createBrowserHoverTool } from "./tools/hover.js";
export { createBrowserNavigateTool } from "./tools/navigate.js";
export { createBrowserPressTool } from "./tools/press.js";
export { createBrowserScreenshotTool } from "./tools/screenshot.js";
export { createBrowserScrollTool } from "./tools/scroll.js";
export { createBrowserSelectTool } from "./tools/select.js";
// snapshot constant
export { createBrowserSnapshotTool, DEFAULT_SNAPSHOT_MAX_BYTES } from "./tools/snapshot.js";
export { createBrowserTabCloseTool } from "./tools/tab-close.js";
export { createBrowserTabFocusTool } from "./tools/tab-focus.js";
export { createBrowserTabNewTool } from "./tools/tab-new.js";
export { createBrowserTypeTool } from "./tools/type.js";
export { createBrowserWaitTool } from "./tools/wait.js";
