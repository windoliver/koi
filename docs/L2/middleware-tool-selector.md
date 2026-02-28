# @koi/middleware-tool-selector — Pre-Filter Tools Before Model Calls

Reduces the set of tools the LLM sees on each turn using pluggable selection strategies. Ships with two built-in strategies: keyword-based scoring and tag-based profile filtering. Saves tokens, improves selection accuracy, and enables YAML-driven tool profiles.

---

## Why It Exists

An agent with 30+ tools sends every tool descriptor to the model on every turn. This creates two problems:

1. **Token waste** — each tool descriptor costs ~100-200 tokens. 30 tools = 3,000-6,000 tokens per call, most of them irrelevant.
2. **Selection confusion** — when presented with too many choices, LLMs pick the wrong tool more often.

This middleware solves both:

- **Query-based selection** — scores tools against the user's query and sends only the top N
- **Tag-based profiles** — uses `ToolDescriptor.tags` to define static tool profiles (e.g., "only coding tools", "no dangerous tools")
- **`alwaysInclude`** — forces critical tools into every request regardless of filtering
- **Graceful degradation** — if the selector crashes, all tools pass through (fail-open for availability)

Without this package, every agent with a large tool surface would reimplement tool scoring, tag filtering, and threshold logic.

---

## Architecture

`@koi/middleware-tool-selector` is an **L2 feature package** — depends on L0 (`@koi/core`), L0u (`@koi/errors`), and `@koi/resolve` for descriptor registration. Zero external dependencies.

```
┌──────────────────────────────────────────────────────────┐
│  @koi/middleware-tool-selector  (L2)                      │
│                                                          │
│  config.ts          ← ToolSelectorConfig + validation    │
│  extract-query.ts   ← default query extraction from msgs │
│  tool-selector.ts   ← middleware factory (core logic)    │
│  descriptor.ts      ← BrickDescriptor for YAML manifest │
│  index.ts           ← public API surface                 │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Dependencies                                            │
│                                                          │
│  @koi/core    (L0)   KoiMiddleware, ModelRequest,        │
│                       ModelResponse, TurnContext,          │
│                       ToolDescriptor, InboundMessage       │
│  @koi/errors  (L0u)  KoiRuntimeError, swallowError       │
│  @koi/resolve (L0u)  BrickDescriptor (manifest binding)   │
└──────────────────────────────────────────────────────────┘
```

---

## How It Works

### The Filtering Pipeline

Every `ModelRequest` passes through this pipeline before reaching the LLM:

```
ModelRequest arrives (with all tools)
    │
    ├── tools === undefined?  ──yes──▶ pass through (no tools to filter)
    │
    ├── tools.length <= minTools?  ──yes──▶ pass through (below threshold)
    │
    ├── extractQuery(messages) === ""?  ──yes──▶ pass through (no query)
    │
    ▼
┌───────────────────────────────────┐
│  selectTools(query, tools)        │
│                                   │
│  Strategy A: keyword scoring      │
│    "deploy the app"               │
│    → scores: deploy(3), bash(1)   │
│    → returns: ["deploy", "bash"]  │
│                                   │
│  Strategy B: tag filtering        │
│    tags: [coding]                 │
│    → returns tools with tag       │
│    → deterministic, ignores query │
└──────────────┬────────────────────┘
               │
               ▼
┌───────────────────────────────────┐
│  Build name set                   │
│                                   │
│  selected (capped at maxTools)    │
│  + alwaysInclude                  │
│  ────────────────────────────     │
│  = final tool set                 │
└──────────────┬────────────────────┘
               │
               ▼
  ModelRequest with filtered tools
  + metadata: { toolsBeforeFilter, toolsAfterFilter }
```

### Middleware Position (Onion)

Priority **420** — runs after guards (0-400) but before the terminal model call:

