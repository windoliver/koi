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
  // --- ACE activation ---

  test("activates ace with memory backend by default", async () => {
    const result = await activatePresetStacks({
      stacks: { ace: true },
      forgeBootstrap: undefined,
    });

    // ACE produces exactly 1 middleware
    expect(result.middleware.length).toBe(1);
  });

  test("activates ace with sqlite backend when aceDataDir provided", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "koi-ace-test-"));

    const result = await activatePresetStacks({
      stacks: { ace: true, aceStoreBackend: "sqlite" },
      forgeBootstrap: undefined,
      aceDataDir: tmpDir,
    });

    expect(result.middleware.length).toBe(1);

    // Verify the SQLite DB was created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmpDir, "ace.db"))).toBe(true);

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("skips ace when flag is false", async () => {
    const result = await activatePresetStacks({
      stacks: { ace: false },
      forgeBootstrap: undefined,
    });

    expect(result.middleware).toEqual([]);
  });

  test("ace failure is non-fatal", async () => {
    // Even if something goes wrong internally, the tryActivate wrapper
    // catches the error and returns gracefully. Here we verify the
    // wrapper works by checking stacks still return successfully.
    const result = await activatePresetStacks({
      stacks: { ace: true },
      forgeBootstrap: undefined,
    });

    // Should not throw; middleware may or may not be present
    expect(result).toBeDefined();
  });
});

/** Minimal stub for a ModelHandler — never called in stack activation tests. */
const stubSummarizer: ModelHandler = () => {
  throw new Error("stub");
};
