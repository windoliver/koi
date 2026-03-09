/**
 * Test setup — re-exports @testing-library/react utilities and auto-cleanup.
 *
 * Import from this module in test files:
 *   import { render, screen, cleanup } from "../../__tests__/setup.js";
 *
 * DOM globals are initialized by the preload script (dom-env.ts) configured
 * in bunfig.toml, so they're available before @testing-library/react loads.
 *
 * Pattern: All new viewer component tests should use renderWithProviders()
 * from render-helpers.ts instead of raw render() to get Zustand + QueryClient.
 */

import { afterEach } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

// Auto-cleanup after each test to prevent leaks
afterEach(() => {
  cleanup();
});

export { render, screen, cleanup };
