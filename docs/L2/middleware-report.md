# @koi/middleware-report

Activity reporting middleware that tracks all model/tool calls and produces
structured `RunReport` at session end (Layer 2).

## Why

Agents need post-run summaries for audit, debugging, and cost tracking. This
middleware observes every model and tool call, accumulates metrics in a bounded
ring buffer, and generates a structured report at session end.

## Architecture

Observe-phase middleware (priority 275) with six hooks.

```
Session start → init accumulator
Model call    → record action (duration, tokens, success/failure)
Tool call     → record action, record issue on failure
After turn    → fire onProgress callback
Session end   → assemble RunReport, fire onReport callback
```

**Ring buffer:** Actions stored in O(1) circular buffer (default 500 max).
Overflow sets `truncated` flag but `totalActions` counter is always accurate.

**ReportHandle:** Factory returns a handle with `middleware` + query methods
(`getReport`, `getProgress`) so callers can poll state without callbacks.

## API

```typescript
import { createReportMiddleware } from "@koi/middleware-report";

const handle = createReportMiddleware({
  objective: "Refactor auth module",
  maxActions: 500,
  onProgress: (snap) => console.log(`Turn ${snap.turnIndex}: ${snap.totalActions} actions`),
  onReport: (report, markdown) => fs.writeFileSync("report.md", markdown),
});

// Use handle.middleware in middleware stack
// Query: handle.getProgress(sessionId), handle.getReport(sessionId)
```

### ReportMiddlewareConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `objective` | `string` | — | Agent's goal, included in report |
| `maxActions` | `number` | `500` | Ring buffer capacity |
| `formatter` | `(report) => string` | `mapReportToMarkdown` | Output formatter |
| `onReport` | `(report, formatted) => void` | — | Push at session end |
| `onProgress` | `(snapshot) => void` | — | Push after each turn |

### ReportHandle

| Property | Type | Description |
|----------|------|-------------|
| `middleware` | `KoiMiddleware` | Register in middleware stack |
| `getReport(sessionId)` | `RunReport \| undefined` | Pull after session end |
| `getProgress(sessionId)` | `ProgressSnapshot` | Pull live during run |

### ProgressSnapshot

```typescript
interface ProgressSnapshot {
  readonly turnIndex: number;
  readonly totalActions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly issueCount: number;
  readonly elapsedMs: number;
  readonly truncated: boolean;
}
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Model call throws | Re-thrown. Issue recorded as `critical`. Action marked `success=false` |
| Tool call throws | Re-thrown. Issue recorded as `warning`. Action marked `success=false` |
| `onReport` throws | Swallowed. Report still available via `getReport()` |
| `onProgress` throws | Swallowed. Turn processing continues |
| Action buffer overflow | FIFO ring: oldest dropped, `truncated=true`, `totalActions` accurate |

## Layer Compliance

- Depends on: `@koi/core` (L0), `@koi/errors` (L0u)
- No L1 or peer L2 imports
- All interface properties `readonly`
- `bun run check:layers` passes
