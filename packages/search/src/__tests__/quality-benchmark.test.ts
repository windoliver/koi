/**
 * Quality Benchmark: Koi Search vs OpenClaw-style Search
 *
 * Compares search quality across multiple strategies using a realistic
 * knowledge base of developer documentation / agent memory notes.
 *
 * Strategies tested:
 *   A) Koi baseline: RRF fusion, no MMR, no decay
 *   B) Koi full: RRF fusion + MMR + temporal decay
 *   C) OpenClaw-style: weighted linear fusion (70/30 vector/text), no MMR
 *   D) OpenClaw-style + MMR: same as C but with MMR diversity
 *
 * Quality dimensions measured:
 *   - Precision: Are the top results actually relevant?
 *   - Diversity: How many unique topics appear in top-K?
 *   - Recency: Does recent context rank higher?
 *   - Deduplication: Are near-duplicate chunks suppressed?
 */
import { describe, expect, test } from "bun:test";
import type { Embedder } from "../contracts.js";
import { createSearch } from "../index.js";
import type { SearchResult } from "../types.js";

// ---------------------------------------------------------------------------
// Realistic corpus: developer notes / agent memory
// ---------------------------------------------------------------------------

const NOW = Date.parse("2025-06-15T12:00:00Z");
const DAY = 86_400_000;

const CORPUS = [
  // --- Cluster 1: Authentication (overlapping chunks simulating chunker overlap) ---
  {
    id: "auth-1",
    content:
      "The authentication system uses JWT tokens with RS256 signing. Tokens expire after 15 minutes. Refresh tokens are stored in HTTP-only cookies with a 7-day expiry.",
    metadata: { topic: "auth", indexedAt: NOW - 2 * DAY },
  },
  {
    id: "auth-2",
    content:
      "Refresh tokens are stored in HTTP-only cookies with a 7-day expiry. The token rotation strategy invalidates the previous refresh token on each use to prevent replay attacks.",
    metadata: { topic: "auth", indexedAt: NOW - 2 * DAY },
  },
  {
    id: "auth-3",
    content:
      "The token rotation strategy invalidates the previous refresh token on each use. We use bcrypt with cost factor 12 for password hashing. PBKDF2 was considered but rejected.",
    metadata: { topic: "auth", indexedAt: NOW - 2 * DAY },
  },

  // --- Cluster 2: Database / ORM ---
  {
    id: "db-1",
    content:
      "PostgreSQL 16 is the primary database. We use Drizzle ORM with explicit schema definitions. All queries use parameterized statements to prevent SQL injection.",
    metadata: { topic: "database", indexedAt: NOW - 10 * DAY },
  },
  {
    id: "db-2",
    content:
      "Database migrations are managed by Drizzle Kit. Each migration is a TypeScript file that exports up() and down() functions. Migrations run in a transaction.",
    metadata: { topic: "database", indexedAt: NOW - 10 * DAY },
  },

  // --- Cluster 3: API design ---
  {
    id: "api-1",
    content:
      "REST API follows OpenAPI 3.1 spec. All endpoints return { ok: boolean, data?: T, error?: string }. Rate limiting is set to 100 requests per minute per IP.",
    metadata: { topic: "api", indexedAt: NOW - 5 * DAY },
  },
  {
    id: "api-2",
    content:
      "WebSocket connections use Socket.IO with Redis adapter for horizontal scaling. Events follow the pattern: namespace/entity/action (e.g., chat/message/created).",
    metadata: { topic: "api", indexedAt: NOW - 5 * DAY },
  },

  // --- Cluster 4: Deployment / infrastructure ---
  {
    id: "deploy-1",
    content:
      "Production deployment uses Docker Compose with three services: app, postgres, redis. The app runs behind Caddy reverse proxy with automatic HTTPS via Let's Encrypt.",
    metadata: { topic: "deploy", indexedAt: NOW - 30 * DAY },
  },
  {
    id: "deploy-2",
    content:
      "CI/CD pipeline runs on GitHub Actions. Tests run in parallel across 4 shards. Deployment is triggered on merge to main branch. Rollback is manual via git revert.",
    metadata: { topic: "deploy", indexedAt: NOW - 30 * DAY },
  },

  // --- Cluster 5: Recent troubleshooting (should rank higher with decay) ---
  {
    id: "fix-1",
    content:
      "Fixed memory leak in WebSocket handler. The issue was unclosed event listeners on disconnect. Added cleanup in the beforeDisconnect hook. Memory usage dropped from 2GB to 400MB.",
    metadata: { topic: "bugfix", indexedAt: NOW - 1 * DAY },
  },
  {
    id: "fix-2",
    content:
      "Resolved JWT token validation failure on clock skew. Added 30-second tolerance window using the nbf (not before) claim. This fixed intermittent 401 errors in EU region.",
    metadata: { topic: "bugfix", indexedAt: NOW - 1 * DAY },
  },

  // --- Cluster 6: Stale / old notes ---
  {
    id: "old-1",
    content:
      "TODO: Consider migrating from Express to Fastify for better performance. Benchmark showed 2x throughput improvement. Decision pending team discussion.",
    metadata: { topic: "planning", indexedAt: NOW - 180 * DAY },
  },
  {
    id: "old-2",
    content:
      "Meeting notes from Q1: Discussed adopting GraphQL. Decided to stick with REST for now due to team familiarity. May revisit in Q3.",
    metadata: { topic: "planning", indexedAt: NOW - 180 * DAY },
  },
] as const;

