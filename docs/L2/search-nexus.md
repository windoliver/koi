# @koi/search-nexus — Nexus Search REST Adapter

REST adapter that implements `Indexer` and `Retriever` against the Nexus search API v2. One factory call each for indexing and retrieval — plug both into `createSearch({ backend })` to replace the local SQLite backend entirely.

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
  const nexusCfg = { baseUrl: "http://nexus:2026", apiKey: "sk-..." };
  const search = createSearch({
    embedder,
    backend: {
      indexer:   createNexusIndexer(nexusCfg),
      retriever: createNexusRetriever(nexusCfg),
    },
  });

  Agent A indexes docs → Nexus server
  Agent B searches     → same Nexus server
  Shared index. All agents see all data.
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  @koi/search-nexus  (L2)                                 │
│                                                          │
│  nexus-search-config.ts ← NexusSearchConfig type         │
│  nexus-types.ts         ← internal Nexus wire types      │
│  http-errors.ts         ← HTTP status → KoiError mapper  │
│  map-nexus-result.ts    ← NexusSearchHit → SearchResult  │
│  nexus-retriever.ts     ← GET  /api/v2/search/query      │
│  nexus-indexer.ts       ← POST /api/v2/search/index      │
│                           POST /api/v2/search/refresh     │
│  index.ts               ← public API surface             │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  External deps: NONE (uses platform fetch API)           │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Internal deps                                           │
│  ● @koi/core (L0) — KoiError, Result, RETRYABLE_DEFAULTS│
│  ● @koi/search-provider (L0u) — Indexer, Retriever types│
└──────────────────────────────────────────────────────────┘
```

### How It Plugs In

```
@koi/search-nexus          @koi/search              Koi Runtime
┌─────────────────┐   ┌──────────────────────┐   ┌────────────────┐
│createNexusIndexer│──▶│ createSearch({       │──▶│ Agent uses     │
│createNexusRetriev│   │   embedder,          │   │ search.indexer │
│ (nexusCfg)       │   │   backend: {         │   │ search.retrieve│
│                  │   │     indexer,  ▲       │   │                │
│ returns Indexer  │   │     retriever ▲       │   │ Nexus handles  │
│ returns Retriever│   │   }                  │   │ all storage    │
└─────────────────┘   │ })                   │   └────────────────┘
                       └──────────────────────┘
  No import between
  search-nexus and search!
```

---

## Usage

### Basic

```typescript
import { createNexusIndexer, createNexusRetriever } from "@koi/search-nexus";
import { createSearch } from "@koi/search";

const nexusCfg = {
  baseUrl: "http://localhost:2026",
  apiKey: process.env.NEXUS_API_KEY ?? "",
};

const search = createSearch({
  embedder, // required for type compat (unused in remote mode)
  backend: {
    indexer: createNexusIndexer(nexusCfg),
    retriever: createNexusRetriever(nexusCfg),
  },
});

// Index documents
await search.indexer.index([
  { id: "doc1", content: "Hello world" },
]);

// Search
const result = await search.retriever.retrieve({ text: "hello", limit: 10 });
```

### With Custom Timeout

```typescript
const nexusCfg = {
  baseUrl: "http://nexus:2026",
  apiKey: "sk-...",
  timeoutMs: 5_000, // 5s timeout (default: 30s)
};
```

### With Injectable Fetch (for Testing)

```typescript
const mockFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ hits: [], total: 0, has_more: false }),
}) as unknown as typeof fetch;

