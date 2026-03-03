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
// scope types — re-exported from @koi/scope for convenience
export type { BrowserScope } from "@koi/scope";
// provider
export type {
  BrowserProviderConfig,
  CompiledNavigationSecurity,
  NavigationSecurityConfig,
} from "./browser-component-provider.js";
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
  EVALUATE_TRUST_TIER,
  OPERATIONS,
} from "./constants.js";
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
export { createBrowserSnapshotTool } from "./tools/snapshot.js";
export { createBrowserTabCloseTool } from "./tools/tab-close.js";
export { createBrowserTabFocusTool } from "./tools/tab-focus.js";
export { createBrowserTabNewTool } from "./tools/tab-new.js";
export { createBrowserTypeTool } from "./tools/type.js";
export { createBrowserWaitTool } from "./tools/wait.js";
// url security
export { compileNavigationSecurity } from "./url-security.js";
