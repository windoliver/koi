# @koi/search-nexus — Nexus Search REST Adapter

REST adapter that implements `Retriever` and `Indexer` against the Nexus search API v2. A single `createNexusSearch()` factory returns a composite with search, indexing, health checks, stats, and reindexing — all with automatic retry and batch chunking.

---

## Why It Exists

`@koi/search` ships with a local SQLite + BM25 backend — fast for single-node agents but unsuitable for multi-agent deployments where a shared search index is needed. Nexus already exposes a full search REST API (`POST /api/v2/search/index`, `GET /api/v2/search/query`) that maps 1:1 to Koi's `Indexer`/`Retriever` contracts.

This package bridges the two without leaking Nexus concepts into `@koi/search` or `@koi/core`.

---

## What This Enables

```
WITHOUT search-nexus (local only):
═══════════════════════════════════
  Agent A indexes docs → SQLite on disk
  Agent B indexes docs → different SQLite on disk
  No shared index. Each agent searches only its own data.


WITH search-nexus (shared backend):
════════════════════════════════════
  const nexus = createNexusSearch({
    baseUrl: "http://nexus:2026",
    apiKey: "sk-...",
  });

  Agent A indexes docs → Nexus server
  Agent B searches     → same Nexus server
  Shared index. All agents see all data.
  Health checks, stats, and reindex available.
```

### What You Can Do

- **Shared search across agents**: multiple agents index and query the same Nexus backend
- **Semantic code search**: query a codebase Nexus has auto-indexed, get scored results with line ranges
- **RAG pipelines**: index summaries, embeddings, or generated content for retrieval-augmented generation
- **Operational monitoring**: health checks, document count stats, trigger reindexing
- **Supplemental indexing**: push extra documents (agent-generated summaries, embeddings) alongside Nexus's auto-indexed content

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  @koi/search-nexus  (L2)                                  │
│                                                            │
│  nexus-search.ts         ← createNexusSearch() composite   │
│  nexus-search-config.ts  ← NexusSearchConfig + defaults    │
│  nexus-search-types.ts   ← NexusSearch, SearchHealth, etc  │
│  validate-config.ts      ← config validation → Result      │
│  parse-response.ts       ← defensive response parsers      │
│  nexus-retriever.ts      ← GET  /api/v2/search/query       │
│  nexus-indexer.ts         ← POST /api/v2/search/index       │
│                             POST /api/v2/search/refresh     │
│  map-nexus-result.ts      ← NexusSearchHit → SearchResult   │
│  nexus-types.ts           ← internal Nexus wire types        │
│  index.ts                 ← public API surface               │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Internal deps                                             │
│  ● @koi/core (L0)            — KoiError, Result, types     │
│  ● @koi/search-provider (L0u) — Indexer, Retriever types   │
│  ● @koi/nexus-client (L0u)   — NexusRestClient HTTP layer  │
│  ● @koi/errors (L0u)          — retry, backoff, isRetryable │
│                                                            │
│  External deps: NONE                                       │
└────────────────────────────────────────────────────────────┘
```

### How It Plugs In

```
@koi/search-nexus           @koi/search              Koi Runtime
┌──────────────────┐   ┌──────────────────────┐   ┌────────────────┐
│createNexusSearch │──▶│ createSearch({       │──▶│ Agent uses     │
│ (config)         │   │   embedder,          │   │ search.indexer │
│                  │   │   backend: {         │   │ search.retrieve│
│ returns:         │   │     indexer,  ▲       │   │                │
│  .retriever      │   │     retriever ▲       │   │ Nexus handles  │
│  .indexer        │   │   }                  │   │ all storage    │
│  .healthCheck()  │   │ })                   │   └────────────────┘
│  .getStats()     │   └──────────────────────┘
│  .reindex()      │
│  .close()        │   No import between
└──────────────────┘   search-nexus and search!
```

---

## Usage

### Quick Start

```typescript
import { createNexusSearch } from "@koi/search-nexus";

const nexus = createNexusSearch({
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY ?? "",
});

// Index documents
await nexus.indexer.index([
  { id: "doc1", content: "Hello world" },
  { id: "doc2", content: "Foo bar", metadata: { lang: "en" } },
]);

// Search
const result = await nexus.retriever.retrieve({ text: "hello", limit: 10 });
if (result.ok) {
  for (const hit of result.value.results) {
    console.log(hit.id, hit.score, hit.content);
  }
}

// Health check
const health = await nexus.healthCheck();
// { ok: true, value: { healthy: true, indexName: "code-idx" } }

// Stats
const stats = await nexus.getStats();
// { ok: true, value: { documentCount: 42, indexSizeBytes: 1024 } }