```
                    outermost
┌──────────────────────────────────────────────┐
│  permissions (priority 100)                   │
│  ┌────────────────────────────────────────┐  │
│  │  call-limits (priority 200)            │  │
│  │  ┌──────────────────────────────────┐  │  │
│  │  │  tool-selector (priority 420)  ◄─┤──┤──┤── YOU ARE HERE
│  │  │  ┌────────────────────────────┐  │  │  │
│  │  │  │  soul (priority 500)       │  │  │  │
│  │  │  │  ┌──────────────────────┐  │  │  │  │
│  │  │  │  │  terminal (model)    │  │  │  │  │
│  │  │  │  └──────────────────────┘  │  │  │  │
│  │  │  └────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────┘  │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
                    innermost
```

The tool-selector sees the full tool set from `callHandlers.tools`, filters it, and passes the reduced set inward. Inner middleware and the terminal handler only see the filtered tools.

---

## Two Selection Strategies

### Strategy 1: Keyword Scoring (default)

Used when no `tags` or `exclude` options are set. Splits the user's query into terms and scores each tool by keyword overlap with its name + description.

```
Query: "read the config file and parse it"
Terms: ["read", "config", "file", "parse"]

Tool               Name+Desc haystack           Score
─────────────────  ─────────────────────────     ─────
file_read          "file_read Read files"        2  ✓
json_parse         "json_parse Parse JSON"       1  ✓
shell_exec         "shell_exec Execute shell"    0  ✗
web_search         "web_search Search web"       0  ✗

Result: ["file_read", "json_parse"]
```

Best for: agents with many diverse tools where the query naturally contains tool-relevant keywords.

### Strategy 2: Tag-Based Profiles

Used when `tags` and/or `exclude` options are set in the YAML manifest. Ignores the query entirely — filtering is deterministic based on `ToolDescriptor.tags`.

```
tags: [coding]
exclude: [dangerous]

Tool               Tags                        Result
─────────────────  ─────────────────────────   ──────
file_read          [coding, filesystem]        ✓ PASS  (has "coding", no "dangerous")
shell_exec         [coding, dangerous]         ✗ FAIL  (has "dangerous")
calculator         [coding, math]              ✓ PASS  (has "coding", no "dangerous")
web_search         [research]                  ✗ FAIL  (no "coding" tag)
rm_rf              [filesystem, dangerous]     ✗ FAIL  (no "coding" tag)
```

**Tag semantics:**

| Filter | Logic | Example |
|--------|-------|---------|
| `tags` (include) | AND — tool must have ALL specified tags | `tags: [coding, math]` → tool needs both |
| `exclude` | ANY — tool is removed if it has ANY excluded tag | `exclude: [dangerous]` → one match = removed |
| No tags on tool | Excluded when `tags` is specified, included when only `exclude` is specified | Untagged tools are conservative |

Best for: role-based agents where you want a fixed tool profile (coding agent, research agent, safe agent).

---

## Tag-Based Tool Profiles

The main feature enabled by tag filtering. Define tool profiles entirely in YAML:

```
┌─────────────────────────────────────────────────────────┐
│                    koi.yaml                              │
│                                                         │
│  middleware:                                            │
│    - name: "@koi/middleware-tool-selector"               │
│      options:                                           │
│        tags: [coding]                                   │
│        exclude: [dangerous]                             │
│        alwaysInclude: [web_search]                      │
│        minTools: 0                                      │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              All Tools on Agent Entity                   │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ file_read    │  │ shell_exec   │  │ calculator   │  │
│  │ [coding,     │  │ [coding,     │  │ [coding,     │  │
│  │  filesystem] │  │  dangerous]  │  │  math]       │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ web_search   │  │ rm_rf        │  │ git_push     │  │
│  │ [research]   │  │ [filesystem, │  │ [coding,     │  │
│  │              │  │  dangerous]  │  │  dangerous]  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│           Tag Filter Pipeline                            │
│                                                         │
│  Step 1  Include tags: [coding]                         │
│          ✓ file_read  ✓ shell_exec  ✓ calculator        │
│          ✗ web_search ✗ rm_rf       ✓ git_push          │
│                                                         │
│  Step 2  Exclude tags: [dangerous]                      │
│          ✓ file_read  ✗ shell_exec  ✓ calculator        │
│                                     ✗ git_push          │
│                                                         │
│  Step 3  alwaysInclude: [web_search]                    │
│          + web_search (forced back in)                  │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Tools Model Actually Sees                    │
│                                                         │
│  file_read · calculator · web_search                    │
│                                                         │
│  6 tools → 3 tools  (fewer tokens, better selection)    │
└─────────────────────────────────────────────────────────┘
```

