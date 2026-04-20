import { describe, expect, test } from "bun:test";
import { filterModels, formatModelRow } from "./ModelPicker.js";

describe("filterModels", () => {
  const models = [
    { id: "anthropic/claude-sonnet-4-6", contextLength: 200000 },
    { id: "anthropic/claude-opus-4-7" },
    { id: "openai/gpt-5" },
  ];

  test("empty query returns all models unchanged", () => {
    expect(filterModels(models, "")).toEqual(models);
  });

  test("filters by substring subsequence (fuzzy)", () => {
    // "gpt" only appears as a subsequence in "openai/gpt-5".
    const result = filterModels(models, "gpt");
    expect(result.map((m) => m.id)).toEqual(["openai/gpt-5"]);
  });

  test("returns empty when nothing matches", () => {
    expect(filterModels(models, "zzz")).toEqual([]);
  });
});

describe("formatModelRow", () => {
  test("shows id only when no metadata", () => {
    expect(formatModelRow({ id: "openai/gpt-5" })).toBe("openai/gpt-5");
  });

  test("includes context length when present", () => {
    expect(formatModelRow({ id: "anthropic/claude-opus-4-7", contextLength: 200000 })).toBe(
      "anthropic/claude-opus-4-7  ·  200k ctx",
    );
  });

  test("includes pricing when present", () => {
    expect(
      formatModelRow({
        id: "anthropic/claude-opus-4-7",
        contextLength: 200000,
        pricingIn: 0.000015,
        pricingOut: 0.000075,
      }),
    ).toBe("anthropic/claude-opus-4-7  ·  200k ctx  ·  $15/$75 per 1M");
  });
});