// Trigger reindex
await nexus.reindex();

// Cleanup (no-op for REST, but fulfills the interface)
nexus.close();
```

### With `createSearch` Backend

```typescript
import { createNexusSearch } from "@koi/search-nexus";
import { createSearch } from "@koi/search";

const nexus = createNexusSearch({
  baseUrl: "http://nexus:2026",
  apiKey: "sk-...",
});

const search = createSearch({
  embedder,
  backend: {
    indexer: nexus.indexer,
    retriever: nexus.retriever,
  },
});
```

### Full Configuration

```typescript
const nexus = createNexusSearch({
  baseUrl: "http://nexus:2026",
  apiKey: "sk-...",
  timeoutMs: 5_000,         // 5s timeout (default: 10s)
  defaultLimit: 20,         // results per query (default: 10)
  minScore: 0.3,            // min relevance threshold (default: 0)
  maxBatchSize: 200,        // docs per index batch (default: 100)
  retry: {
    maxRetries: 5,          // more retries (default: 3)
    initialDelayMs: 500,    // faster first retry
    maxBackoffMs: 60_000,   // cap at 60s
  },
});
```

### Testing With Mock Fetch

```typescript
const mockFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ hits: [], total: 0, has_more: false }),
  text: async () => "{}",
}) as unknown as typeof fetch;

const nexus = createNexusSearch({
  baseUrl: "http://test",
  apiKey: "test-key",
  fetchFn: mockFetch,
  retry: { maxRetries: 0 },
});
```

---

## API Reference

### Factory

| Function | Params | Returns |
|----------|--------|---------|
| `createNexusSearch(config)` | `NexusSearchConfig` | `NexusSearch` |
| `validateNexusSearchConfig(config)` | `NexusSearchConfig` | `Result<void, KoiError>` |

### NexusSearch

| Property | Type | Description |
|----------|------|-------------|
| `retriever` | `Retriever` | Query the search index |
| `indexer` | `Indexer` | Index and remove documents |
| `healthCheck()` | `() => Promise<Result<SearchHealth>>` | Check Nexus health |
| `getStats()` | `() => Promise<Result<SearchStats>>` | Get index statistics |
| `reindex()` | `() => Promise<Result<void>>` | Trigger reindexing |
| `close()` | `() => void` | Cleanup (no-op for REST) |

### NexusSearchConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | *(required)* | Nexus server base URL |
| `apiKey` | `string` | *(required)* | API key for Bearer auth |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Custom fetch function |
| `timeoutMs` | `number` | `10,000` | Request timeout |
| `defaultLimit` | `number` | `10` | Default results per query |
| `minScore` | `number` | `0` | Minimum relevance score (0–1) |
| `maxBatchSize` | `number` | `100` | Max documents per index batch |
| `retry` | `Partial<RetryConfig>` | `{ maxRetries: 3, ... }` | Retry policy |

### Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_TIMEOUT_MS` | `10_000` |
| `DEFAULT_LIMIT` | `10` |
| `DEFAULT_MAX_BATCH_SIZE` | `100` |

### Nexus → Koi Type Mapping

| Nexus field | Koi `SearchResult` field |
|-------------|--------------------------|
| `path` | `metadata.path` |
| `chunk_text` | `content` |
| `score` | `score` |
| `chunk_index` | part of `id` (`"${path}:${chunk_index}"`) |
| `line_start` / `line_end` | `metadata.lineStart` / `metadata.lineEnd` |
| `keyword_score` / `vector_score` | `metadata.keywordScore` / `metadata.vectorScore` |
| *(N/A)* | `source` = `"nexus"` |

---

## Key Features

### Automatic Retry

All operations (retrieve, index, remove, healthCheck, getStats, reindex) are wrapped with Result-aware retry. Retries only fire on transient errors:

| Error Code | Retryable | Example |
|------------|-----------|---------|
| `RATE_LIMIT` | Yes | HTTP 429 |
| `TIMEOUT` | Yes | HTTP 408/504, network timeout |
| `EXTERNAL` (5xx) | Yes | HTTP 500, 502, 503 |
| `VALIDATION` | No | HTTP 400, malformed response |
| `PERMISSION` | No | HTTP 401, 403 |
| `NOT_FOUND` | No | HTTP 404 |

Backoff is exponential with jitter, respects `retryAfterMs` from rate-limit responses.

### Batch Chunking

Large `indexer.index()` calls are automatically split into batches of `maxBatchSize` (default: 100). Each batch is a separate HTTP request. Failures stop at the first failing batch.

```
250 documents, maxBatchSize=100:
  → POST /index (docs 0–99)     ✓
  → POST /index (docs 100–199)  ✓
  → POST /index (docs 200–249)  ✓
```

