# @koi/tool-stack — Tool Execution Lifecycle Bundle

Layer 3 meta-package that composes up to 7 middleware into a single
`createToolStack()` call, covering the full tool execution lifecycle:
auditing, limits, recovery, dedup, sandbox, selection, and failover.

## What This Enables

**One-call tool lifecycle composition.** Instead of manually importing,
configuring, and ordering 7 separate middleware packages, callers get:

- **Selective inclusion** — each middleware slot is optional; omit the key to skip
- **Simplified sandbox config** — provide `defaultTimeoutMs` and `skipToolIds`
  instead of constructing `tierFor`/`profileFor` closures
- **Automatic priority ordering** — middleware sorted by ascending priority,
  resilient to config key insertion order
- **Zero new logic** — pure L3 orchestration delegating entirely to L2 packages

### Before (manual composition)

```typescript
import { createToolAuditMiddleware } from "@koi/middleware-tool-audit";
import { createToolCallLimitMiddleware } from "@koi/middleware-call-limits";
import { createToolRecoveryMiddleware } from "@koi/middleware-tool-recovery";
import { createCallDedupMiddleware } from "@koi/middleware-call-dedup";
import { createSandboxMiddleware } from "@koi/middleware-sandbox";
import { createToolSelectorMiddleware } from "@koi/middleware-tool-selector";
import { createDegenerateMiddleware } from "@koi/middleware-degenerate";

const middleware = [
  createToolAuditMiddleware({ onAuditResult: console.log }),
  createToolCallLimitMiddleware({ globalLimit: 500 }),
  createToolRecoveryMiddleware({}),
  createCallDedupMiddleware({}),
  createSandboxMiddleware({
    tierFor: (id) => skipIds.has(id) ? "promoted" : "sandbox",
    profileFor: (tier) => tier === "promoted"
      ? { tier, filesystem: {}, network: { allow: true }, resources: {} }
      : { tier, filesystem: {}, network: { allow: false }, resources: { timeoutMs: 15_000 } },
  }),
  createToolSelectorMiddleware({ selectTools: mySelector }),
  createDegenerateMiddleware({ forgeStore, createToolExecutor, capabilityConfigs }).middleware,
];
```

### After (tool-stack)

```typescript
import { createToolStack } from "@koi/tool-stack";

const { middleware } = createToolStack({
  audit: { onAuditResult: console.log },
  limits: { globalLimit: 500 },
  recovery: {},
  dedup: {},
  sandbox: { defaultTimeoutMs: 15_000, skipToolIds: ["memory_recall"] },
  selector: { selectTools: mySelector },
  degenerate: { forgeStore, createToolExecutor, capabilityConfigs },
});

const runtime = await createKoi({ manifest, adapter, middleware });
```

## Quick Start

```typescript
import { createToolStack } from "@koi/tool-stack";
import { createKoi } from "@koi/engine";

// Minimal — just sandbox with defaults (30s timeout)
const { middleware } = createToolStack({ sandbox: {} });

// Typical — audit + limits + sandbox + dedup
const stack = createToolStack({
  audit: {},
  limits: { globalLimit: 500 },
  sandbox: { defaultTimeoutMs: 15_000, skipToolIds: ["memory_recall"] },
  dedup: { ttlMs: 60_000 },
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: stack.middleware,
});
```

## Middleware Priority Order

| Priority | Middleware | Description |
|----------|-----------|-------------|
| 100 | tool-audit | Track per-tool usage, latency, success/failure rates |
| 175 | call-limits | Enforce per-session/per-tool call count caps |
| 180 | tool-recovery | Recover structured tool calls from text patterns |
| 185 | call-dedup | Cache identical tool call results |
| 200 | sandbox | Enforce timeout + output truncation |
| 420 | tool-selector | Filter tools visible to the model |
| 460 | degenerate | Variant selection + failover |

## Sandbox Simplification

The underlying `SandboxMiddlewareConfig` requires two closures: `tierFor` (tool
ID to trust tier) and `profileFor` (trust tier to sandbox profile). For most use
cases, users just need timeout + skip list.

`ToolStackSandboxConfig` generates those closures from flat values:

| Simplified Config | What It Controls |
|-------------------|-----------------|
| `defaultTimeoutMs` | Timeout for all sandboxed tools (default: 30s) |
| `skipToolIds` | Tools that bypass sandboxing entirely ("promoted" tier) |
| `perToolTimeouts` | Per-tool timeout overrides |
| `outputLimitBytes` | Max output before truncation (default: 1 MB) |
| `timeoutGraceMs` | Grace period added to timeout (default: 5s) |
| `tierFor` | Escape hatch: override default tier resolution |

When both `skipToolIds` and `tierFor` are provided, `skipToolIds` takes
precedence — listed tools are always promoted, then `tierFor` handles the rest.

## Return Shape

```typescript
interface ToolStackBundle {
  readonly middleware: readonly KoiMiddleware[];
}
```

## Architecture

```
@koi/tool-stack (L3)
  ├── types.ts              — ToolStackConfig, ToolStackSandboxConfig, ToolStackBundle
  ├── create-tool-stack.ts  — createToolStack() factory + sandbox mapping
  └── index.ts              — public API surface
```

Dependencies:
- L0: `@koi/core` (types only)
- L2: 7 middleware packages (tool-audit, call-limits, tool-recovery, call-dedup,
  sandbox, tool-selector, degenerate)
