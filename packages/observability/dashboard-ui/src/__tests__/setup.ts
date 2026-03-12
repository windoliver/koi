/**
 * Test setup — re-exports @testing-library/react utilities and auto-cleanup.
 *
 * Import from this module in test files:
 *   import { render, cleanup } from "../../__tests__/setup.js";
 *
 * DOM globals are initialized by the preload script (dom-env.ts) configured
 * in bunfig.toml, so they're available before @testing-library/react loads.
 *
 * The exported `render` wraps @testing-library/react's render to return
 * container-scoped queries (via `within(container)`) instead of queries
 * bound to document.body. This prevents "Found multiple elements" errors
 * when bun runs test files concurrently with a shared DOM.
 *
 * Pattern: All new viewer component tests should use renderWithProviders()
 * from render-helpers.ts instead of raw render() to get Zustand + QueryClient.
 */

import { afterEach } from "bun:test";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import { cleanup, render as rtlRender, within } from "@testing-library/react";

// Auto-cleanup after each test to prevent leaks
afterEach(() => {
  cleanup();
});

/**
 * Wrapper around @testing-library/react's render that returns queries
 * scoped to the render container rather than document.body.
 *
 * The upstream render() binds queries to `baseElement` (document.body by
 * default), which causes cross-file collisions when bun runs tests
 * concurrently in the same process. This wrapper replaces those queries
 * with `within(container)` equivalents so each test's queries only see
 * its own rendered output.
 */
function render(ui: React.ReactElement, options?: RenderOptions): RenderResult {
  const result = rtlRender(ui, options);
  const scopedQueries = within(result.container);
  return { ...result, ...scopedQueries };
}

export { render, cleanup };
