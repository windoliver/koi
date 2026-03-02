# @koi/knowledge-vault — Business Context Hydration from Structured Knowledge Bases

Hydrates agent context from markdown directories, pre-built indexes, or Nexus endpoints using BM25 ranking and token-budget-aware selection. Attaches a `KNOWLEDGE` ECS component so agents can query domain knowledge at runtime.

---

## Why It Exists

Specialized agents fail when they lack business context. An orchestrator reading from a knowledge base can inject targeted domain information into each agent's prompt — but this requires scanning, indexing, ranking, and budget-aware selection of documents. Without it, every agent integration reinvents document discovery, relevance scoring, and token budgeting.

`@koi/knowledge-vault` solves this with a single `ComponentProvider` factory that:
- Scans multiple knowledge sources (directories, indexes, Nexus endpoints)
- Builds a BM25 search index with title/tag boosting
- Selects results within a token budget with cross-source diversity guarantees
- Exposes a `KNOWLEDGE` component for runtime queries

---

## What This Enables

### Domain-Agnostic Context Hydration

Any agent can be hydrated with business context from structured knowledge bases:

```
                  ┌───────────────────────────────────────────────────┐
                  │           Your Koi Agent (YAML)                   │
                  │  name: "billing-analyst"                          │
                  │  model: anthropic:claude-sonnet                   │
                  │  providers: [knowledge-vault]                     │
                  └──────────────────┬────────────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────────────┐
                  │     createKnowledgeVaultProvider(config)         │
                  │                                                  │
                  │  1. Scan sources (directory, index, nexus)       │
                  │  2. Parse frontmatter (title, tags)              │
                  │  3. Build BM25 index                             │
                  │  4. Expose KNOWLEDGE component                   │
                  │                                                  │
                  │  ┌────────────┐  ┌──────────┐  ┌──────────────┐ │
                  │  │ Directory  │  │  Index   │  │    Nexus     │ │
                  │  │  (local/   │  │ (search  │  │  (remote     │ │
                  │  │  backend)  │  │  engine) │  │   endpoint)  │ │
                  │  └────────────┘  └──────────┘  └──────────────┘ │
                  └──────────────────┬──────────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────────────┐
                  │              Runtime Query                       │
                  │                                                  │
                  │  component.query("billing API rate limits")      │
                  │    → BM25 search → budget selection → documents  │
                  └─────────────────────────────────────────────────┘
```

### Domain Examples

| Domain | Knowledge sources | Agent gets |
|--------|-------------------|-----------|
| **Coding** | Architecture docs, API contracts, style guides | Precise technical context for code generation |
| **Support** | Product docs, escalation policies, FAQ | Domain knowledge for customer responses |
| **Research** | Market reports, academic papers, prior findings | Background for analysis and synthesis |
| **Legal** | Contract templates, regulatory requirements | Compliance context for document review |

### Before vs After

```
BEFORE: Agent has no business context
══════════════════════════════════════

  Agent: "What are the billing API rate limits?"
  → No knowledge source configured
  → Agent hallucinates or asks the user

AFTER: Agent queries knowledge vault
═════════════════════════════════════

  Agent: "What are the billing API rate limits?"
  → KNOWLEDGE.query("billing API rate limits")
  → BM25 ranks billing-api.md highest (score: 0.87)
  → Returns: "Rate limits: 100 req/min for free tier, 1000 for pro..."
  → Agent responds with accurate, sourced information
```

### FileSystemBackend Support

Directory sources can use any `FileSystemBackend` implementation — not just local disk:

```
BEFORE: Local-only (Bun.file)
═════════════════════════════

  sources: [{ kind: "directory", path: "/docs" }]
  → Bun.Glob scans local filesystem
  → Only works on the machine where docs live

AFTER: Any FileSystemBackend
════════════════════════════

  sources: [{ kind: "directory", path: "/docs", backend: nexusBackend }]
  → backend.list() discovers files remotely
  → backend.read() fetches content over network
  → Works with Nexus, S3, in-memory mocks, etc.
```

