/**
 * Real-Nexus integration test for search.
 *
 * Skipped unless `KOI_E2E_NEXUS=1` is set. Default endpoint
 * `http://localhost:3100`; override with `KOI_NEXUS_URL`.
 *
 *   KOI_E2E_NEXUS=1 bun test packages/lib/search-nexus/src/__tests__/nexus.integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import { createHttpTransport } from "@koi/nexus-client";
import { createNexusSearch } from "../nexus-search.js";

const RUN = process.env.KOI_E2E_NEXUS === "1";
const NEXUS_URL = process.env.KOI_NEXUS_URL ?? "http://localhost:3100";
const d = RUN ? describe : describe.skip;

d("search-nexus — real Nexus integration", () => {
  test("indexes and retrieves documents end-to-end", async () => {
    const transport = createHttpTransport({ url: NEXUS_URL });
    const indexName = `e2e-search-${String(Date.now())}`;
    const search = createNexusSearch({ transport, indexName });

    const docs = [
      { id: "a", content: "alpha bravo charlie" },
      { id: "b", content: "alpha delta echo" },
      { id: "c", content: "foxtrot golf" },
    ];

    try {
      const indexResult = await search.index(docs);
      expect(indexResult.ok).toBe(true);

      const retrieveResult = await search.retrieve({ text: "alpha", limit: 10 });
      expect(retrieveResult.ok).toBe(true);
      if (retrieveResult.ok) {
        const ids = retrieveResult.value.results.map((r) => r.id);
        // alpha appears in a and b; both should rank above c.
        expect(ids).toContain("a");
        expect(ids).toContain("b");
      }
    } finally {
      await search.remove(docs.map((d) => d.id)).catch(() => {});
      transport.close();
    }
  });

  test("minScore filters at the boundary even under server version skew", async () => {
    const transport = createHttpTransport({ url: NEXUS_URL });
    const indexName = `e2e-search-min-${String(Date.now())}`;
    const search = createNexusSearch({ transport, indexName });

    const docs = [
      { id: "x", content: "needle in haystack" },
      { id: "y", content: "haystack hay" },
    ];
    try {
      await search.index(docs);
      const result = await search.retrieve({
        text: "needle",
        limit: 10,
        minScore: 0.99,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Whatever the server returns, the adapter must enforce minScore
        // client-side and clear pagination metadata if it trimmed anything.
        for (const hit of result.value.results) {
          expect(hit.score).toBeGreaterThanOrEqual(0.99);
        }
      }
    } finally {
      await search.remove(docs.map((d) => d.id)).catch(() => {});
      transport.close();
    }
  });
});
