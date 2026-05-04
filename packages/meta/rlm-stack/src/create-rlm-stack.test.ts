import { describe, expect, it } from "bun:test";
import type { SandboxExecutor } from "@koi/core/sandbox-executor";
import { createRlmStack } from "./create-rlm-stack.js";
import { CHUNK_CHARS_BY_TIER, DEFAULT_CONTEXT_WINDOW_TOKENS } from "./types.js";

describe("createRlmStack", () => {
  it("returns a KoiMiddleware in the koi:rlm slot", () => {
    const stack = createRlmStack({
      contextWindowTokens: 200_000,
      acknowledgeSegmentLocalContract: true,
    });
    expect(stack.middleware.name).toBe("koi:rlm");
    expect(typeof stack.middleware.wrapModelCall).toBe("function");
  });

  it("defaults the tier to standard with the matching chunk size", () => {
    const stack = createRlmStack({ contextWindowTokens: 100_000 });
    expect(stack.tier).toBe("standard");
    expect(stack.thresholds.maxChunkChars).toBe(CHUNK_CHARS_BY_TIER.standard);
  });

  it("propagates the requested tier into thresholds", () => {
    expect(createRlmStack({ tier: "light" }).thresholds.maxChunkChars).toBe(
      CHUNK_CHARS_BY_TIER.light,
    );
    expect(createRlmStack({ tier: "standard" }).thresholds.maxChunkChars).toBe(
      CHUNK_CHARS_BY_TIER.standard,
    );
    expect(createRlmStack({ tier: "aggressive" }).thresholds.maxChunkChars).toBe(
      CHUNK_CHARS_BY_TIER.aggressive,
    );
  });

  it("uses the configured context window for maxInputTokens so RLM only fires at 100% pressure", () => {
    const stack = createRlmStack({ contextWindowTokens: 200_000 });
    expect(stack.thresholds.contextWindowTokens).toBe(200_000);
    expect(stack.thresholds.maxInputTokens).toBe(200_000);
  });

  it("falls back to a built-in default context window when none is supplied and no modelId resolves one", () => {
    const stack = createRlmStack();
    expect(stack.thresholds.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(stack.thresholds.maxInputTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it("resolves the context window from modelId via @koi/model-registry when contextWindowTokens is omitted", () => {
    // claude-opus-4-6 advertises a 1M token window in the registry
    const stack = createRlmStack({ modelId: "claude-opus-4-6" });
    expect(stack.thresholds.contextWindowTokens).toBe(1_000_000);
    expect(stack.thresholds.maxInputTokens).toBe(1_000_000);
  });

  it("for known modelIds, registry/override window wins over contextWindowTokens (matches @koi/context-manager precedence)", () => {
    // Known model: registry says 1M, caller passes 64k contextWindowTokens — registry wins
    // so RLM stays in sync with @koi/context-manager. Use modelWindowOverrides to override
    // both layers in lock-step.
    const stack = createRlmStack({
      modelId: "claude-opus-4-6",
      contextWindowTokens: 64_000,
    });
    expect(stack.thresholds.contextWindowTokens).toBe(1_000_000);
  });

  it("uses contextWindowTokens when no modelId is supplied", () => {
    const stack = createRlmStack({ contextWindowTokens: 64_000 });
    expect(stack.thresholds.contextWindowTokens).toBe(64_000);
  });

  it("delegates unknown modelIds to context-manager's resolveThresholds (returns the model-registry default)", () => {
    // Pure delegation — RLM and context-manager agree byte-for-byte on the
    // window for unknown ids. Callers needing a different window for private
    // models must supply modelWindowOverrides for both layers in lock-step.
    const stack = createRlmStack({ modelId: "my-private-model" });
    expect(stack.thresholds.contextWindowTokens).toBe(128_000);
  });

  it("treats prefixed modelIds the same way @koi/context-manager does (no normalization)", () => {
    // Both layers see the prefixed id as unknown and fall back to the registry
    // default. Callers using prefixed ids must either pre-normalize at the call
    // site or supply modelWindowOverrides (keyed identically in both layers).
    const stack = createRlmStack({ modelId: "anthropic:claude-opus-4-6" });
    expect(stack.thresholds.contextWindowTokens).toBe(128_000);
  });

  it("uses the bare modelId verbatim — does NOT auto-strip provider prefixes", () => {
    // Pure delegation to @koi/context-manager which does not strip prefixes.
    // Callers must use bare ids (or supply modelWindowOverrides in matching form)
    // so RLM and context-manager resolve the same window.
    const bare = createRlmStack({ modelId: "claude-opus-4-6" });
    expect(bare.thresholds.contextWindowTokens).toBe(1_000_000);
  });

  it("honors modelWindowOverrides ahead of registry data, matching context-manager semantics", () => {
    const stack = createRlmStack({
      modelId: "claude-opus-4-6",
      modelWindowOverrides: { "claude-opus-4-6": 32_000 },
    });
    expect(stack.thresholds.contextWindowTokens).toBe(32_000);
  });

  it("honors a prefixed modelWindowOverrides key against the same prefixed modelId", () => {
    // Both layers honor the override map keyed by whatever form the caller
    // uses, as long as the same key shape is used everywhere.
    const stack = createRlmStack({
      modelId: "anthropic:claude-opus-4-6",
      modelWindowOverrides: { "anthropic:claude-opus-4-6": 48_000 },
    });
    expect(stack.thresholds.contextWindowTokens).toBe(48_000);
  });

  it("propagates the priority forwarded to RLM middleware", () => {
    const stack = createRlmStack({ priority: 950 });
    expect(stack.middleware.priority).toBe(950);
  });

  it("rejects priorities below DEFAULT_PRIORITY to preserve the tool-fanout safety invariant", () => {
    // Lowering RLM below DEFAULT_PRIORITY would let it segment before
    // tool-injecting middleware materialized request.tools, multiplying
    // tool side effects across segments. The stack must refuse this
    // configuration up front.
    expect(() => createRlmStack({ priority: 100 })).toThrow(/priority|DEFAULT_PRIORITY/);
    expect(() => createRlmStack({ priority: 799 })).toThrow(/priority|DEFAULT_PRIORITY/);
  });

  it("accepts priority equal to DEFAULT_PRIORITY (the floor) and above", () => {
    expect(() => createRlmStack({ priority: 800 })).not.toThrow();
    expect(() => createRlmStack({ priority: 9_999 })).not.toThrow();
  });

  it("rejects non-finite priorities", () => {
    expect(() => createRlmStack({ priority: Number.NaN })).toThrow(/finite/);
    expect(() => createRlmStack({ priority: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });

  it("exposes a sandboxExecutor on the stack handle when provided (forward-compat, not wired)", () => {
    const sandboxExecutor: SandboxExecutor = {
      execute: async () => ({
        ok: false,
        error: { code: "CRASH", message: "stub", durationMs: 0 },
      }),
    };
    const stack = createRlmStack({ sandboxExecutor });
    expect(stack.sandboxExecutor).toBe(sandboxExecutor);
  });

  it("leaves sandboxExecutor undefined by default", () => {
    const stack = createRlmStack();
    expect(stack.sandboxExecutor).toBeUndefined();
  });

  it("rejects unknown tiers at runtime (defensive — config typing should prevent this)", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the runtime guard
      createRlmStack({ tier: "ludicrous" as any }),
    ).toThrow(/unknown tier/i);
  });

  it("rejects non-positive contextWindowTokens", () => {
    expect(() => createRlmStack({ contextWindowTokens: 0 })).toThrow(/contextWindowTokens/);
    expect(() => createRlmStack({ contextWindowTokens: -1 })).toThrow(/contextWindowTokens/);
  });

  it("rejects modelWindowOverrides values that resolve to non-positive or non-finite windows", () => {
    expect(() =>
      createRlmStack({
        modelId: "claude-opus-4-6",
        modelWindowOverrides: { "claude-opus-4-6": 0 },
      }),
    ).toThrow(/positive finite/i);
    expect(() =>
      createRlmStack({
        modelId: "claude-opus-4-6",
        modelWindowOverrides: { "claude-opus-4-6": Number.NaN },
      }),
    ).toThrow(/positive finite/i);
    expect(() =>
      createRlmStack({
        modelId: "claude-opus-4-6",
        modelWindowOverrides: { "claude-opus-4-6": -1 },
      }),
    ).toThrow(/positive finite/i);
  });
});

describe("createRlmStack — context-manager coordination", () => {
  it("places the virtualize threshold strictly above context-manager's hard compact threshold", () => {
    // Assertion of the architectural contract: when a request crosses 75% of the
    // window context-manager is expected to compact; RLM's virtualize threshold
    // must sit above that so the two systems do not fight.
    const stack = createRlmStack({ contextWindowTokens: 200_000 });
    // hard compact fires at 75% by default
    const hardCompactThreshold = 200_000 * 0.75;
    expect(stack.thresholds.maxInputTokens).toBeGreaterThan(hardCompactThreshold);
  });
});