### Scope Enforcement

Path boundary enforcement prevents agents from reading outside their allowed root:

```
  config: {
    sources: [{ kind: "directory", path: "/project/docs", backend }],
    scope: { root: "/project/docs", mode: "ro" }
  }

  → backend is wrapped with createScopedFileSystem()
  → Path traversal attempts are blocked
  → Read-only mode prevents writes through the backend
```

---

## Architecture

`@koi/knowledge-vault` is an **L2 feature package**.

```
┌───────────────────────────────────────────────────────┐
│  @koi/knowledge-vault  (L2)                           │
│                                                       │
│  types.ts                ← config, component, tokens  │
│  vault-service.ts        ← orchestration + BM25 index │
│  component-provider.ts   ← ComponentProvider factory   │
│  context-source-adapter.ts ← @koi/context integration │
│                                                       │
│  source-directory.ts     ← scan dirs (Bun or backend) │
│  source-index.ts         ← query pre-built indexes    │
│  source-nexus.ts         ← fetch from Nexus endpoints │
│                                                       │
│  bm25.ts                 ← BM25 ranking engine        │
│  selector.ts             ← budget-aware selection      │
│  frontmatter.ts          ← YAML frontmatter parser    │
│                                                       │
├───────────────────────────────────────────────────────┤
│  External deps: NONE                                  │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Internal deps                                        │
│  ● @koi/core (L0) — SubsystemToken, TokenEstimator,  │
│    FileSystemBackend, Result, KoiError                │
│  ● @koi/scope (L0u) — createScopedFileSystem          │
│  ● @koi/search-provider (L0u) — Retriever interface   │
│  ● @koi/token-estimator (L0u) — HEURISTIC_ESTIMATOR  │
│                                                       │
│  Dev-only                                             │
│  ● @koi/test-utils — test helpers                     │
└───────────────────────────────────────────────────────┘
```

### Layer Position

```
L0  @koi/core ────────────────────────────────────────┐
    SubsystemToken, TokenEstimator,                    │
    FileSystemBackend, KoiError, Result                │
                                                       │
L0u @koi/scope ───────────────────────────────────────┤
    createScopedFileSystem, FileSystemScope             │
                                                       │
L0u @koi/search-provider ────────────────────────────┤
    Retriever                                          │
                                                       │
L0u @koi/token-estimator ────────────────────────────┤
    HEURISTIC_ESTIMATOR                                │
                                                       │
                                                       ▼
L2  @koi/knowledge-vault ◄────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ FileSystemBackend abstraction (not Bun-locked)
    ✓ Scope enforcement via @koi/scope composition
```

### Internal Structure

```
createKnowledgeVaultProvider(config)
│
├── config.sources[]       → Knowledge source configs
│     ├── directory        → Local or backend-based file scanning
│     ├── index            → Pre-built search index (Retriever)
│     └── nexus            → Remote Nexus endpoint
│
├── config.tokenBudget?    → 4000 (default)
├── config.relevanceThreshold? → 0.0 (default)
├── config.scope?          → FileSystemScope (optional boundary enforcement)
│
└── attach(agent) → Map<SubsystemToken, KnowledgeComponent>
    │
    └── KNOWLEDGE token → {
          sources: KnowledgeSourceInfo[]     ← name, kind, description, docCount
          query(q, limit?) → KnowledgeDocument[]  ← BM25 + budget selection
          refresh() → RefreshResult               ← re-scan all sources
        }
```

---

## Pipeline

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Sources    │───>│   Parsing    │───>│   Indexing   │───>│   Querying   │
│              │    │              │    │              │    │              │
│ • Directory  │    │ • Frontmatter│    │ • BM25 index │    │ • BM25 search│
│   (Bun/      │    │   extraction │    │ • Title boost│    │ • Budget     │
│    Backend)  │    │ • Title/tags │    │ • Tag boost  │    │   selection  │
│ • Index      │    │ • Truncation │    │              │    │ • Diversity  │
│ • Nexus      │    │ • Token est. │    │              │    │   guarantee  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### BM25 Configuration