const retriever = createNexusRetriever({
  baseUrl: "http://test",
  apiKey: "test-key",
  fetchFn: mockFetch,
});
```

---

## API Reference

### Factories

| Function | Params | Returns |
|----------|--------|---------|
| `createNexusRetriever(config)` | `NexusSearchConfig` | `Retriever` |
| `createNexusIndexer(config)` | `NexusSearchConfig` | `Indexer` |

### NexusSearchConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | *(required)* | Nexus server base URL |
| `apiKey` | `string` | *(required)* | API key for Bearer auth |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Custom fetch function |
| `timeoutMs` | `number` | `30,000` | Request timeout |

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

### Error Mapping

```
╔══════════════╦══════════════════════════╦═══════════╗
║ HTTP Status  ║ KoiError Code            ║ Retryable ║
╠══════════════╬══════════════════════════╬═══════════╣
║ 400          ║ VALIDATION               ║ No        ║
║ 401, 403     ║ PERMISSION               ║ No        ║
║ 404          ║ NOT_FOUND                ║ No        ║
║ 429          ║ RATE_LIMIT               ║ Yes       ║
║ 5xx          ║ EXTERNAL                 ║ Yes       ║
║ Network fail ║ EXTERNAL                 ║ No        ║
║ Timeout      ║ TIMEOUT                  ║ Yes       ║
║ Unknown      ║ EXTERNAL                 ║ No        ║
╚══════════════╩══════════════════════════╩═══════════╝
```

### REST Endpoints Used

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Query | `GET` | `/api/v2/search/query?q=...&limit=...` |
| Index | `POST` | `/api/v2/search/index` |
| Remove | `POST` | `/api/v2/search/refresh` |

### Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_TIMEOUT_MS` | `30_000` |

---

## Testing

```
http-errors.test.ts — 8 tests
  ● Maps 400 to VALIDATION
  ● Maps 401 to PERMISSION
  ● Maps 403 to PERMISSION
  ● Maps 404 to NOT_FOUND
  ● Maps 429 to RATE_LIMIT
  ● Maps 500 to retryable EXTERNAL
  ● Maps 502 to retryable EXTERNAL
  ● Maps unknown status to non-retryable EXTERNAL

map-nexus-result.test.ts — 3 tests
  ● Maps a minimal hit to SearchResult
  ● Maps a hit with all optional fields
  ● Omits optional metadata when not present

nexus-retriever.test.ts — 5 tests
  ● Returns mapped results on success
  ● Passes query params correctly
  ● Sends authorization header
  ● Returns error on non-OK response
  ● Returns EXTERNAL error on network failure

nexus-indexer.test.ts — 7 tests
  ● Sends documents to POST /api/v2/search/index
  ● Includes embeddings when provided
  ● Returns error on server failure
  ● Returns EXTERNAL error on network failure
  ● Sends ids to POST /api/v2/search/refresh
  ● Sends authorization header
  ● Returns error on auth failure
```

```bash
bun --cwd packages/search-nexus test
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Separate L2 package | `@koi/search` never imports this — avoids L2→L2 dependency |
| Uses `fetch` not `@koi/nexus-client` | Nexus search is REST, not JSON-RPC. Using the RPC client would add complexity for no benefit |
| Injectable `fetchFn` | Same pattern as `@koi/search-brave`. Enables mock-based testing without network |
| `AbortSignal.timeout()` | Platform-native cancellation. No `setTimeout` + `AbortController` dance |
| No caching | Nexus server handles caching. This adapter is stateless |
| `source: "nexus"` on results | Downstream consumers can distinguish local vs remote results |
| Composite `id` format `path:chunk_index` | Unique, deterministic, and reversible for debugging |
| 5xx mapped to retryable EXTERNAL | Nexus server errors are transient; retry middleware can handle them |
| Network errors mapped to non-retryable | Connection refused / DNS failures need human intervention, not retry loops |

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────┐
    KoiError, Result, RETRYABLE_DEFAULTS            │
                                                    │
L0u @koi/search-provider ──────────────────────┐   │
    Indexer, Retriever, SearchResult            │   │
                                                │   │
                                                ▼   ▼
L2  @koi/search-nexus ◄───────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 (@koi/search)
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ Returns Result<T, KoiError> (never throws)
    ✓ Stateless adapter (no caching, no side effects beyond HTTP)
```
