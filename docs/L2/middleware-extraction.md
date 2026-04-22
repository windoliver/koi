# @koi/middleware-extraction

Post-turn learning extraction middleware — extracts reusable knowledge from
spawn-family tool outputs and persists them as MemoryRecord entries.

## Recent updates

**Confidence trust model + dedup hardening (#1966)**: each extraction path now assigns a confidence value that reflects the strength of its signal:

| Extraction path | Confidence |
|----------------|-----------|
| Explicit `[LEARNING:category]` markers | 1.0 — explicit, author-declared |
| Auto-heuristic keyword patterns | 0.7 — inferred, lower trust |
| LLM post-session extraction | capped at 0.9 — model-generated |

Within explicit markers, high-signal categories (`gotcha`, `correction`, `preference`) set confidence=1.0; lower-signal categories (`heuristic`, `pattern`, `context`) also default to 1.0 but can be overridden by a `CATEGORY_CONFIDENCE` map. Confidence is forwarded as `MemoryStoreOptions.confidence` and stored in the `.md` frontmatter. The dedup store's `exactReplay` guard was extended to include `confidence` so a re-extraction at a different confidence level is not silently dropped.

## How It Works

The middleware intercepts `wrapToolCall` for spawn-family tools (`Spawn`,
`agent_spawn`, `task_delegate`) and runs two extraction paths:

1. **Real-time regex** — marker-based (`[LEARNING:category] content`) and
   heuristic keyword patterns, fires immediately on each tool response
2. **Post-session LLM** — accumulates outputs during the session, runs a
   cheap model extraction pass on `onSessionEnd` (fire-and-forget)

Extracted learnings are stored via `MemoryComponent.store()` with
`CollectiveMemoryCategory` preserved as `MemoryStoreOptions.category` and
the correct `MemoryType` passed as `MemoryStoreOptions.type` (fix #1966 —
previously the `type` field was absent; adapters defaulted to `"feedback"`
regardless of category).

## JSON output filtering (#1966)

Before extraction, spawn tool output is pre-processed through an allowlist
(`OUTPUT_FIELD_NAMES`: `result`, `output`, `text`, `message`, `content`,
`response`, `summary`) applied recursively at every nesting level. This
prevents poisoning via echoed request text, task subjects, metadata, or
raw command streams (`stdout`/`stderr`).

Command-result envelopes (`{ stdout, exitCode }`) are detected via
`isCommandResultEnvelope` and skipped entirely — `stdout` is raw subprocess
output, not model-authored content.

## Category → MemoryType mapping

The regex extractor maps `CollectiveMemoryCategory` to `MemoryType` before persistence:

| Category | MemoryType | Notes |
|----------|-----------|-------|
| `gotcha`, `correction`, `heuristic`, `pattern` | `feedback` | Fix for #1964 — `heuristic`/`pattern` were incorrectly mapped to `reference` (v1 porting error) |
| `preference` | `user` | Excluded from persistence (see Safety) |
| `context` | `project` | |
| unknown | `project` | Default fallback |

## Safety

- Secret scan (`@koi/redaction`) runs before any logging — credentials never appear in logs
- `<untrusted-data>` boundary tokens are escaped in LLM extraction prompts
- Preference learnings (`MemoryType: "user"`) are excluded from persistence; no content excerpt logged
- Namespace isolation: throws on `namespace=` to fail closed rather than silently crossing tenant boundaries
- Session state is keyed by `SessionId` to prevent cross-session bleed

## Configuration

```typescript
import { createExtractionMiddleware } from "@koi/middleware-extraction";

const mw = createExtractionMiddleware({
  memory,                          // MemoryComponent from ECS
  modelCall,                       // optional — for LLM extraction
  hotMemory,                       // optional — notifyStoreOccurred()
  spawnToolIds: ["Spawn"],         // override spawn tool IDs
  namespace: "my-agent",           // namespace isolation
  maxSessionOutputs: 20,           // cap per session
  maxOutputSizeBytes: 10_000,      // cap per output for LLM
});
```

## Priority

305 — after context hydrator (300), before hot-memory (310).

## Dependencies

- `@koi/core` (L0)
- `@koi/token-estimator` (L0u)
- `@koi/redaction` (L0u)

> **Biome formatting pass (#1636):** No behavioral changes — auto-formatted by biome check --write.
