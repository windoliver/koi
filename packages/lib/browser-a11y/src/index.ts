/**
 * @koi/browser-a11y — Accessibility-tree serializer and Playwright error translator (L0u).
 *
 * Provides browser-tooling utilities that are decoupled from any specific driver:
 *  - `a11y-serializer`: parse Playwright ariaSnapshot YAML into compact text + ref maps
 *    (~800 tokens per page vs 5000+ for screenshots; LLM-vision-free).
 *  - `error-translator`: map raw Playwright exceptions to typed `KoiError` objects with
 *    actionable LLM guidance.
 *
 * Depends on `@koi/core` (types/factories) and `@koi/token-estimator` (CHARS_PER_TOKEN).
 *
 * Public API is wired in P1-T4 once `a11y-serializer` (P1-T2) and `error-translator`
 * (P1-T3) are ported from `archive/v1/packages/drivers/browser-playwright`.
 */

export {};
