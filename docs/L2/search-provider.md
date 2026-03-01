# @koi/search-provider — Search Provider Contract

Defines the `SearchProvider` interface — the formal contract that all web search backends implement. Types-only L0u package with zero runtime logic.

---

## Why It Exists

Before `@koi/search-provider`, search was wired via a bare function type (`searchFn`) in `WebExecutorConfig`. Adding a second provider meant duplicating types and hoping signatures stayed aligned. There was no manifest integration, no auto-discovery, and no compile-time contract enforcement.

This package extracts the contract into a shared L0u layer so:
- **Providers** (`@koi/search-brave`, future Tavily/SearXNG/Serper) implement a checked interface
- **Consumers** (`@koi/tools-web`) depend on the contract, not specific providers
- **Manifest resolution** can auto-discover providers via `BrickDescriptor<SearchProvider>`

---

## What This Enables

```
WITHOUT search-provider:
═══════════════════════
  tools-web defines inline types
  search-brave duck-types against them
  Adding a new provider = copy-paste types and hope

WITH search-provider:
═════════════════════
  search-provider defines: SearchProvider, WebSearchResult, WebSearchOptions
  search-brave implements SearchProvider (compile-time checked)
  tools-web accepts SearchProvider (contract-based injection)
  Manifest: search: "brave"  →  auto-resolved via BrickDescriptor
```

---

## Architecture

```
┌───────────────────────────────────────────────────────┐
│  @koi/search-provider  (L0u)                           │
│                                                        │
│  types.ts     ← SearchProvider, WebSearchResult,       │
│                  WebSearchOptions (~35 LOC)             │
│  index.ts     ← public API surface (re-exports)        │
│                                                        │
├────────────────────────────────────────────────────────┤
│  External deps: NONE                                   │
│  Internal deps: @koi/core (L0) — KoiError, Result      │
│  Runtime logic: NONE (types-only)                       │
└────────────────────────────────────────────────────────┘
```

### How It Plugs In

```
@koi/search-provider (L0u)     @koi/search-brave (L2)     @koi/tools-web (L2)
┌────────────────────────┐    ┌──────────────────────┐   ┌───────────────────────┐
│ SearchProvider          │◄───│ implements           │   │ accepts               │
│ WebSearchResult         │    │ SearchProvider       │   │ SearchProvider in      │
│ WebSearchOptions        │    │                      │   │ WebExecutorConfig      │
│                         │    │ + BrickDescriptor    │   │                        │
│ (contract only)         │    │   for auto-discovery │   │ (no vendor knowledge)  │
└────────────────────────┘    └──────────────────────┘   └───────────────────────┘
                                       │
                                       ▼
                              @koi/resolve (L0u)
                              resolveSearch() maps
                              manifest "search: brave"
                              → SearchProvider instance
```

---

## API Reference

### SearchProvider

```typescript
interface SearchProvider {
  readonly name: string;
  readonly search: (
    query: string,
    options?: WebSearchOptions,
  ) => Promise<Result<readonly WebSearchResult[], KoiError>>;
}
```

### WebSearchResult

```typescript
interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}
```

### WebSearchOptions

```typescript
interface WebSearchOptions {
  readonly maxResults?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}
```

---

## Manifest Integration

Agents declare their search backend in `koi.yaml`:

```yaml
# String shorthand
search: brave

# Object form with options
search:
  name: brave
  options:
    country: US
    freshness: pw
```

Resolution flow:
1. `resolveManifest()` sees `search:` key
2. Calls `resolveSearch()` which uses `resolveOne<SearchProvider>("search", ...)`
3. Registry finds `@koi/search-brave`'s descriptor (registered with `kind: "search"`, `aliases: ["brave"]`)
4. Descriptor's factory creates a `SearchProvider` instance
5. `ResolvedManifest.search` is wired into `createWebExecutor({ searchProvider })`

---

## Implementing a New Provider

```typescript
import type { KoiError, Result } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";
import type { SearchProvider, WebSearchOptions, WebSearchResult } from "@koi/search-provider";

function createMySearch(config: { apiKey: string }): SearchProvider {
  return {
    name: "my-search",
    search: async (query, options?) => {
      // Call your search API here
      const results: readonly WebSearchResult[] = [
        { title: "Result", url: "https://example.com", snippet: "A result" },
      ];
      return { ok: true, value: results };
    },
  };
}

export const descriptor: BrickDescriptor<SearchProvider> = {
  kind: "search",
  name: "@koi/search-my-provider",
  aliases: ["my-search"],
  description: "My custom search provider",
  tags: ["search", "web"],
  optionsValidator: (input) => ({ ok: true, value: input ?? {} }),
  factory(options, context) {
    const apiKey = context.env.MY_SEARCH_API_KEY;
    if (!apiKey) throw new Error("MY_SEARCH_API_KEY required");
    return createMySearch({ apiKey });
  },
};
```

---

## Testing

```
types.test.ts — 3 tests
  ● WebSearchResult properties are readonly
  ● WebSearchOptions properties are readonly
  ● SearchProvider properties are readonly

__tests__/api-surface.test.ts — 1 test
  ● .d.ts output matches snapshot
```

```bash
bun --cwd packages/search-provider test
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| L0u (not L0) | Contains `import type` from `@koi/core`. L0 must have zero imports |
| Types-only | Zero runtime logic keeps the package side-effect free and tree-shakeable |
| `readonly` everywhere | Immutability contract enforced at compile time |
| Single provider (not array) | Agents use one search backend. Multi-provider composition is a decorator concern |
| `Result<T, KoiError>` return | Expected failures returned as values. Never throws |
| `signal?: AbortSignal` in options | Enables cooperative cancellation and timeout enforcement |

---

## Layer Compliance

```
L0  @koi/core ───────────────────────────────────────┐
    KoiError, Result                                  │
                                                      │
                                                      ▼
L0u @koi/search-provider ◄─────────────────────────┘
    import type from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports any L2 package
    ✗ zero external npm dependencies
    ✗ zero runtime logic
    ✓ All interface properties readonly
    ✓ Types-only package
```
