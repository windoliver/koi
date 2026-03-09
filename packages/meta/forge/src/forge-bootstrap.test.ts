/**
 * Tests for the forge bootstrap factory.
 *
 * Covers: Decision #1 (shared factory), Decision #8A (graceful degradation).
 */

import { describe, expect, mock, test } from "bun:test";
import { createForgeBootstrap } from "./forge-bootstrap.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopExecutor = {
  execute: async () => ({ ok: true as const, value: { output: undefined, durationMs: 0 } }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeBootstrap", () => {
  test("returns undefined when forge is disabled", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
      forgeConfig: { enabled: false },
    });
    expect(result).toBeUndefined();
  });

  test("returns ForgeBootstrapResult when forge is enabled", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
      forgeConfig: { enabled: true },
    });
    expect(result).not.toBeUndefined();
    expect(result?.runtime).toBeDefined();
    expect(result?.middlewares).toBeDefined();
    expect(result?.provider).toBeDefined();
    expect(result?.store).toBeDefined();
    expect(result?.system).toBeDefined();
  });

  test("uses default config when no overrides provided", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
    });
    // Default config has enabled: true
    expect(result).not.toBeUndefined();
  });

  test("uses provided store instead of creating in-memory", () => {
    const customStore = {
      save: mock(async () => ({ ok: true as const, value: undefined })),
      load: mock(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
      })),
      search: mock(async () => ({ ok: true as const, value: [] })),
      remove: mock(async () => ({ ok: true as const, value: undefined })),
      update: mock(async () => ({ ok: true as const, value: undefined })),
      exists: mock(async () => ({ ok: true as const, value: false })),
    };

    const result = createForgeBootstrap({
      executor: noopExecutor,
      store: customStore,
    });

    expect(result).not.toBeUndefined();
    expect(result?.store).toBe(customStore);
  });

  test("gracefully degrades on initialization failure (Decision #8A)", () => {
    const onError = mock((_err: unknown) => {});
    const badExecutor = {
      execute: () => {
        throw new Error("executor broken");
      },
    };

    // The bootstrap itself shouldn't throw even if internal components have issues
    // since the executor is only called at forge-time, not at bootstrap
    const result = createForgeBootstrap({
      executor: badExecutor,
      onError,
    });

    // Should still succeed because executor isn't invoked during bootstrap
    expect(result).not.toBeUndefined();
  });

  test("returns runtime compatible with createKoi forge option", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
    });

    expect(result).not.toBeUndefined();
    // ForgeRuntime interface requires resolveTool and toolDescriptors
    expect(typeof result?.runtime.resolveTool).toBe("function");
    expect(typeof result?.runtime.toolDescriptors).toBe("function");
  });

  test("returns middleware array (may be empty)", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
    });

    expect(result).not.toBeUndefined();
    expect(Array.isArray(result?.middlewares)).toBe(true);
  });

  test("returns provider with name", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
    });

    expect(result).not.toBeUndefined();
    expect(result?.provider.name).toBe("forge");
  });

  test("uses provided scope", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
      scope: "global",
    });

    expect(result).not.toBeUndefined();
  });

  test("dispose tears down runtime and provider subscriptions", () => {
    const result = createForgeBootstrap({
      executor: noopExecutor,
    });

    expect(result).not.toBeUndefined();
    expect(typeof result?.dispose).toBe("function");
    // Should not throw
    result?.dispose();
    // Calling dispose again is safe (idempotent)
    result?.dispose();
  });
});
