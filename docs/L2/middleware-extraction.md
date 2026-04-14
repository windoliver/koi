# @koi/middleware-extraction

Post-turn learning extraction middleware — extracts reusable knowledge from
spawn-family tool outputs and persists them as MemoryRecord entries.

## How It Works

The middleware intercepts `wrapToolCall` for spawn-family tools (`Spawn`,
`agent_spawn`, `task_delegate`) and runs two extraction paths:

1. **Real-time regex** — marker-based (`[LEARNING:category] content`) and
   heuristic keyword patterns, fires immediately on each tool response
2. **Post-session LLM** — accumulates outputs during the session, runs a
   cheap model extraction pass on `onSessionEnd` (fire-and-forget)

Extracted learnings are stored via `MemoryComponent.store()` with
`CollectiveMemoryCategory` preserved as `MemoryStoreOptions.category`.

## Safety

- Candidates are scanned for secrets via `@koi/redaction` before persistence
- `<untrusted-data>` boundary tokens are escaped in LLM extraction prompts
- Preference learnings (mapped to `MemoryType: "user"`) are excluded from
  persistence since `MemoryComponent.store()` cannot set the record type
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
