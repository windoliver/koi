# Guide Agent Pattern

## Problem

When agents search docs or skills directly, raw results flood the parent's
context window with noise. A 500-token query returns 5,000 tokens of
unfiltered content, most of which is irrelevant. The agent's context fills
up, reasoning quality degrades, and costs increase.

## Solution

The **guide agent** pattern wraps knowledge retrieval in a thin tool that
enforces a token budget. The agent asks a focused question, the tool
searches and truncates, and the agent receives only concise, relevant context.

```
User: "How do I deploy to production?"
       │
       ▼
   Agent (has ask_guide tool)
       │
   ask_guide({ question: "deploy to production" })
       │
       ▼
   @koi/tool-ask-guide
       │
   createRetrieverSearch(retriever)  ←── @koi/search or @koi/search-nexus
       │
   accumulate results ≤ 500 tokens
       │
       ▼
   Agent gets 2-3 relevant chunks (not 50 raw docs)
```

## What This Enables

1. **Token-budgeted retrieval** — agents get concise answers instead of raw
   search dumps. The `maxTokens` config (default 500) caps how much content
   flows back into the agent's context window.

2. **Nested skill includes** — SKILL.md files can reference shared docs via
   the `includes` frontmatter directive. Related documentation is bundled at
   load time, so skills stay DRY while search indexes get complete content.

3. **Pluggable search backends** — the `createRetrieverSearch()` adapter
   bridges any `Retriever` (from `@koi/search-provider`) to the tool.
   Works with `@koi/search` (local hybrid BM25+vector) or
   `@koi/search-nexus` (remote Nexus service) out of the box.

## Packages

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/tool-ask-guide` | L2 | Tool + provider + Retriever adapter |
| `@koi/skills` (extended) | L2 | `includes` directive + `resolveIncludes()` |
| `@koi/search-provider` | L0u | `Retriever` interface (existing) |
| `@koi/search` | L2 | Local hybrid search backend (existing) |
| `@koi/search-nexus` | L2 | Remote Nexus search backend (existing) |

## How It Works

### The Tool

1. **Agent calls `ask_guide`** with a natural-language question
2. **Tool validates** the input (non-empty string)
3. **Tool delegates** to the `search()` callback (wired via `createRetrieverSearch`)
4. **Token accumulation** — results are added until the budget is hit
5. **Structured response** — `{ results, totalFound, truncated }`

### Nested Includes

Skills can reference shared documentation via the `includes` directive
in SKILL.md frontmatter:

```yaml
---
name: domain-expert
description: Answers questions about our domain
includes:
  - ./glossary.md
  - ../shared/api-reference.md
---
# Domain Expert
You are an expert on our domain...
```

When loaded with `loadSkillBody(dirPath, undefined, skillsRoot)`, the
included files' content is appended to the skill body. This means search
indexes over skill content automatically include the referenced docs.

Resolution rules:
- Relative paths only (`./` or `../`) — absolute paths and URLs rejected at schema level
- Recursive resolution up to depth 3 (configurable via `maxDepth`)
- Diamond dedup — if A and B both include C, C appears once
- Cycle protection — visited set prevents infinite loops
- Security boundary — resolved paths must stay within `skillsRoot` (enforced via `realpath`)

## Wiring Example

### With `@koi/search` (local)

```typescript
import { createAskGuideProvider, createRetrieverSearch } from "@koi/tool-ask-guide";
import { createSearch } from "@koi/search";

const search = createSearch({ dbPath: "./index.db", embedder: myEmbedder });

const guide = createAskGuideProvider({
  search: createRetrieverSearch(search.retriever),
  maxTokens: 500,
});
```

### With `@koi/search-nexus` (remote)

```typescript
import { createAskGuideProvider, createRetrieverSearch } from "@koi/tool-ask-guide";
import { createNexusSearch } from "@koi/search-nexus";

const nexus = createNexusSearch({ baseUrl: "https://nexus.example.com", apiKey: "..." });

const guide = createAskGuideProvider({
  search: createRetrieverSearch(nexus.retriever),
  maxTokens: 500,
});
```

### Manifest

```yaml
name: "knowledge-guide"
version: "1.0.0"
model: "anthropic:claude-haiku-4-5-20251001"
skills:
  - name: "domain-knowledge"
    path: "./skills/domain"
```

## When to Use

- Agents that answer knowledge questions from a corpus
- Agents with access to large skill/doc libraries
- Any agent where raw search results would pollute the context window

## Anti-Patterns

- **Don't dump all skills into the system prompt** — use the guide tool
  for on-demand retrieval instead
- **Don't skip the token budget** — unbounded results defeat the purpose
- **Don't use for real-time user interaction** — use `ask_user` for that
- **Don't create a custom search adapter** — use `createRetrieverSearch()`
  to bridge any `Retriever` implementation
