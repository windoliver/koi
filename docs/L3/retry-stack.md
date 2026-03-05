# @koi/retry-stack — Intelligent Retry and Recovery Bundle

Layer 3 meta-package that composes up to 3 middleware into a single
`createRetryStack()` call: **diagnose → undo → retry smarter**.

## What This Enables

**Coordinated retry and recovery.** Without this package, three independent
retry/recovery middleware operate in isolation:

1. **semantic-retry** diagnoses failures and rewrites prompts — but doesn't
   know about filesystem side effects
2. **guided-retry** injects backtrack constraints — but has no awareness of
   semantic-retry's failure history
3. **fs-rollback** captures and reverts file changes — but doesn't coordinate
   with the retry middleware

With `@koi/retry-stack`, you get:

- **Deployment presets** (`light`, `standard`, `aggressive`) with tuned retry budgets
- **3-layer config merge**: defaults → preset → user overrides
- **Priority-ordered composition**: fs-rollback (350) → semantic-retry (420) → guided-retry (425)
- **Unified handles**: access all L2 controls through a single bundle
- **Cascading reset**: one `reset()` call clears all state across middleware

## Quick Start

```typescript
import { createRetryStack } from "@koi/retry-stack";
import { createKoi } from "@koi/engine";

// Light — semantic-retry only, 1 retry max
const { middleware } = createRetryStack({ preset: "light" });

// Standard — semantic + guided, 3 retries (default)
const stack = createRetryStack({});

// Aggressive + filesystem rollback
const full = createRetryStack({
  preset: "aggressive",
  fsRollback: {
    store: mySnapshotStore,
    chainId: myChainId,
    backend: myFileSystemBackend,
  },
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...full.middleware, ...otherMiddleware],
});

// Access L2 handles directly
full.semanticRetry.getRecords();      // retry history
full.guidedRetry.hasConstraint();     // active constraint?
full.fsRollback?.rollbackTo(nodeId);  // undo file changes

// Reset all state between sessions
full.reset();
```

## Middleware Priority Order

| Priority | Middleware | Description |
|----------|-----------|-------------|
| 350 | fs-rollback | Captures/reverts file side effects (optional) |
| 420 | semantic-retry | Diagnoses failures, rewrites prompts |
| 425 | guided-retry | Injects backtrack constraints into model calls |

## Deployment Presets

### `light`

- semantic-retry: maxRetries = 1
- No guided-retry constraint injection
- No fs-rollback

### `standard` (default)

- semantic-retry: maxRetries = 3
- guided-retry: enabled
- fs-rollback: enabled if user provides config (store + chainId + backend)

### `aggressive`

- semantic-retry: maxRetries = 5
- guided-retry: enabled
- fs-rollback: enabled if user provides config

**Note:** fs-rollback requires I/O backends (`store`, `chainId`, `backend`) that
only the user can provide. Presets signal intent; the user supplies the backends.

## Config Resolution

The 3-layer merge works as follows:

1. **Defaults**: empty config
2. **Preset**: `RETRY_STACK_PRESET_SPECS[preset]` fills in unset fields
3. **User overrides**: explicit config fields always win

## Return Shape

```typescript
interface RetryStackBundle {
  readonly middleware: readonly KoiMiddleware[];
  readonly semanticRetry: SemanticRetryHandle;
  readonly guidedRetry: GuidedRetryHandle;
  readonly fsRollback: FsRollbackHandle | undefined;
  readonly config: ResolvedRetryStackMeta;
  readonly reset: () => void;
}

interface ResolvedRetryStackMeta {
  readonly preset: RetryStackPreset;
  readonly middlewareCount: number;
  readonly fsRollbackEnabled: boolean;
}
```

## Architecture

```
@koi/retry-stack (L3)
  ├── types.ts              — RetryStackConfig, presets, bundle types
  ├── presets.ts             — RETRY_STACK_PRESET_SPECS (frozen)
  ├── config-resolution.ts   — 3-layer merge
  ├── retry-stack.ts         — createRetryStack() factory
  └── index.ts               — public API surface
```

Dependencies:
- L0: `@koi/core` (types)
- L2: `@koi/middleware-semantic-retry`, `@koi/middleware-guided-retry`, `@koi/middleware-fs-rollback`
