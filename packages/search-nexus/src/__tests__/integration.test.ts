/**
 * Integration tests for @koi/search-nexus against a live Nexus instance.
 *
 * Gated by NEXUS_TEST_URL env var. Skipped in CI unless configured.
 */

import { describe, expect, it } from "bun:test";
import { createNexusSearch } from "../nexus-search.js";

const NEXUS_URL = process.env.NEXUS_TEST_URL;
const NEXUS_KEY = process.env.NEXUS_TEST_KEY ?? "test-key";

describe.skipIf(!NEXUS_URL)("integration: Nexus search", () => {
  if (NEXUS_URL === undefined) return;

  const search = createNexusSearch({
    baseUrl: NEXUS_URL,
    apiKey: NEXUS_KEY,
    retry: {
      maxRetries: 1,
      initialDelayMs: 500,
      backoffMultiplier: 2,
      maxBackoffMs: 2000,
      jitter: false,
    },
  });

  it("healthCheck returns healthy", async () => {
    const result = await search.healthCheck();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.healthy).toBe(true);
  });

  it("indexes documents", async () => {
    const result = await search.indexer.index([
      { id: "integ-1", content: "Integration test document one" },
      { id: "integ-2", content: "Integration test document two" },
      { id: "integ-3", content: "Integration test document three" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("retrieves indexed documents", async () => {
    const result = await search.retriever.retrieve({
      text: "integration test document",
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThanOrEqual(1);
  });

  it("getStats returns document count", async () => {
    const result = await search.getStats();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentCount).toBeGreaterThanOrEqual(0);
  });

  it("removes indexed documents", async () => {
    const result = await search.indexer.remove(["integ-1", "integ-2", "integ-3"]);
    expect(result.ok).toBe(true);
  });

  it("reindex triggers without error", async () => {
    const result = await search.reindex();
    expect(result.ok).toBe(true);
  });

  it("close does not throw", () => {
    expect(() => search.close()).not.toThrow();
  });
});