### Filter Rejection

Nexus search does not support client-side filters. Passing `query.filter` returns a `VALIDATION` error immediately (no HTTP call).

### Defensive Response Parsing

All Nexus API responses are validated with type guard predicates before use. Malformed responses return `VALIDATION` errors instead of causing runtime crashes.

### Config Validation

`validateNexusSearchConfig()` checks: non-empty baseUrl (valid URL format), non-empty apiKey, positive timeoutMs, valid defaultLimit, minScore in 0–1 range, positive maxBatchSize. `createNexusSearch()` calls this and throws on failure (fail-fast at construction).

---

## REST Endpoints Used

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Query | `GET` | `/api/v2/search/query?q=...&limit=...` |
| Index | `POST` | `/api/v2/search/index` |
| Remove | `POST` | `/api/v2/search/refresh` |
| Health | `GET` | `/api/v2/search/health` |
| Stats | `GET` | `/api/v2/search/stats` |
| Reindex | `POST` | `/api/v2/search/reindex` |

---

## Testing

```
52 tests across 6 files:

nexus-search.test.ts — 15 tests
  ● Factory creation and validation
  ● healthCheck: happy path, server error, malformed response
  ● getStats: happy path, server error
  ● reindex: happy path, server error
  ● close: no-op
  ● Retry: retries on 5xx, no retry on 4xx
  ● Retriever and indexer through composite

validate-config.test.ts — 14 tests
  ● Valid config, optional fields undefined
  ● Empty/invalid baseUrl, apiKey
  ● Negative/zero timeoutMs, defaultLimit, maxBatchSize
  ● minScore out of 0–1 range
  ● Invalid URL format

nexus-retriever.test.ts — 10 tests
  ● Mapped results, query params, error responses
  ● Filter rejection → VALIDATION error
  ● Malformed response → VALIDATION error
  ● Empty results, cursor pagination
  ● Config defaults (defaultLimit, minScore)

nexus-indexer.test.ts — 10 tests
  ● Document indexing, embeddings, auth
  ● Batch chunking: 250 docs → 3 POSTs
  ● Empty input → no-op (no HTTP call)
  ● Stops on first batch failure

map-nexus-result.test.ts — 3 tests
  ● Minimal hit, all fields, optional metadata

__tests__/integration.test.ts — 7 tests (env-gated)
  ● Full flow: health → index → retrieve → stats → remove → reindex
  ● Requires NEXUS_TEST_URL env var
```

```bash
# Unit tests
bun --cwd packages/search-nexus test

# Integration tests (requires running Nexus)
NEXUS_TEST_URL=http://localhost:2026 bun --cwd packages/search-nexus test
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single composite factory | One `createNexusSearch()` instead of separate retriever/indexer factories. Simpler API, shared config and client. |
| Migrated to `@koi/nexus-client` | Shared REST transport eliminates duplicate HTTP plumbing (timeout, auth, error mapping). |
| Result-aware retry | `withRetry` from `@koi/errors` throws on failure, but our operations return `Result`. Custom `withResultRetry` checks `result.ok` and `isRetryable(result.error)`. |
| Batch chunking | Large index operations hit Nexus payload limits. Auto-chunking with configurable `maxBatchSize` prevents 413 errors. |
| Filter rejection | Nexus API doesn't support client-side filters. Fail-fast VALIDATION error is better than silently ignoring the filter. |
| Type guard parsers | Defensive response parsing without `as Type` assertions. Type guards narrow `unknown` → concrete type safely. |
| Default timeout 10s (was 30s) | Aligned with `@koi/nexus-client` default. 30s was too generous for search queries. |
| `source: "nexus"` on results | Downstream consumers can distinguish local vs remote results. |
| No caching | Nexus server handles caching. This adapter is a stateless HTTP wrapper. |

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────┐
    KoiError, Result, RETRYABLE_DEFAULTS                │
                                                        │
L0u @koi/search-provider ────────────────────────┐     │
    Indexer, Retriever, SearchResult              │     │
                                                  │     │
L0u @koi/nexus-client ───────────────────────┐   │     │
    NexusRestClient, error mappers            │   │     │
                                              │   │     │
L0u @koi/errors ─────────────────────────┐   │   │     │
    RetryConfig, isRetryable, backoff    │   │   │     │
                                          ▼   ▼   ▼     ▼
L2  @koi/search-nexus ◄─────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 (@koi/search)
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ Returns Result<T, KoiError> (never throws expected errors)
    ✓ Stateless adapter (no caching, no side effects beyond HTTP)
    ✓ Type guard predicates (no `as Type` in production code)
```