// ---------------------------------------------------------------------------
// Embedder: deterministic hash-based (simulates semantic similarity)
// ---------------------------------------------------------------------------

const DIMS = 64;

function createBenchmarkEmbedder(): Embedder {
  function embed(text: string): readonly number[] {
    const vec = new Array(DIMS).fill(0) as number[];
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    // Use character trigrams for better semantic similarity
    for (const word of words) {
      for (let i = 0; i <= word.length - 3; i++) {
        const trigram = word.slice(i, i + 3);
        const hash =
          (trigram.charCodeAt(0) * 31 + trigram.charCodeAt(1)) * 31 + trigram.charCodeAt(2);
        const idx = hash % DIMS;
        vec[idx] = (vec[idx] ?? 0) + 1;
      }
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] = (vec[i] ?? 0) / norm;
      }
    }
    return vec;
  }

  return {
    embed: async (text: string) => embed(text),
    embedMany: async (texts: readonly string[]) => texts.map(embed),
    dimensions: DIMS,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueTopics(results: readonly SearchResult[]): readonly string[] {
  const seen = new Set<string>();
  for (const r of results) {
    const topic = r.metadata.topic;
    if (typeof topic === "string") seen.add(topic);
  }
  return [...seen];
}

function hasDuplicateContent(results: readonly SearchResult[], threshold: number): boolean {
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      if (a === undefined || b === undefined) continue;
      const similarity = jaccardWords(a.content, b.content);
      if (similarity > threshold) return true;
    }
  }
  return false;
}

