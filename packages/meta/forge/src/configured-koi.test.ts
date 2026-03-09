/**
 * Tests for createForgeConfiguredKoi (Issue #917 Phase 0 — bootstrap integration).
 *
 * Covers:
 * - Forge enabled: runtime includes forge system, middlewares, and providers
 * - Forge disabled: delegates to createConfiguredKoi without forge overhead
 * - Missing store/executor: falls back to non-forge path
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, SandboxExecutor } from "@koi/core";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import { createMockEngineAdapter } from "@koi/test-utils";
import { createForgeConfiguredKoi } from "./configured-koi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExecutor(): SandboxExecutor {
  return {
    execute: async () => ({ ok: true, value: { output: null, durationMs: 0 } }),
  };
}

/** Minimal manifest with forge enabled (cast via intersection for runtime 'in' check). */
function makeForgeManifest(enabled: boolean): AgentManifest & { readonly forge: unknown } {
  return {
    name: "test-agent",
    version: "0.0.1",
    description: "Test agent",
    model: { name: "test-model" },
    forge: {
      enabled,
    },
  } as AgentManifest & { readonly forge: unknown };
}

/** Minimal manifest without forge section. */
const PLAIN_MANIFEST = {
  name: "test-agent",
  version: "0.0.1",
  description: "Test agent",
  model: { name: "test-model" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeConfiguredKoi", () => {
  test("forge disabled — returns runtime with no forgeSystem", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: makeForgeManifest(false),
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.runtime).toBeDefined();
    expect(result.runtime.agent).toBeDefined();
    expect(result.forgeSystem).toBeUndefined();
    await result.runtime.dispose();
  });

  test("no forge section in manifest — returns runtime with no forgeSystem", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: PLAIN_MANIFEST,
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.runtime).toBeDefined();
    expect(result.forgeSystem).toBeUndefined();
    await result.runtime.dispose();
  });

  test("forge enabled but missing forgeStore — returns runtime without forge", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: makeForgeManifest(true),
      adapter,
      // forgeStore not provided
      forgeExecutor: createMockExecutor(),
    });

    expect(result.runtime).toBeDefined();
    expect(result.forgeSystem).toBeUndefined();
    await result.runtime.dispose();
  });

  test("forge enabled but missing forgeExecutor — returns runtime without forge", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: makeForgeManifest(true),
      adapter,
      forgeStore: createInMemoryForgeStore(),
      // forgeExecutor not provided
    });

    expect(result.runtime).toBeDefined();
    expect(result.forgeSystem).toBeUndefined();
    await result.runtime.dispose();
  });

  test("forge enabled with store + executor — returns forgeSystem", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: makeForgeManifest(true),
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.runtime).toBeDefined();
    expect(result.forgeSystem).toBeDefined();

    // ForgeSystem structure validation — narrow once to avoid repeated !
    const fs = result.forgeSystem;
    if (fs === undefined) throw new Error("forgeSystem expected");
    expect(fs.runtime).toBeDefined();
    expect(fs.provider).toBeDefined();
    expect(fs.pipeline).toBeDefined();
    expect(fs.middlewares).toBeDefined();
    expect(fs.notifier).toBeDefined();
    expect(fs.handles).toBeDefined();
    expect(fs.handles.demand).toBeDefined();
    expect(fs.handles.crystallize).toBeDefined();
    expect(fs.handles.exaptation).toBeDefined();

    await result.runtime.dispose();
  });

  test("forge enabled — runtime has agent entity", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: makeForgeManifest(true),
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.runtime.agent).toBeDefined();
    expect(result.runtime.agent.pid.name).toBe("test-agent");

    await result.runtime.dispose();
  });

  test("forge enabled — notifier is wired into forge system", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: makeForgeManifest(true),
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    // Notifier should have subscribe and notify methods
    const fs = result.forgeSystem;
    if (fs === undefined) throw new Error("forgeSystem expected");
    expect(typeof fs.notifier.subscribe).toBe("function");
    expect(typeof fs.notifier.notify).toBe("function");

    await result.runtime.dispose();
  });

  test("forge enabled with maxForgesPerSession override", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: {
        ...makeForgeManifest(true),
        forge: { enabled: true, maxForgesPerSession: 10 },
      } as AgentManifest & { readonly forge: unknown },
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.forgeSystem).toBeDefined();
    await result.runtime.dispose();
  });

  test("forge enabled with defaultScope override", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: {
        ...makeForgeManifest(true),
        forge: { enabled: true, defaultScope: "zone" },
      } as AgentManifest & { readonly forge: unknown },
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.forgeSystem).toBeDefined();
    await result.runtime.dispose();
  });

  test("forge enabled with maxForgeDepth override", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: {
        ...makeForgeManifest(true),
        forge: { enabled: true, maxForgeDepth: 3 },
      } as AgentManifest & { readonly forge: unknown },
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.forgeSystem).toBeDefined();
    await result.runtime.dispose();
  });

  test("forge enabled with defaultPolicy override", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: {
        ...makeForgeManifest(true),
        forge: { enabled: true, defaultPolicy: { sandbox: false, capabilities: {} } },
      } as AgentManifest & { readonly forge: unknown },
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.forgeSystem).toBeDefined();
    await result.runtime.dispose();
  });

  test("forge enabled with scopePromotion override", async () => {
    const adapter = createMockEngineAdapter();
    const result = await createForgeConfiguredKoi({
      manifest: {
        ...makeForgeManifest(true),
        forge: { enabled: true, scopePromotion: { requireHumanApproval: false } },
      } as AgentManifest & { readonly forge: unknown },
      adapter,
      forgeStore: createInMemoryForgeStore(),
      forgeExecutor: createMockExecutor(),
    });

    expect(result.forgeSystem).toBeDefined();
    await result.runtime.dispose();
  });
});
