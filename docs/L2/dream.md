# @koi/dream

Offline memory consolidation — merges similar memories, prunes cold ones,
upgrades high-value records via LLM.

## How It Works

`runDreamConsolidation(config)` is a standalone async function:

1. Lists all memories from the configured store
2. Scores each by exponential decay salience (30-day half-life)
3. Partitions by `MemoryType` (prevents cross-type merges)
4. Clusters within each type by Jaccard similarity (complete-linkage)
5. For multi-member clusters: LLM merge into a single richer record
6. Prunes memories below the salience threshold
7. Write-ahead: merged record created before originals deleted

## Gate Logic

`shouldDream(state, options)` — both conditions must pass:

- Time gate: enough time since last dream (default 24h)
- Session gate: enough sessions touched memory (default 5)

## Safety

- Type-partitioned clustering prevents user/feedback merge collisions
- LLM merge output type is enforced to match the cluster's original type
- Write-ahead ordering: data loss impossible, duplicates are safe
- Supersedes provenance embedded in merged content for idempotency

## Concurrency

Callers MUST ensure mutual exclusion. Use `config.lockDir` with a
cross-process lock, or the scheduler's built-in exclusion.

## Configuration

```typescript
import { runDreamConsolidation } from "@koi/dream";

const result = await runDreamConsolidation({
  listMemories: () => store.list(),
  writeMemory: (input) => store.write(input),
  deleteMemory: (id) => store.delete(id),
  modelCall,
  mergeThreshold: 0.5,
  pruneThreshold: 0.05,
  similarity: customJaccard,       // optional override
});
```

## Dependencies

- `@koi/core` (L0)
- `@koi/token-estimator` (L0u)
