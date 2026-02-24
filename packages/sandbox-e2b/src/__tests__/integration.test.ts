import { describe, expect, test } from "bun:test";

/**
 * Integration tests for E2B cloud sandbox.
 *
 * Requires E2B_API_KEY environment variable. Skipped in CI — run manually:
 *   E2B_API_KEY=... bun test packages/sandbox-e2b/src/__tests__/integration.test.ts
 */

const hasApiKey = process.env.E2B_API_KEY !== undefined;

describe.skipIf(!hasApiKey)("E2B integration", () => {
  test("placeholder for real E2B SDK integration", () => {
    expect(hasApiKey).toBe(true);
  });
});
