import { describe, expect, test } from "bun:test";
import type { CategoryRule } from "./category-inferrer.js";
import { createKeywordCategoryInferrer } from "./category-inferrer.js";

const infer = createKeywordCategoryInferrer();

// ---------------------------------------------------------------------------
// Table-driven: default rules
// ---------------------------------------------------------------------------

describe("createKeywordCategoryInferrer", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    // decision
    ["decision", "We chose TypeScript for the backend", "chose"],
    ["decision", "Team decided to use Bun over Node", "decided"],
    ["decision", "We settled on a monorepo layout", "settled on"],

    // error-pattern
    ["error-pattern", "Got an error when deploying to staging", "error"],
    ["error-pattern", "Build failed after upgrading tsup", "failed"],
    ["error-pattern", "The crash happens on Apple Silicon only", "crash"],

    // preference
    ["preference", "User prefers dark mode", "prefers"],
    ["preference", "She always uses Vim keybindings", "always uses"],
    ["preference", "His favourite editor is Zed", "favourite"],
    ["preference", "He dislikes auto-formatting", "dislikes"],

    // correction
    ["correction", "I corrected the import paths", "corrected"],
    ["correction", "That approach was wrong", "wrong"],
    ["correction", "That was a mistake in the config", "mistake"],

    // milestone
    ["milestone", "v2.0 shipped to production today", "shipped"],
    ["milestone", "We deployed the new auth flow", "deployed"],
    ["milestone", "Feature complete — all tests green", "complete"],

    // relationship
    ["relationship", "Alice works with the infra team", "works with"],
    ["relationship", "Bob reports to Carol", "reports to"],
    ["relationship", "Dana manages the frontend guild", "manages"],
    ["relationship", "The team owns the CI pipeline", "team"],
  ];

  test.each(cases)("returns %s for content with '%s' keyword (%s)", (expected, content) => {
    expect(infer(content)).toBe(expected);
  });

  // ---------------------------------------------------------------------------
  // Fallback
  // ---------------------------------------------------------------------------

  describe("fallback", () => {
    test("returns 'context' for unmatched text", () => {
      expect(infer("The sky is blue")).toBe("context");
    });

    test("returns 'context' for empty string", () => {
      expect(infer("")).toBe("context");
    });
  });

  // ---------------------------------------------------------------------------
  // Case insensitivity
  // ---------------------------------------------------------------------------

  describe("case insensitivity", () => {
    test("matches uppercase keywords", () => {
      expect(infer("We CHOSE to go with Bun")).toBe("decision");
    });

    test("matches mixed-case keywords", () => {
      expect(infer("Build Failed on CI")).toBe("error-pattern");
    });
  });

  // ---------------------------------------------------------------------------
  // First-match-wins ordering
  // ---------------------------------------------------------------------------

  describe("ordering", () => {
    test("first matching rule wins when content has multiple category keywords", () => {
      // "chose" → decision, "error" → error-pattern — decision appears first in rules
      expect(infer("We chose to ignore that error")).toBe("decision");
    });
  });

  // ---------------------------------------------------------------------------
  // Config: additionalRules
  // ---------------------------------------------------------------------------

  describe("additionalRules", () => {
    test("custom rules take priority over defaults", () => {
      const customRule: CategoryRule = {
        category: "security",
        pattern: /\b(?:vulnerability|CVE|exploit)\b/i,
      };
      const customInfer = createKeywordCategoryInferrer({
        additionalRules: [customRule],
      });
      expect(customInfer("Found a vulnerability in auth")).toBe("security");
    });

    test("falls through to default rules when custom rules don't match", () => {
      const customRule: CategoryRule = {
        category: "security",
        pattern: /\bCVE\b/i,
      };
      const customInfer = createKeywordCategoryInferrer({
        additionalRules: [customRule],
      });
      expect(customInfer("We chose Bun")).toBe("decision");
    });
  });

  // ---------------------------------------------------------------------------
  // Config: custom fallback
  // ---------------------------------------------------------------------------

  describe("custom fallback", () => {
    test("uses provided fallback instead of 'context'", () => {
      const customInfer = createKeywordCategoryInferrer({ fallback: "general" });
      expect(customInfer("The sky is blue")).toBe("general");
    });
  });
});
