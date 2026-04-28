/**
 * @koi/browser-playwright — Playwright implementation of BrowserDriver.
 *
 * L2 driver package. Depends on:
 *   - @koi/core        (L0)   types + error factories
 *   - @koi/browser-a11y (L0u)  parseAriaYaml / VALID_ROLES / translatePlaywrightError
 *   - playwright        (ext)  Browser / BrowserContext / Page / chromium.connectOverCDP
 *
 * A11y serialization + error translation live in @koi/browser-a11y — import
 * those symbols from there directly, not from this package.
 *
 * Use with @koi/tool-browser to wire the 20 BrowserDriver methods as Koi tools.
 */

export type { DetectedBrowser } from "./browser-detection.js";
export { detectInstalledBrowsers } from "./browser-detection.js";

export type { PlaywrightDriverConfig } from "./playwright-browser-driver.js";
export { createPlaywrightBrowserDriver, STEALTH_INIT_SCRIPT } from "./playwright-browser-driver.js";
