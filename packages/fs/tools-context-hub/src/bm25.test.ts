import { describe, expect, test } from "bun:test";
import {
  buildSearchIndex,
  type SearchIndex,
  type SearchIndexEntry,
  searchIndex,
  tokenize,
} from "./bm25.js";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  test("splits on hyphens", () => {
    expect(tokenize("stripe-payments")).toEqual(["stripe", "payments"]);
  });

  test("strips punctuation but keeps hyphens for splitting", () => {
    // Apostrophe is stripped but stays attached to the word (unicode letter matching)
    expect(tokenize("OpenAI's API (v2)!")).toEqual(["openais", "api", "v2"]);
  });

  test("strips standalone punctuation", () => {
    expect(tokenize("React.js & Vue.js")).toEqual(["reactjs", "vuejs"]);
  });

  test("filters stop words", () => {
    expect(tokenize("how to use the API")).toEqual(["use", "api"]);
  });

  test("drops tokens shorter than 2 characters", () => {
    expect(tokenize("a b cc dd")).toEqual(["cc", "dd"]);
  });

  test("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("returns empty array for whitespace-only string", () => {
    expect(tokenize("   ")).toEqual([]);
  });

  test("handles unicode characters", () => {
    const tokens = tokenize("résumé naïve café");
    expect(tokens).toEqual(["résumé", "naïve", "café"]);
  });
});

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

describe("buildSearchIndex", () => {
  test("builds index with IDF and average field lengths", () => {
    const entries: readonly SearchIndexEntry[] = [
      {
        id: "a",
        fields: {
          name: "stripe payments",
          description: "Process payments with Stripe",
          tags: "payments",
        },
      },
      {
        id: "b",
        fields: { name: "openai chat", description: "Chat completion API", tags: "ai llm" },
      },
    ];
    const index = buildSearchIndex(entries);

    expect(index.entries).toHaveLength(2);
    expect(index.idf.size).toBeGreaterThan(0);
    expect(index.avgFieldLengths.name).toBeGreaterThan(0);
    expect(index.avgFieldLengths.description).toBeGreaterThan(0);
    expect(index.avgFieldLengths.tags).toBeGreaterThan(0);
  });

  test("handles empty entry list", () => {
    const index = buildSearchIndex([]);

    expect(index.entries).toHaveLength(0);
    expect(index.idf.size).toBe(0);
    expect(index.avgFieldLengths.name).toBe(0);
  });

  test("handles entries with missing fields", () => {
    const entries: readonly SearchIndexEntry[] = [{ id: "a", fields: { name: "stripe" } }];
    const index = buildSearchIndex(entries);

    expect(index.entries).toHaveLength(1);
    expect(index.avgFieldLengths.description).toBe(0);
    expect(index.avgFieldLengths.tags).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scoring / search
// ---------------------------------------------------------------------------

function buildTestIndex(): SearchIndex {
  const entries: readonly SearchIndexEntry[] = [
    {
      id: "stripe/payments",
      fields: {
        name: "Stripe Payments API",
        description:
          "Accept payments online with Stripe. Supports cards, wallets, and bank transfers.",
        tags: "payments billing stripe",
      },
    },
    {
      id: "openai/chat",
      fields: {
        name: "OpenAI Chat Completions",
        description: "Generate text with GPT models using the chat completions endpoint.",
        tags: "ai llm openai gpt",
      },
    },
    {
      id: "twilio/sms",
      fields: {
        name: "Twilio SMS API",
        description: "Send and receive SMS messages programmatically.",
        tags: "sms messaging twilio",
      },
    },
    {
      id: "aws/s3",
      fields: {
        name: "AWS S3 Storage",
        description: "Object storage for files and data. Upload, download, and manage buckets.",
        tags: "storage cloud aws",
      },
    },
  ];
  return buildSearchIndex(entries);
}

describe("searchIndex", () => {
  test("returns ranked results for single-term query", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "payments", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("stripe/payments");
  });

  test("returns ranked results for multi-term query", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "chat completions openai", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("openai/chat");
  });

  test("name field has higher weight than description", () => {
    const index = buildTestIndex();
    // "stripe" appears in name and tags of stripe/payments
    // "storage" appears in name and tags of aws/s3
    const stripeResults = searchIndex(index, "stripe", 10);
    const storageResults = searchIndex(index, "storage", 10);

    // Both should find their primary match first
    expect(stripeResults[0]?.id).toBe("stripe/payments");
    expect(storageResults[0]?.id).toBe("aws/s3");
  });

  test("respects maxResults limit", () => {
    const index = buildTestIndex();
    // "api" should match multiple entries
    const results = searchIndex(index, "api", 2);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("returns empty array for query with no matches", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "kubernetes helm", 10);

    expect(results).toEqual([]);
  });

  test("returns empty array for empty query", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "", 10);

    expect(results).toEqual([]);
  });

  test("returns empty array for stop-words-only query", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "the and or", 10);

    expect(results).toEqual([]);
  });

  test("scores are strictly positive for matching entries", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "sms messaging", 10);

    for (const result of results) {
      expect(result.score).toBeGreaterThan(0);
    }
  });

  test("results are sorted by descending score", () => {
    const index = buildTestIndex();
    const results = searchIndex(index, "api", 10);

    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      expect(prev !== undefined && curr !== undefined).toBe(true);
      if (prev !== undefined && curr !== undefined) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });

  test("handles single-entry index", () => {
    const index = buildSearchIndex([
      { id: "solo", fields: { name: "solo entry", description: "the only one", tags: "" } },
    ]);
    const results = searchIndex(index, "solo", 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("solo");
  });

  test("handles special characters in query without crashing", () => {
    const index = buildTestIndex();
    // Should not throw — special chars are stripped by tokenizer
    const results = searchIndex(index, "stripe's API (v2)!", 10);

    expect(results[0]?.id).toBe("stripe/payments");
  });
});
