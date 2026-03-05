# Deprecation: @koi/knowledge-vault

`@koi/knowledge-vault` was removed because its functionality is fully covered by the existing Nexus ecosystem. This document explains the rationale and the canonical replacement path.

---

## What knowledge-vault did

An L2 `ComponentProvider` that indexed markdown knowledge bases (Obsidian vaults, local directories, Nexus endpoints) using BM25 full-text search and returned token-budget-aware document selections. It attached a `KNOWLEDGE` component to agents at assembly time.

**Pipeline:** scan sources -> parse frontmatter -> build BM25 index -> query -> select within token budget

---

## Why it was removed

Every capability was already provided by existing, production-grade packages in the Nexus stack:

| knowledge-vault feature | Replaced by |
|---|---|
| Scan markdown directories | `@koi/filesystem-nexus` `.list()` + `.read()` |
| BM25 full-text search | `@koi/search-nexus` retriever (server-side BM25 + vector hybrid) |
| Index documents | `@koi/search-nexus` indexer via REST `/api/v2/search/index` |
| Nexus HTTP fetch | `@koi/nexus-client` REST transport |
| Token-budget selection | `@koi/context` hydrator per-source `maxTokens` + global budget |
| ComponentProvider (KNOWLEDGE) | `@koi/memory-fs` provides MEMORY component with `FsSearchRetriever` DI |
| Frontmatter parsing | ~140 LOC utility, extractable if needed |

The Nexus replacements are superior because they:

- Run search **server-side** (no in-process index rebuild on every agent start)
- Support **hybrid BM25 + vector** search (not just keyword)
- Scale to **distributed deployments** (Nexus handles multi-node state)
- Share infrastructure with memory-fs, gateway, and other subsystems

---

## Canonical replacement: the Nexus pipeline

```
@koi/filesystem-nexus         @koi/search-nexus          @koi/context-arena
FileSystemBackend             Retriever (BM25+vector)     Budget allocation
  .list() .read()               .retrieve(query)            Preset-driven
        │                           │                           │
        ▼                           ▼                           ▼
  Scan markdown dirs ───►  Index & search docs  ───►  Inject into context window
                                                       within token budget
```

### How to use it

Wire `@koi/search-nexus` as the retriever backend for `@koi/memory-fs`, then let `@koi/context-arena` manage the token budget:

```typescript
import { createNexusSearch } from "@koi/search-nexus";
import { createContextArena } from "@koi/context-arena";

const search = createNexusSearch({ baseUrl, apiKey });

const bundle = await createContextArena({
  // ... required fields ...
  memoryFs: {
    config: { baseDir: "/path/to/memory" },
    retriever: search.retriever,
    indexer: search.indexer,
  },
});
```

For static markdown directories, use `@koi/filesystem-nexus` to scan and `@koi/search-nexus` to index at deployment time, then query at runtime through the same retriever interface.

---

## What this enables

1. **Simpler dependency graph** -- one fewer L2 package to maintain, build, and test
2. **No duplicate BM25** -- knowledge-vault had its own 183 LOC BM25 implementation alongside `@koi/search`'s BM25; now there is exactly one search backend
3. **Server-side search** -- Nexus handles indexing and ranking, eliminating per-agent startup cost of rebuilding an in-memory index
4. **Hybrid search** -- `@koi/search-nexus` supports BM25 + vector, whereas knowledge-vault was keyword-only
5. **Unified memory path** -- all agent memory (facts, knowledge, preferences) flows through `memory-fs` + Nexus, not through parallel subsystems

---

## Related issues

- **#327** (closed) -- original implementation issue for `@koi/knowledge-vault`
