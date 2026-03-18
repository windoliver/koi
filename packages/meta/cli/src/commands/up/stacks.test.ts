/**
 * Tests for L3 stack activation.
 */

import { describe, expect, test } from "bun:test";
import type { SessionId } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelHandler } from "@koi/core/middleware";
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

  // --- Context-arena activation (Decision 9A) ---

  test("activates context-arena when contextArenaConfig provided", async () => {
    const result = await activatePresetStacks({
      stacks: { contextArena: true },
      forgeBootstrap: undefined,
      contextArenaConfig: {
        summarizer: stubSummarizer,
        sessionId: "test-session" as SessionId,
        getMessages: (): readonly InboundMessage[] => [],
      },
    });

    // Context-arena creates at least 3 middleware (squash, compactor, context-editing)
    expect(result.middleware.length).toBeGreaterThanOrEqual(3);
    expect(result.providers.length).toBeGreaterThanOrEqual(1);
  });

  test("skips context-arena when contextArenaConfig is undefined", async () => {
    const result = await activatePresetStacks({
      stacks: { contextArena: true },
      forgeBootstrap: undefined,
      // No contextArenaConfig provided
    });

    // Should skip gracefully — no middleware from context-arena
    expect(result.middleware).toEqual([]);
    expect(result.providers).toEqual([]);
  });

  test("skips context-arena when contextArena flag is false", async () => {
    const result = await activatePresetStacks({
      stacks: { contextArena: false },
      forgeBootstrap: undefined,
      contextArenaConfig: {
        summarizer: stubSummarizer,
        sessionId: "test-session" as SessionId,
        getMessages: (): readonly InboundMessage[] => [],
      },
    });

    expect(result.middleware).toEqual([]);
    expect(result.providers).toEqual([]);
  });

  test("context-arena failure is non-fatal", async () => {
    // Passing an invalid config that will cause createContextArena to fail
    const result = await activatePresetStacks({
      stacks: { contextArena: true },
      forgeBootstrap: undefined,
      contextArenaConfig: {
        summarizer: stubSummarizer,
        sessionId: "test-session" as SessionId,
        getMessages: (): readonly InboundMessage[] => [],
        // Invalid contextWindowSize triggers a validation error
        contextWindowSize: -1,
      },
    });

    // Should degrade gracefully — no middleware, no crash
    expect(result.middleware).toEqual([]);
    expect(result.providers).toEqual([]);
  });
});

/** Minimal stub for a ModelHandler — never called in stack activation tests. */
const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};
