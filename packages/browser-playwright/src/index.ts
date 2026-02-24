/**
 * @koi/browser-playwright — Playwright implementation of BrowserDriver.
 *
 * L2 package. Depends on @koi/core (L0) and playwright.
 * Use with @koi/tool-browser (createBrowserProvider) to wire up browser tools.
 */

export type { A11yNode, SerializeResult } from "./a11y-serializer.js";
export { serializeA11yTree } from "./a11y-serializer.js";
export type { PlaywrightDriverConfig } from "./playwright-browser-driver.js";
export { createPlaywrightBrowserDriver } from "./playwright-browser-driver.js";
