import { describe, expect, test } from "bun:test";
import type { ModelCompatRule } from "./model-compat.js";
import { applyModelCompatRules } from "./model-compat.js";
import { resolveCompat } from "./types.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const UNKNOWN_BASE = "https://unknown-provider.example.com/v1";

describe("applyModelCompatRules", () => {
  test("returns base unchanged when no rules match", () => {
    const rules: readonly ModelCompatRule[] = [
      { match: /copilot/i, overrides: { supportsToolStreaming: false } },
    ];
    const base = resolveCompat(OR_BASE, "anthropic/claude-sonnet-4");
    const result = applyModelCompatRules("anthropic/claude-sonnet-4", base, rules);
    expect(result).toBe(base);
  });

  test("applies first matching rule, ignores subsequent matches", () => {
    const rules: readonly ModelCompatRule[] = [
      { match: /copilot/i, overrides: { supportsToolStreaming: false } },
      { match: /copilot/i, overrides: { supportsToolStreaming: true } },
    ];
    const base = resolveCompat(OR_BASE, "copilot/gpt-4");
    const result = applyModelCompatRules("copilot/gpt-4", base, rules);
    expect(result.supportsToolStreaming).toBe(false);
  });

  test("global-flag regex matches stably on repeated calls (lastIndex defense)", () => {
    // RegExp with /g flag has stateful lastIndex. Without reset, test() alternates
    // match/no-match on repeated calls with the same string. Verify the fix holds.
    const rules: readonly ModelCompatRule[] = [
      { match: /copilot/gi, overrides: { supportsToolStreaming: false } },
    ];
    const base = resolveCompat(OR_BASE, "copilot/gpt-4");
    // Call three times with the same model — all must return the override
    const r1 = applyModelCompatRules("copilot/gpt-4", base, rules);
    const r2 = applyModelCompatRules("copilot/gpt-4", base, rules);
    const r3 = applyModelCompatRules("copilot/gpt-4", base, rules);
    expect(r1.supportsToolStreaming).toBe(false);
    expect(r2.supportsToolStreaming).toBe(false);
    expect(r3.supportsToolStreaming).toBe(false);
  });

  test("only overrides specified fields; others fall through", () => {
    const rules: readonly ModelCompatRule[] = [
      { match: /weird-model/i, overrides: { supportsToolStreaming: false } },
    ];
    const base = resolveCompat(OR_BASE, "weird-model");
    const result = applyModelCompatRules("weird-model", base, rules);
    expect(result.supportsToolStreaming).toBe(false);
    expect(result.supportsPromptCaching).toBe(base.supportsPromptCaching);
    expect(result.thinkingDisplay).toBe("full");
  });
});

describe("resolveCompat — three-layer precedence", () => {
  test("new fields default to safe values for unknown provider", () => {
    const result = resolveCompat(UNKNOWN_BASE, "any/model");
    expect(result.supportsToolStreaming).toBe(true);
    expect(result.thinkingDisplay).toBe("full");
  });

  test("new fields default to safe values for OpenRouter", () => {
    const result = resolveCompat(OR_BASE, "anthropic/claude-sonnet-4");
    expect(result.supportsToolStreaming).toBe(true);
    expect(result.thinkingDisplay).toBe("full");
  });

  test("caller override wins — supportsToolStreaming", () => {
    const result = resolveCompat(OR_BASE, "any/model", { supportsToolStreaming: false });
    expect(result.supportsToolStreaming).toBe(false);
    expect(result.supportsPromptCaching).toBe(true);
  });

  test("caller override wins — thinkingDisplay", () => {
    const result = resolveCompat(OR_BASE, "any/model", { thinkingDisplay: "hidden" });
    expect(result.thinkingDisplay).toBe("hidden");
  });

  test("caller override wins over both layers — both fields", () => {
    const result = resolveCompat(OR_BASE, "any/model", {
      supportsToolStreaming: false,
      thinkingDisplay: "summarized",
    });
    expect(result.supportsToolStreaming).toBe(false);
    expect(result.thinkingDisplay).toBe("summarized");
    expect(result.supportsPromptCaching).toBe(true);
  });

  test("unknown model passes through with zero model overrides applied", () => {
    const a = resolveCompat(GROQ_BASE, "unknown/model-xyz");
    const b = resolveCompat(GROQ_BASE, "another/unknown-xyz");
    expect(a.supportsUsageInStreaming).toBe(b.supportsUsageInStreaming);
    expect(a.supportsToolStreaming).toBe(true);
  });

  test("empty MODEL_COMPAT_RULES means model param has no effect", () => {
    const a = resolveCompat(OR_BASE, "model-a");
    const b = resolveCompat(OR_BASE, "model-b");
    expect(a.supportsToolStreaming).toBe(b.supportsToolStreaming);
    expect(a.thinkingDisplay).toBe(b.thinkingDisplay);
  });
});