| Parameter | Default | Purpose |
|-----------|---------|---------|
| k1 | 1.5 | Term frequency saturation |
| b | 0.75 | Document length normalization |
| titleBoost | 3.0 | Weight multiplier for title matches |
| tagBoost | 2.0 | Weight multiplier for tag matches |

### Budget Selection

The selector enforces two guarantees:
1. **Token budget**: Total selected document tokens stay within `tokenBudget`
2. **Source diversity**: At least one document from each source (if budget allows)

---

## Usage

### Basic — Local Directory

```typescript
import { createKnowledgeVaultProvider } from "@koi/knowledge-vault";

const provider = createKnowledgeVaultProvider({
  sources: [
    {
      kind: "directory",
      path: "/project/docs",
      name: "project-docs",
      description: "Internal engineering documentation",
    },
  ],
  tokenBudget: 4000,
});
```

### Remote Filesystem via Backend

```typescript
import { createKnowledgeVaultProvider } from "@koi/knowledge-vault";

const provider = createKnowledgeVaultProvider({
  sources: [
    {
      kind: "directory",
      path: "/docs",
      name: "remote-docs",
      description: "Documentation stored on Nexus",
      backend: nexusFileSystemBackend,  // any FileSystemBackend implementation
    },
  ],
});
```

### Scoped + Backend (sandboxed remote access)

```typescript
import { createKnowledgeVaultProvider } from "@koi/knowledge-vault";

const provider = createKnowledgeVaultProvider({
  sources: [
    {
      kind: "directory",
      path: "/project/docs",
      backend: remoteBackend,
      description: "Scoped engineering docs",
    },
  ],
  scope: { root: "/project/docs", mode: "ro" },
  // backend is wrapped with createScopedFileSystem() automatically
});
```

### Multiple Sources

```typescript
const provider = createKnowledgeVaultProvider({
  sources: [
    {
      kind: "directory",
      path: "/docs/api",
      name: "api-docs",
      description: "API reference and contracts",
    },
    {
      kind: "directory",
      path: "/docs/arch",
      name: "architecture",
      description: "Architecture decisions and patterns",
    },
    {
      kind: "nexus",
      endpoint: "https://nexus.internal/knowledge",
      name: "shared-knowledge",
      description: "Organization-wide knowledge base",
    },
  ],
  tokenBudget: 8000,
  relevanceThreshold: 0.1,
});
```

### Runtime Query

```typescript
import { KNOWLEDGE } from "@koi/knowledge-vault";

// In middleware or agent code:
const knowledge = agent.component(KNOWLEDGE);

// Query for relevant documents
const docs = await knowledge.query("authentication JWT tokens", 5);
for (const doc of docs) {
  console.log(`${doc.title} (score: ${doc.relevanceScore})`);
  console.log(doc.content);
}

// Check source metadata
for (const source of knowledge.sources) {
  console.log(`${source.name}: ${source.documentCount} docs — ${source.description}`);
}

// Re-scan all sources
const refreshResult = await knowledge.refresh();
```

### Context Source Adapter

```typescript
import { createKnowledgeSourceResolver, createVaultService } from "@koi/knowledge-vault";

const result = await createVaultService(config);
if (result.ok) {
  const resolver = createKnowledgeSourceResolver(result.value);
  // Register with @koi/context hydrator
  resolvers.set("knowledge", resolver);
}
```

---

## Configuration Reference

### KnowledgeVaultConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sources` | `KnowledgeSourceConfig[]` | (required) | Knowledge source configurations |
| `tokenBudget` | `number` | 4000 | Max tokens for query results |
| `relevanceThreshold` | `number` | 0.0 | Min BM25 score to include (0-1) |
| `maxIndexCharsPerDoc` | `number` | 2000 | Max chars indexed per document |
| `maxWarnings` | `number` | 50 | Max warnings before truncation |
| `scope` | `FileSystemScope` | (none) | Path boundary enforcement for directory backends |

### DirectorySourceConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `kind` | `"directory"` | (required) | Source type discriminator |
| `name` | `string` | auto-generated | Human-readable source name |
| `description` | `string` | (none) | What this source contains |
| `path` | `string` | (required) | Root directory path |
| `glob` | `string` | `"**/*.md"` | File discovery pattern |
| `exclude` | `string[]` | (none) | Glob patterns to exclude |
| `backend` | `FileSystemBackend` | (none) | Custom filesystem backend (default: Bun APIs) |

### IndexSourceConfig

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"index"` | Source type discriminator |
| `name` | `string` | Human-readable source name |
| `description` | `string` | What this source contains |
| `backend` | `Retriever<unknown>` | Search backend implementing Retriever interface |

### NexusSourceConfig

| Field | Type | Description |
|-------|------|-------------|
| `kind` | `"nexus"` | Source type discriminator |
| `name` | `string` | Human-readable source name |
| `description` | `string` | What this source contains |
| `endpoint` | `string` | Nexus knowledge endpoint URL |

---

## Testing

### Test Structure

```
packages/knowledge-vault/src/
  bm25.test.ts                   BM25: IDF, TF, normalization, edge cases
  frontmatter.test.ts            Frontmatter: YAML parsing, edge cases
  selector.test.ts               Selector: budget, diversity, edge cases
  source-directory.test.ts       Directory: Bun path, backend path, errors
  source-index.test.ts           Index: Retriever integration
  source-nexus.test.ts           Nexus: HTTP endpoint with real server
  vault-service.test.ts          Service: orchestration, description, scope
  component-provider.test.ts     Provider: attach, refresh, descriptions
  __tests__/e2e.test.ts          E2E: full pipeline, edge cases, backend
```

### Coverage

80 tests total, 0 failures. Covers all source types, error paths, edge cases, and the full pipeline.

```bash
# Run all knowledge-vault tests
bun test --cwd packages/knowledge-vault

# Type-check
bun run --cwd packages/knowledge-vault typecheck

# Build
bun run --cwd packages/knowledge-vault build
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| BM25 over vector search | Zero dependencies, works offline, no embedding model needed. Semantic search can be layered via `IndexSourceConfig` + `@koi/search-nexus` |
| Token budget selection | Prevents context window overflow — agents get the most relevant docs that fit |
| Source diversity guarantee | When multiple sources exist, at least one doc from each prevents single-source dominance |
| `FileSystemBackend` abstraction | Directory source works with local disk, Nexus FS, S3, or in-memory mocks |
| Scope composition (not inheritance) | `createScopedFileSystem()` wraps the backend — same pattern as `@koi/filesystem` |
| `description` on sources | Agents and orchestrators can understand what each source contains without reading its documents |
| Frontmatter parsing | Compatible with Obsidian, Hugo, Jekyll, and any YAML-frontmatter markdown |
| No refresh timer | v1 is pull-based (`refresh()`) — push-based watchers can be added later without API changes |

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    SubsystemToken, TokenEstimator,                    │
    FileSystemBackend, FileReadResult, FileListResult,  │
    KoiError, Result                                   │
                                                       │
L0u @koi/scope ───────────────────────────────────────┤
    createScopedFileSystem, FileSystemScope             │
                                                       │
L0u @koi/search-provider ────────────────────────────┤
    Retriever                                          │
                                                       │
L0u @koi/token-estimator ────────────────────────────┤
    HEURISTIC_ESTIMATOR                                │
                                                       │
                                                       ▼
L2  @koi/knowledge-vault ◄────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ FileSystemBackend abstraction (not Bun-locked)
    ✓ Scope enforcement via @koi/scope composition
    ✓ All interface properties readonly
    ✓ Immutable return values throughout
```
