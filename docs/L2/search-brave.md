# @koi/search-brave — Brave Search API Adapter

Produces a `searchFn` compatible with `@koi/tools-web`'s `WebExecutorConfig`. One factory call wraps the Brave Search API behind a typed interface returning `Result<BraveSearchResult[], KoiError>`.

---

## Why It Exists

`@koi/tools-web` needs a search backend but deliberately doesn't bundle one — search providers are swappable L2 packages, not hardcoded. Brave Search offers a simple REST API with generous free-tier limits, making it the default choice for Koi agents that need web search.

`@koi/search-brave` keeps the Brave API details (auth headers, rate limit handling, response parsing) out of `@koi/tools-web`, maintaining clean L2 boundaries.

---

## What This Enables

```
WITHOUT search-brave:
═════════════════════
  web_search("Bun release notes")
  → { code: "VALIDATION", error: "No search backend configured" }


WITH search-brave:
══════════════════
  const searchFn = createBraveSearch({ apiKey: BRAVE_KEY });
  const executor = createWebExecutor({ searchFn });

  web_search("Bun release notes")
  → [
      { title: "Bun 1.3 Release", url: "https://bun.sh/...", snippet: "..." },
      { title: "Bun Blog",        url: "https://bun.sh/...", snippet: "..." },
    ]
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  @koi/search-brave  (L2)                                 │
│                                                          │
│  brave-search.ts     ← factory + API adapter (~170 LOC)  │
│  brave-search.test.ts                                    │
│  index.ts            ← public API surface                │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  External deps: NONE (uses platform fetch API)           │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Internal deps                                           │
│  ● @koi/core (L0) — KoiError, Result                    │
└──────────────────────────────────────────────────────────┘
```

### How It Plugs In

```
@koi/search-brave          @koi/tools-web             Koi Runtime
┌─────────────────┐   ┌──────────────────────┐   ┌────────────────┐
│ createBraveSearch│──▶│ createWebExecutor({  │──▶│ createKoi({    │
│ ({ apiKey })     │   │   searchFn: ▲        │   │   providers:   │
│                  │   │ })                   │   │   [provider]   │
│ returns searchFn │   │                      │   │ })             │
└─────────────────┘   │ createWebProvider({  │   └────────────────┘
                       │   executor           │
  No import between    │ })                   │   Agent now has
  these two packages!  └──────────────────────┘   web_search tool
```

---

## Usage

### Basic

```typescript
import { createBraveSearch } from "@koi/search-brave";
import { createWebExecutor, createWebProvider } from "@koi/tools-web";

const searchFn = createBraveSearch({ apiKey: process.env.BRAVE_API_KEY! });
const executor = createWebExecutor({ searchFn });
const provider = createWebProvider({ executor });
```

### With Country and Freshness

```typescript
const searchFn = createBraveSearch({
  apiKey: process.env.BRAVE_API_KEY!,
  country: "US",         // localized results
  freshness: "pw",       // past week only
  timeoutMs: 5_000,      // 5s timeout
});
```

### With Custom Fetch (for Testing)

```typescript
import { mock } from "bun:test";

const mockFetch = mock(async () => Response.json({
  web: { results: [{ title: "Test", url: "https://test.com", description: "Mock" }] },
})) as unknown as typeof globalThis.fetch;

const searchFn = createBraveSearch({ apiKey: "test-key", fetchFn: mockFetch });
```

---

## API Reference

### Factory

| Function | Params | Returns |
|----------|--------|---------|
| `createBraveSearch(config)` | `BraveSearchConfig` | `BraveSearchFn` |

### BraveSearchConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | *(required)* | Brave Search API key |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Custom fetch function |
| `baseUrl` | `string` | `https://api.search.brave.com/res/v1` | API base URL |
| `timeoutMs` | `number` | `10,000` | Request timeout |
| `country` | `string` | `undefined` | Country code (e.g., `"US"`, `"GB"`) |
| `freshness` | `string` | `undefined` | `"pd"` / `"pw"` / `"pm"` |

### BraveSearchFn

```typescript
type BraveSearchFn = (
  query: string,
  options?: { maxResults?: number; signal?: AbortSignal },
) => Promise<Result<readonly BraveSearchResult[], KoiError>>;
```

### BraveSearchResult

```typescript
interface BraveSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}
```

### Error Mapping

```
╔══════════════╦══════════════════════════╦═══════════╗
║ HTTP Status  ║ KoiError Code            ║ Retryable ║
╠══════════════╬══════════════════════════╬═══════════╣
║ 429          ║ RATE_LIMIT               ║ Yes       ║
║ 401, 403     ║ PERMISSION               ║ No        ║
║ 5xx          ║ EXTERNAL                 ║ Yes       ║
║ Network fail ║ EXTERNAL                 ║ Yes       ║
║ Abort/timeout║ TIMEOUT                  ║ Yes       ║
╚══════════════╩══════════════════════════╩═══════════╝
```

### Constants

| Constant | Value |
|----------|-------|
| `DEFAULT_BRAVE_BASE_URL` | `https://api.search.brave.com/res/v1` |
| `DEFAULT_BRAVE_TIMEOUT_MS` | `10_000` |

---

## Testing

```
brave-search.test.ts — 13 tests
  ● Returns search results from API
  ● Sends API key in X-Subscription-Token header
  ● Passes query and count in URL params
  ● Passes country and freshness params
  ● Returns RATE_LIMIT error for 429
  ● Returns PERMISSION error for 401
  ● Returns EXTERNAL error for 500
  ● Returns EXTERNAL error on network failure
  ● Returns TIMEOUT error on abort
  ● Returns TIMEOUT when signal is pre-aborted
  ● Clamps maxResults to valid range (1-20)
  ● Handles empty web results gracefully
  ● Handles missing fields in results
```

```bash
bun --cwd packages/search-brave test
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Separate L2 package | `@koi/tools-web` never imports this — avoids L2→L2 dependency |
| Injectable `fetchFn` | Same pattern as `WebExecutor`. Enables mock-based testing without network |
| `maxResults` clamped to 1-20 | Brave API limit is 20. Prevents invalid requests |
| `description` mapped to `snippet` | Brave calls it `description`; Koi's `WebSearchResult` uses `snippet`. Mapping happens here |
| Error codes match Koi conventions | 429 → RATE_LIMIT, 401 → PERMISSION, 5xx → EXTERNAL. Same codes the LLM already knows |
| AbortController for timeout | Platform-native cancellation. Caller's signal is forwarded |
| No caching in this package | Caching belongs in `WebExecutor` (centralized). This adapter is stateless |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    KoiError, Result                                   │
                                                       │
                                                       ▼
L2  @koi/search-brave ◄──────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 (@koi/tools-web)
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ Returns Result<T, KoiError> (never throws)
    ✓ Stateless adapter (no caching, no side effects beyond HTTP)
```