### Example Profiles

**Safe coding agent** — no shell/filesystem destruction:

```yaml
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [coding]
      exclude: [dangerous]
      minTools: 0
```

**Research-only agent** — can only search and read:

```yaml
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [research]
      minTools: 0
```

**Full-access agent with essential tools pinned:**

```yaml
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      alwaysInclude: [bash, file_read, file_write]
      maxTools: 15
```

---

## API Reference

### `createToolSelectorMiddleware(config)`

Factory function. Returns a `KoiMiddleware` instance.

```typescript
import { createToolSelectorMiddleware } from "@koi/middleware-tool-selector";

const middleware = createToolSelectorMiddleware({
  selectTools: mySelector,
  alwaysInclude: ["bash"],
  maxTools: 10,
  minTools: 5,
  extractQuery: myExtractor,
});
```

**Config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `selectTools` | `(query, tools) => Promise<string[]>` | *required* | Returns tool names to include |
| `alwaysInclude` | `string[]` | `[]` | Tool names always included regardless of selection |
| `maxTools` | `number` | `10` | Cap on tools returned by `selectTools` |
| `minTools` | `number` | `5` | Skip filtering when tool count is at or below this |
| `extractQuery` | `(messages) => string` | `extractLastUserText` | Custom query extraction from messages |

### `createTagSelectTools(includeTags, excludeTags)`

Creates a tag-based `selectTools` function for use with the middleware.

```typescript
import { createTagSelectTools } from "@koi/middleware-tool-selector";

const selectTools = createTagSelectTools(
  ["coding", "math"],   // include: tool must have ALL
  ["dangerous"],         // exclude: tool must have NONE
);
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `includeTags` | `readonly string[] \| undefined` | AND — tool must have all tags. `undefined` = no include filter |
| `excludeTags` | `readonly string[] \| undefined` | ANY — tool excluded if it has any tag. `undefined` = no exclude filter |

**Returns:** `(query: string, tools: readonly ToolDescriptor[]) => Promise<readonly string[]>`

The returned function ignores `query` — filtering is deterministic.

### `extractLastUserText(messages)`

Default query extractor. Returns the text content of the last message in the array.

```typescript
import { extractLastUserText } from "@koi/middleware-tool-selector";

const query = extractLastUserText(messages);
// → "deploy the app to production"
```

### `descriptor` (BrickDescriptor)

Enables YAML manifest auto-resolution. Registered as `@koi/middleware-tool-selector` (alias: `tool-selector`).

**YAML options:**

| Option | Type | Description |
|--------|------|-------------|
| `tags` | `string[]` | Include filter — tool must have all listed tags |
| `exclude` | `string[]` | Exclude filter — tool removed if it has any listed tag |
| `alwaysInclude` | `string[]` | Tool names forced into every request |
| `maxTools` | `number` | Cap on tools from selector (positive integer) |
| `minTools` | `number` | Skip filtering below this count (non-negative integer) |

When `tags` or `exclude` is present, the descriptor creates a tag-based selector. Otherwise it falls back to keyword scoring.

### `validateToolSelectorConfig(config)`

Validates a `ToolSelectorConfig` object. Returns `Result<ToolSelectorConfig, KoiError>`.

---

## Examples

### 1. Keyword-based filtering (programmatic)

```typescript
import { createToolSelectorMiddleware, extractLastUserText } from "@koi/middleware-tool-selector";

