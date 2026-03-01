# @koi/search-provider — Search Provider Contracts

Pure type definitions for pluggable search backends. Contains two contract families:

1. **Web search** — `SearchProvider`, `WebSearchResult`, `WebSearchOptions` for web search backends (Brave, Tavily, etc.)
2. **Index search** — `Indexer`, `Retriever`, `Embedder` for document index backends (SQLite, Nexus, etc.)

---

## Why It Exists

Multiple L2 packages need to share search contracts without depending on each other:

- `@koi/tools-web` consumes `SearchProvider` but shouldn't import `@koi/search-brave`
- `@koi/search` defines `Indexer`/`Retriever` but `@koi/search-nexus` can't import from a peer L2

Extracting all contracts into a single L0u package lets any number of L2 adapters implement the same interfaces without circular dependencies.

```
@koi/search-provider (L0u) ── owns all search contracts
    │                    │                    │
    ▼                    ▼                    ▼
@koi/search (L2)   @koi/search-nexus (L2)  @koi/search-brave (L2)
 SQLite backend      Nexus REST adapter      Brave web search
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  @koi/search-provider  (L0u)                             │
│                                                          │
│  contracts.ts  ← Indexer, Retriever, Embedder interfaces │
│  types.ts      ← Web search: SearchProvider,             │
│                  WebSearchResult, WebSearchOptions        │
│                  Index search: SearchQuery, SearchResult, │
│                  SearchPage, SearchFilter, IndexDocument  │
│  index.ts      ← public re-exports                       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  External deps: NONE                                     │
│  Internal deps: @koi/core (L0) — KoiError, Result        │
│  Runtime code:  NONE (pure type definitions)              │
└──────────────────────────────────────────────────────────┘
```

---

## API Reference

### Web Search Contracts

```typescript
/** A pluggable web search backend */
interface SearchProvider {
  readonly name: string;
  readonly search: (
    query: string,
    options?: WebSearchOptions,
  ) => Promise<Result<readonly WebSearchResult[], KoiError>>;
}

interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

interface WebSearchOptions {
  readonly maxResults?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}
```

### Index Search Contracts

```typescript
/** Read path — query a search index */
interface Retriever<T = unknown> {
  readonly retrieve: (query: SearchQuery) => Promise<Result<SearchPage<T>, KoiError>>;
}

/** Write path — add/remove documents from an index */
interface Indexer<T = unknown> {
  readonly index: (documents: readonly IndexDocument<T>[]) => Promise<Result<void, KoiError>>;
  readonly remove: (ids: readonly string[]) => Promise<Result<void, KoiError>>;
}

/** Embedding generation */
interface Embedder {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly embedMany: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
  readonly dimensions: number;
}
```

### Index Search Value Types

| Type | Purpose |
|------|---------|
| `SearchQuery` | What the caller wants — text, filters, limit, offset, cursor |
| `SearchResult<T>` | Single hit — id, score, content, metadata, source |
| `SearchPage<T>` | Paginated response — results, total, cursor, hasMore |
| `SearchFilter` | Composable filter tree (eq, ne, gt, lt, in, and, or, not) |
| `IndexDocument<T>` | Document for indexing — id, content, metadata, embedding |
| `SearchScore` | Score normalized to [0, 1] |

### SearchFilter (Discriminated Union)

```typescript
type SearchFilter =
  | { kind: "eq"; field: string; value: unknown }
  | { kind: "ne"; field: string; value: unknown }
  | { kind: "gt"; field: string; value: number }
  | { kind: "lt"; field: string; value: number }
  | { kind: "in"; field: string; values: readonly unknown[] }
  | { kind: "and"; filters: readonly SearchFilter[] }
  | { kind: "or";  filters: readonly SearchFilter[] }
  | { kind: "not"; filter: SearchFilter };
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| L0u, not L0 | Imports `KoiError`/`Result` from `@koi/core` — pure types but with an L0 dependency |
| Zero runtime code | Only `type`, `interface`, and `export type` — no function bodies, no bundle size |
| Two contract families in one package | Both serve "search provider" role; splitting further would over-fragment |
| Re-exports in `@koi/search` | Existing imports (`from "../contracts.js"`) keep working unchanged |
| Generic `<T>` on Retriever/Indexer | Backends can carry custom data alongside standard fields |
| `SearchFilter` as discriminated union | Composable, serializable, and exhaustively checkable via `kind` |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────┐
    KoiError, Result                               │
                                                   │
                                                   ▼
L0u @koi/search-provider ◄───────────────────────┘
    imports from L0 only
    ✗ no function bodies or classes
    ✗ no external npm dependencies
    ✗ no import from L1 or L2
    ✓ All interface properties readonly
    ✓ All array parameters readonly T[]
    ✓ Registered in scripts/layers.ts L0U_PACKAGES
```
