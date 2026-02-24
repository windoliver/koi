/**
 * @koi/browser-playwright — Playwright implementation of BrowserDriver.
 *
 * L2 package. Depends on @koi/core (L0) and playwright.
 * Use with @koi/tool-browser (createBrowserProvider) to wire up browser tools.
 */

export type { A11yNode, SerializeResult } from "./a11y-serializer.js";
export { isAriaRole, parseAriaYaml, serializeA11yTree, VALID_ROLES } from "./a11y-serializer.js";
export type { DetectedBrowser } from "./browser-detection.js";
export { detectInstalledBrowsers } from "./browser-detection.js";

export type { PlaywrightDriverConfig } from "./playwright-browser-driver.js";
export { createPlaywrightBrowserDriver, STEALTH_INIT_SCRIPT } from "./playwright-browser-driver.js";
