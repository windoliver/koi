/**
 * @koi/browser-a11y — accessibility-tree serializer + Playwright error translator.
 *
 * Pure L0u utilities shared by `@koi/browser-playwright` (CDP-over-Playwright
 * driver) and `@koi/browser-ext` (extension-injected session driver). Depends
 * only on L0 (`@koi/core` for types) and peer L0u (`@koi/token-estimator` for
 * CHARS_PER_TOKEN). No Playwright runtime import.
 */

export type { A11yNode, SerializeResult } from "./a11y-serializer.js";
export { isAriaRole, parseAriaYaml, serializeA11yTree, VALID_ROLES } from "./a11y-serializer.js";
export { translatePlaywrightError } from "./error-translator.js";