const middleware = createToolSelectorMiddleware({
  selectTools: async (query, tools) => {
    // Custom LLM-based selector
    const response = await llm.complete({
      prompt: `Pick the 5 most relevant tools for: "${query}"\n${tools.map(t => t.name).join(", ")}`,
    });
    return parseToolNames(response);
  },
  extractQuery: extractLastUserText,
  maxTools: 5,
});
```

### 2. Tag-based profile (YAML manifest)

```yaml
# koi.yaml — safe coding agent
name: safe-coder
version: "0.1.0"
model:
  name: "anthropic:claude-haiku-4-5-20251001"
middleware:
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [coding]
      exclude: [dangerous, admin]
      alwaysInclude: [web_search]
      minTools: 0
```

### 3. Tag-based profile (programmatic)

```typescript
import {
  createTagSelectTools,
  createToolSelectorMiddleware,
} from "@koi/middleware-tool-selector";

const selectTools = createTagSelectTools(["coding"], ["dangerous"]);

const middleware = createToolSelectorMiddleware({
  selectTools,
  alwaysInclude: ["web_search"],
  minTools: 0,
});
```

### 4. Composed with permissions middleware

```yaml
# koi.yaml — belt-and-suspenders safety
name: guarded-agent
version: "0.1.0"
model:
  name: "anthropic:claude-sonnet-4-6"
middleware:
  # First: tag filter removes dangerous tools entirely
  - name: "@koi/middleware-tool-selector"
    options:
      tags: [coding]
      exclude: [dangerous]
      minTools: 0
  # Second: permissions gate remaining tools with human approval
  - name: "@koi/middleware-permissions"
    options:
      allow: ["file_read", "calculator"]
      ask: ["*"]
```

In this setup, the tool-selector removes dangerous tools *before* the permissions middleware even sees them. The permissions middleware then gates the remaining safe tools with human approval.

### 5. Tagging tools in a ComponentProvider

```typescript
import type { ComponentProvider, Tool } from "@koi/core";
import { toolToken } from "@koi/core/ecs";

function createMyToolsProvider(): ComponentProvider {
  const fileTool: Tool = {
    descriptor: {
      name: "file_read",
      description: "Read a file from disk.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      tags: ["coding", "filesystem"],  // ← tags for profile filtering
    },
    trustTier: "sandbox",
    execute: async (args) => Bun.file(String(args.path)).text(),
  };

  return {
    name: "my-tools",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("file_read"), fileTool);
      return components;
    },
  };
}
```

---

## Performance

### Hot Path (tools <= minTools)

```
filterRequest()
  ├── tools.length <= minTools?  ──yes──▶ return request  (zero-cost)
  └── 0 allocations, 0 awaits
```

When the agent has fewer tools than `minTools` (default 5), the middleware is a no-op with zero overhead.

### Filtering Path

```
filterRequest()
  ├── extractQuery()    O(m)  m = message content length
  ├── selectTools()     O(n)  n = tool count (tag filter) or O(n*k) (keyword, k=terms)
  ├── Set construction  O(s)  s = selected + alwaysInclude count
  └── Array.filter()    O(n)  n = tool count
```

Total: **O(n)** for tag-based filtering (query is ignored). No network calls, no LLM invocations.

### Graceful Degradation

If `selectTools()` throws, the error is swallowed (logged via `swallowError`) and the unfiltered request passes through. This ensures a broken selector never blocks the agent.

---

## Layer Compliance

```
L0  @koi/core ──────────────────┐
    ToolDescriptor, tags,        │
    KoiMiddleware, ModelRequest  │
                                 ▼
L2  @koi/middleware-tool-selector ◄──────┘
    ✓ imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

---

## Glossary

| Term | Meaning |
|------|---------|
| **selectTools** | Pluggable function that chooses which tools to keep |
| **alwaysInclude** | Tool names bypassing the selector — always present |
| **minTools** | Threshold below which filtering is skipped entirely |
| **maxTools** | Cap on how many tools the selector can return |
| **tags** | String labels on `ToolDescriptor` for profile-based filtering |
| **exclude** | Tags that cause a tool to be removed regardless of include match |
| **keyword scoring** | Default strategy: score tools by term overlap with query |
| **tag profile** | A named set of include/exclude tags defining a tool surface |