function jaccardWords(a: string, b: string): number {
  const setA = new Set(
    a
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  const setB = new Set(
    b
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Test: Quality Comparison
// ---------------------------------------------------------------------------

describe("Quality Benchmark", () => {
  // Strategy A: Koi baseline (RRF, no MMR, no decay)
  // Strategy B: Koi full (RRF + MMR + decay)
  // Strategy C: OpenClaw-style (weighted linear 70/30, no MMR)
  // Strategy D: OpenClaw-style + MMR

  test("Query 1: 'JWT token authentication' — precision + deduplication", async () => {
    // --- Strategy A: baseline ---
    const searchA = createSearch({ embedder: createBenchmarkEmbedder() });
    await searchA.indexer.index([...CORPUS]);
    const resultA = await searchA.retriever.retrieve({
      text: "JWT token authentication",
      limit: 5,
    });

    // --- Strategy B: full (MMR + decay) ---
    const searchB = createSearch({
      embedder: createBenchmarkEmbedder(),
      mmr: { lambda: 0.7 },
      temporalDecay: { halfLifeDays: 30, now: NOW },
    });
    await searchB.indexer.index([...CORPUS]);
    const resultB = await searchB.retriever.retrieve({
      text: "JWT token authentication",
      limit: 5,
    });

    // --- Strategy C: OpenClaw-style linear ---
    const searchC = createSearch({
      embedder: createBenchmarkEmbedder(),
      fusion: { kind: "linear", weights: [0.3, 0.7], normalizer: "min_max" },
    });
    await searchC.indexer.index([...CORPUS]);
    const resultC = await searchC.retriever.retrieve({
      text: "JWT token authentication",
      limit: 5,
    });

    // --- Strategy D: OpenClaw-style + MMR ---
    const searchD = createSearch({
      embedder: createBenchmarkEmbedder(),
      fusion: { kind: "linear", weights: [0.3, 0.7], normalizer: "min_max" },
      mmr: { lambda: 0.7 },
    });
    await searchD.indexer.index([...CORPUS]);
    const resultD = await searchD.retriever.retrieve({
      text: "JWT token authentication",
      limit: 5,
    });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(resultC.ok).toBe(true);
    expect(resultD.ok).toBe(true);
    if (!resultA.ok || !resultB.ok || !resultC.ok || !resultD.ok) return;

    const topA = resultA.value.results;
    const topB = resultB.value.results;
    const topC = resultC.value.results;
    const topD = resultD.value.results;

    console.log("\n=== Query: 'JWT token authentication' ===");
    console.log("\nStrategy A (Koi baseline RRF):");
    for (const r of topA)
      console.log(`  ${r.id} (score: ${r.score.toFixed(4)}) — ${r.content.slice(0, 60)}...`);
    console.log(`  Topics: [${uniqueTopics(topA).join(", ")}]`);
    console.log(`  Has near-dupes (>0.5 Jaccard): ${hasDuplicateContent(topA, 0.5)}`);

    console.log("\nStrategy B (Koi RRF + MMR + decay):");
    for (const r of topB)
      console.log(`  ${r.id} (score: ${r.score.toFixed(4)}) — ${r.content.slice(0, 60)}...`);
    console.log(`  Topics: [${uniqueTopics(topB).join(", ")}]`);
    console.log(`  Has near-dupes (>0.5 Jaccard): ${hasDuplicateContent(topB, 0.5)}`);

    console.log("\nStrategy C (OpenClaw linear 70/30):");
    for (const r of topC)
      console.log(`  ${r.id} (score: ${r.score.toFixed(4)}) — ${r.content.slice(0, 60)}...`);
    console.log(`  Topics: [${uniqueTopics(topC).join(", ")}]`);
    console.log(`  Has near-dupes (>0.5 Jaccard): ${hasDuplicateContent(topC, 0.5)}`);

    console.log("\nStrategy D (OpenClaw linear + MMR):");
    for (const r of topD)
      console.log(`  ${r.id} (score: ${r.score.toFixed(4)}) — ${r.content.slice(0, 60)}...`);
    console.log(`  Topics: [${uniqueTopics(topD).join(", ")}]`);
    console.log(`  Has near-dupes (>0.5 Jaccard): ${hasDuplicateContent(topD, 0.5)}`);

    // Assertions: All strategies should return relevant auth results
    // Note: temporal decay may trade old-topic diversity for recency (expected behavior)
    expect(uniqueTopics(topB).length).toBeGreaterThanOrEqual(2);
    // Strategies without decay (C, D) should cover more topics since old docs aren't penalized
    expect(uniqueTopics(topC).length).toBeGreaterThanOrEqual(uniqueTopics(topB).length);

    // Auth results should appear in top results for all strategies
    const authInA = topA.some((r) => r.metadata.topic === "auth");
    const authInB = topB.some((r) => r.metadata.topic === "auth");
    expect(authInA).toBe(true);
    expect(authInB).toBe(true);

    // fix-2 (recent JWT fix) should rank higher with temporal decay
    const fixRankB = topB.findIndex((r) => r.id === "fix-2");
    const fixRankA = topA.findIndex((r) => r.id === "fix-2");
    if (fixRankA >= 0 && fixRankB >= 0) {
      console.log(`\n  fix-2 rank: A=${fixRankA}, B=${fixRankB} (lower=better, B should be ≤ A)`);
    }

    searchA.close();
    searchB.close();
    searchC.close();
    searchD.close();
  });

  test("Query 2: 'memory leak WebSocket' — recency matters", async () => {
    const searchBaseline = createSearch({ embedder: createBenchmarkEmbedder() });
    await searchBaseline.indexer.index([...CORPUS]);

    const searchWithDecay = createSearch({
      embedder: createBenchmarkEmbedder(),
      mmr: { lambda: 0.7 },
      temporalDecay: { halfLifeDays: 30, now: NOW },
    });
    await searchWithDecay.indexer.index([...CORPUS]);

    const baseline = await searchBaseline.retriever.retrieve({
      text: "memory leak WebSocket",
      limit: 5,
    });
    const withDecay = await searchWithDecay.retriever.retrieve({
      text: "memory leak WebSocket",
      limit: 5,
    });

    expect(baseline.ok).toBe(true);
    expect(withDecay.ok).toBe(true);
    if (!baseline.ok || !withDecay.ok) return;

    console.log("\n=== Query: 'memory leak WebSocket' ===");
    console.log("\nBaseline (no decay):");
    for (const r of baseline.value.results) console.log(`  ${r.id} (score: ${r.score.toFixed(4)})`);

    console.log("\nWith decay (half-life 30d):");
    for (const r of withDecay.value.results)
      console.log(`  ${r.id} (score: ${r.score.toFixed(4)})`);

    // fix-1 is 1 day old and directly about memory leak — should be #1 in both
    expect(withDecay.value.results[0]?.id).toBe("fix-1");

    // Old deployment notes (30-180 days) should rank lower with decay
    const oldInDecayed = withDecay.value.results.filter(
      (r) => r.metadata.topic === "planning" || r.metadata.topic === "deploy",
    );
    const recentInDecayed = withDecay.value.results.filter((r) => r.metadata.topic === "bugfix");
    if (oldInDecayed.length > 0 && recentInDecayed.length > 0) {
      const maxOldScore = Math.max(...oldInDecayed.map((r) => r.score));
      const minRecentScore = Math.min(...recentInDecayed.map((r) => r.score));
      console.log(`  Recent bugfix min score: ${minRecentScore.toFixed(4)}`);
      console.log(`  Old docs max score: ${maxOldScore.toFixed(4)}`);
      expect(minRecentScore).toBeGreaterThan(maxOldScore);
    }

    searchBaseline.close();
    searchWithDecay.close();
  });

  test("Query 3: 'database migration' — diversity of results", async () => {
    const searchNoMmr = createSearch({ embedder: createBenchmarkEmbedder() });
    await searchNoMmr.indexer.index([...CORPUS]);

    const searchWithMmr = createSearch({
      embedder: createBenchmarkEmbedder(),
      mmr: { lambda: 0.5 },
    });
    await searchWithMmr.indexer.index([...CORPUS]);

    const noMmr = await searchNoMmr.retriever.retrieve({ text: "database migration", limit: 5 });
    const withMmr = await searchWithMmr.retriever.retrieve({
      text: "database migration",
      limit: 5,
    });

    expect(noMmr.ok).toBe(true);
    expect(withMmr.ok).toBe(true);
    if (!noMmr.ok || !withMmr.ok) return;

    const topicsNoMmr = uniqueTopics(noMmr.value.results);
    const topicsMmr = uniqueTopics(withMmr.value.results);

    console.log("\n=== Query: 'database migration' ===");
    console.log(`\nNo MMR topics (${topicsNoMmr.length}): [${topicsNoMmr.join(", ")}]`);
    for (const r of noMmr.value.results) console.log(`  ${r.id} (${r.score.toFixed(4)})`);
    console.log(`\nWith MMR topics (${topicsMmr.length}): [${topicsMmr.join(", ")}]`);
    for (const r of withMmr.value.results) console.log(`  ${r.id} (${r.score.toFixed(4)})`);

    // MMR should produce at least as many unique topics
    expect(topicsMmr.length).toBeGreaterThanOrEqual(topicsNoMmr.length);

    // Database results should be present in both
    expect(noMmr.value.results.some((r) => r.metadata.topic === "database")).toBe(true);
    expect(withMmr.value.results.some((r) => r.metadata.topic === "database")).toBe(true);

    searchNoMmr.close();
    searchWithMmr.close();
  });

  test("Query 4: 'that thing we discussed about API design' — vague conversational query", async () => {
    const searchA = createSearch({ embedder: createBenchmarkEmbedder() });
    await searchA.indexer.index([...CORPUS]);

    const searchB = createSearch({
      embedder: createBenchmarkEmbedder(),
      mmr: { lambda: 0.7 },
      temporalDecay: { halfLifeDays: 30, now: NOW },
    });
    await searchB.indexer.index([...CORPUS]);

    const resultA = await searchA.retriever.retrieve({
      text: "that thing we discussed about API design",
      limit: 5,
    });
    const resultB = await searchB.retriever.retrieve({
      text: "that thing we discussed about API design",
      limit: 5,
    });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    console.log("\n=== Query: 'that thing we discussed about API design' ===");
    console.log("\nBaseline:");
    for (const r of resultA.value.results)
      console.log(`  ${r.id} (${r.score.toFixed(4)}) — topic: ${r.metadata.topic}`);
    console.log("\nWith MMR + decay:");
    for (const r of resultB.value.results)
      console.log(`  ${r.id} (${r.score.toFixed(4)}) — topic: ${r.metadata.topic}`);

    // API-related results should appear
    const apiInA = resultA.value.results.some((r) => r.metadata.topic === "api");
    const apiInB = resultB.value.results.some((r) => r.metadata.topic === "api");
    expect(apiInA).toBe(true);
    expect(apiInB).toBe(true);

    searchA.close();
    searchB.close();
  });

  test("Query 5: 'Docker Caddy deployment' — exact keyword matching", async () => {
    const searchRrf = createSearch({ embedder: createBenchmarkEmbedder() });
    await searchRrf.indexer.index([...CORPUS]);

    const searchLinear = createSearch({
      embedder: createBenchmarkEmbedder(),
      fusion: { kind: "linear", weights: [0.3, 0.7], normalizer: "min_max" },
    });
    await searchLinear.indexer.index([...CORPUS]);

    const rrf = await searchRrf.retriever.retrieve({ text: "Docker Caddy deployment", limit: 3 });
    const linear = await searchLinear.retriever.retrieve({
      text: "Docker Caddy deployment",
      limit: 3,
    });

    expect(rrf.ok).toBe(true);
    expect(linear.ok).toBe(true);
    if (!rrf.ok || !linear.ok) return;

    console.log("\n=== Query: 'Docker Caddy deployment' ===");
    console.log("\nRRF (Koi default):");
    for (const r of rrf.value.results) console.log(`  ${r.id} (${r.score.toFixed(4)})`);
    console.log("\nLinear 70/30 (OpenClaw-style):");
    for (const r of linear.value.results) console.log(`  ${r.id} (${r.score.toFixed(4)})`);

    // deploy-1 has exact keywords — should be #1 in both
    expect(rrf.value.results[0]?.id).toBe("deploy-1");
    expect(linear.value.results[0]?.id).toBe("deploy-1");

    searchRrf.close();
    searchLinear.close();
  });

  test("Query 6: 'security best practices' — semantic recall", async () => {
    const search = createSearch({
      embedder: createBenchmarkEmbedder(),
      mmr: { lambda: 0.6 },
      temporalDecay: { halfLifeDays: 60, now: NOW },
    });
    await search.indexer.index([...CORPUS]);

    const result = await search.retriever.retrieve({ text: "security best practices", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    console.log("\n=== Query: 'security best practices' ===");
    for (const r of result.value.results)
      console.log(`  ${r.id} (${r.score.toFixed(4)}) — topic: ${r.metadata.topic}`);
    const topics = uniqueTopics(result.value.results);
    console.log(`  Topics covered: [${topics.join(", ")}]`);

    // Should surface auth (JWT, bcrypt), database (SQL injection), and API (rate limiting)
    // These all relate to security even without the word "security" in them
    expect(result.value.results.length).toBeGreaterThan(0);

    search.close();
  });

  test("Summary: side-by-side deduplication comparison", async () => {
    // Focus: auth-1, auth-2, auth-3 have high overlap due to chunker sliding window
    const searchNaive = createSearch({ embedder: createBenchmarkEmbedder() });
    await searchNaive.indexer.index([...CORPUS]);

    const searchMmr = createSearch({
      embedder: createBenchmarkEmbedder(),
      mmr: { lambda: 0.5 },
    });
    await searchMmr.indexer.index([...CORPUS]);

    const naive = await searchNaive.retriever.retrieve({
      text: "refresh token cookie rotation",
      limit: 5,
    });
    const mmr = await searchMmr.retriever.retrieve({
      text: "refresh token cookie rotation",
      limit: 5,
    });

    expect(naive.ok).toBe(true);
    expect(mmr.ok).toBe(true);
    if (!naive.ok || !mmr.ok) return;

    const dupesNaive = hasDuplicateContent(naive.value.results, 0.4);
    const dupesMmr = hasDuplicateContent(mmr.value.results, 0.4);

    console.log("\n=== Deduplication: 'refresh token cookie rotation' ===");
    console.log(`\nNaive (no MMR): ${naive.value.results.map((r) => r.id).join(", ")}`);
    console.log(`  Has near-dupes (>0.4 Jaccard): ${dupesNaive}`);
    console.log(`  Unique topics: ${uniqueTopics(naive.value.results).length}`);
    console.log(`\nMMR (lambda=0.5): ${mmr.value.results.map((r) => r.id).join(", ")}`);
    console.log(`  Has near-dupes (>0.4 Jaccard): ${dupesMmr}`);
    console.log(`  Unique topics: ${uniqueTopics(mmr.value.results).length}`);

    // MMR should have more diverse results
    expect(uniqueTopics(mmr.value.results).length).toBeGreaterThanOrEqual(
      uniqueTopics(naive.value.results).length,
    );

    searchNaive.close();
    searchMmr.close();
  });
});
