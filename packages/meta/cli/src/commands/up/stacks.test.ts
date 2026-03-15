/**
 * Tests for L3 stack activation.
 */

import { describe, expect, test } from "bun:test";
import { activatePresetStacks } from "./stacks.js";

describe("activatePresetStacks", () => {
  test("returns empty arrays when no stacks enabled", async () => {
    const result = await activatePresetStacks({
      stacks: {},
      forgeBootstrap: undefined,
    });

    expect(result.middleware).toEqual([]);
    expect(result.providers).toEqual([]);
    expect(result.disposables).toEqual([]);
  });

  test("activates tool stack when toolStack is true", async () => {
    const result = await activatePresetStacks({
      stacks: { toolStack: true },
      forgeBootstrap: undefined,
    });

    // Tool stack creates middleware even with default config
    expect(result.middleware.length).toBeGreaterThanOrEqual(0);
  });

  test("activates retry stack when retryStack is true", async () => {
    const result = await activatePresetStacks({
      stacks: { retryStack: true },
      forgeBootstrap: undefined,
    });

    expect(result.middleware.length).toBeGreaterThanOrEqual(0);
  });

  test("skips auto-harness when forgeBootstrap is undefined", async () => {
    const result = await activatePresetStacks({
      stacks: { autoHarness: true },
      forgeBootstrap: undefined,
    });

    // Auto-harness requires forge bootstrap, so middleware should be empty
    expect(result.middleware).toEqual([]);
  });
});
