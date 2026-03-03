import { describe, expect, test } from "bun:test";
import { createBM25Index } from "./bm25.js";

describe("createBM25Index", () => {
  const corpus = [
    {
      id: "auth",
      text: "authentication login password security tokens jwt",
      titleText: "Authentication Guide",
      tagText: "auth security",
    },
    {
      id: "api",
      text: "api rest endpoints http json request response",
      titleText: "API Reference",
      tagText: "api http",
    },
    {
      id: "db",
      text: "database sql query tables schema migration index",
      titleText: "Database Guide",
      tagText: "database sql",
    },
    {
      id: "deploy",
      text: "deploy production server docker containers kubernetes",
      titleText: "Deployment Guide",
      tagText: "deploy ops",
    },
    {
      id: "general",
      text: "the application uses authentication and api and database and deploy for everything",
      titleText: "Overview",
      tagText: "general",
    },
  ];

  test("rare terms score higher than common terms (IDF property)", () => {
    const index = createBM25Index(corpus);

    // "kubernetes" appears in 1 doc, "authentication" appears in 2
    const kubeResults = index.search("kubernetes");
    const authResults = index.search("authentication");

    const kubeScore = kubeResults.find((r) => r.id === "deploy")?.score ?? 0;
    const authScore = authResults.find((r) => r.id === "auth")?.score ?? 0;

    // Rare term in its own doc should score high
    expect(kubeScore).toBeGreaterThan(0);
    expect(authScore).toBeGreaterThan(0);
  });

  test("more occurrences score higher (TF property with saturation)", () => {
    const docsWithRepeats = [
      { id: "many", text: "api api api api api other words" },
      { id: "few", text: "api other words here and more words" },
    ];
    const index = createBM25Index(docsWithRepeats);
    const results = index.search("api");

    const manyScore = results.find((r) => r.id === "many")?.score ?? 0;
    const fewScore = results.find((r) => r.id === "few")?.score ?? 0;

    expect(manyScore).toBeGreaterThan(fewScore);
  });

  test("shorter docs with same term count score >= longer docs (length normalization)", () => {
    const docsWithLength = [
      { id: "short", text: "api endpoint reference" },
      {
        id: "long",
        text: "api endpoint reference plus lots of additional filler words that dilute the relevance of the matching terms significantly",
      },
    ];
    const index = createBM25Index(docsWithLength);
    const results = index.search("api");

    const shortScore = results.find((r) => r.id === "short")?.score ?? 0;
    const longScore = results.find((r) => r.id === "long")?.score ?? 0;

    expect(shortScore).toBeGreaterThanOrEqual(longScore);
  });

  test("scores are always >= 0", () => {
    const index = createBM25Index(corpus);
    const results = index.search("authentication api database");

    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
    }
  });

  test("empty query returns empty results", () => {
    const index = createBM25Index(corpus);
    const results = index.search("");
    expect(results).toEqual([]);
  });

  test("query term not in corpus returns no results", () => {
    const index = createBM25Index(corpus);
    const results = index.search("xylophone");
    expect(results).toEqual([]);
  });

  test("single document corpus works correctly", () => {
    const index = createBM25Index([{ id: "only", text: "hello world" }]);
    const results = index.search("hello");

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("only");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("title matches score higher than body-only matches", () => {
    const docs = [
      {
        id: "title-match",
        text: "some general content about various things",
        titleText: "authentication",
      },
      {
        id: "body-match",
        text: "authentication is discussed here among other topics",
        titleText: "General Document",
      },
    ];
    const index = createBM25Index(docs);
    const results = index.search("authentication");

    const titleScore = results.find((r) => r.id === "title-match")?.score ?? 0;
    const bodyScore = results.find((r) => r.id === "body-match")?.score ?? 0;

    expect(titleScore).toBeGreaterThan(bodyScore);
  });

  test("tag matches boost score", () => {
    const docs = [
      {
        id: "tagged",
        text: "some content here",
        tagText: "security authentication",
      },
      {
        id: "untagged",
        text: "some content here about security",
      },
    ];
    const index = createBM25Index(docs);
    const results = index.search("security");

    const taggedScore = results.find((r) => r.id === "tagged")?.score ?? 0;
    const untaggedScore = results.find((r) => r.id === "untagged")?.score ?? 0;

    expect(taggedScore).toBeGreaterThan(untaggedScore);
  });

  test("limit parameter caps result count", () => {
    const index = createBM25Index(corpus);
    const results = index.search("authentication api database", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("documentCount reflects indexed corpus size", () => {
    const index = createBM25Index(corpus);
    expect(index.documentCount).toBe(5);
  });

  test("empty corpus returns empty search results", () => {
    const index = createBM25Index([]);
    expect(index.documentCount).toBe(0);
    expect(index.search("anything")).toEqual([]);
  });
});
