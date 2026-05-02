import { describe, expect, test } from "bun:test";
import { createRelevanceScorer, defaultTokenize } from "./relevance.js";
import type { DistillationRecord, SkillDraft } from "./types.js";

const draft = (overrides: Partial<SkillDraft>): SkillDraft => ({
  name: "x",
  description: "x",
  triggers: [],
  parameters: [],
  toolSequence: [],
  expectedInputs: [],
  expectedOutputs: [],
  ...overrides,
});

const record = (d: Partial<SkillDraft>): DistillationRecord => ({
  draft: draft(d),
  source: { traceId: "t", timestamp: 0, sourceHash: "src" },
  draftHash: "h",
});

describe("defaultTokenize", () => {
  test("lowercases, splits whitespace, drops short tokens and stopwords", () => {
    expect(defaultTokenize("The Quick Brown FOX jumps")).toEqual([
      "quick",
      "brown",
      "fox",
      "jumps",
    ]);
  });

  test("treats punctuation as whitespace", () => {
    expect(defaultTokenize("foo,bar; baz!")).toEqual(["foo", "bar", "baz"]);
  });

  test("returns empty array for empty input", () => {
    expect(defaultTokenize("")).toEqual([]);
  });
});

describe("createRelevanceScorer.score", () => {
  test("returns 0 when query has no tokens", () => {
    const s = createRelevanceScorer();
    expect(s.score("the and a", record({ name: "format-pr", description: "format" }))).toBe(0);
  });

  test("returns 0 when no token overlap", () => {
    const s = createRelevanceScorer();
    expect(
      s.score("kubernetes deploy", record({ name: "format-pr", description: "format pr" })),
    ).toBe(0);
  });

  test("higher score when more tokens overlap", () => {
    const s = createRelevanceScorer();
    const partial = s.score(
      "format pr",
      record({ name: "format-pr", description: "tweak description" }),
    );
    const full = s.score("format pr", record({ name: "format-pr", description: "format pr" }));
    expect(full).toBeGreaterThan(partial);
  });

  test("trigger phrase substring adds bonus", () => {
    const s = createRelevanceScorer({ triggerPhraseBonus: 0.5 });
    const r = record({ name: "format-pr", description: "format pr", triggers: ["format pr"] });
    const withMatch = s.score("please format pr now", r);
    const withoutMatch = s.score("please pr format now", r);
    // Same tokens in both queries → identical jaccard; only the substring bonus differs.
    expect(withMatch - withoutMatch).toBeCloseTo(0.5, 5);
  });

  test("custom tokenizer is honored", () => {
    // identity tokenizer that returns the literal input as a single token —
    // proves the custom function is wired in and the default is not consulted.
    const s = createRelevanceScorer({ tokenize: (t) => [t] });
    const r = record({ name: "alpha", description: "alpha" });
    // recordCorpus = "alpha alpha " — single-token under our tokenizer.
    expect(s.score("alpha alpha ", r)).toBeGreaterThan(0);
    // mismatched literal → 0
    expect(s.score("beta", r)).toBe(0);
  });
});

describe("createRelevanceScorer.rank", () => {
  test("returns descending scores, excludes zero-score records", () => {
    const s = createRelevanceScorer();
    const records: readonly DistillationRecord[] = [
      record({ name: "deploy", description: "deploy kubernetes" }),
      record({ name: "format-pr", description: "format pr" }),
      record({ name: "unrelated", description: "playing music" }),
    ];
    const ranked = s.rank("format pr", records);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.record.draft.name).toBe("format-pr");
  });

  test("topN limits result size", () => {
    const s = createRelevanceScorer();
    const records = Array.from({ length: 5 }, (_, i) =>
      record({ name: `skill-${i}`, description: `format pr ${i}` }),
    );
    expect(s.rank("format pr", records, 2).length).toBe(2);
  });
});
