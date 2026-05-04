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

  it("propagates the priority forwarded to RLM middleware", () => {
    const stack = createRlmStack({ priority: 950 });
    expect(stack.middleware.priority).toBe(950);
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
