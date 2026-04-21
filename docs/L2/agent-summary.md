# @koi/agent-summary

Structured session summaries: goal, status, actions, outcomes, errors, learnings. Pure library. Consumer injects `modelCall`.

## When to use

- Checkpoint UX ("what would I lose on rewind?")
- Cost dashboards ("what did this spend accomplish?")
- Audit reports
- Reflection nudges

## Installation

This is an internal workspace package. Add to consumer `package.json`:

```json
"dependencies": { "@koi/agent-summary": "workspace:*" }
```

## Quick start

```ts
import { createAgentSummary } from "@koi/agent-summary";

const summary = createAgentSummary({
  transcript,         // SessionTranscript from @koi/core
  modelCall,          // (req) => Promise<{ text: string }>
});

const r = await summary.summarizeSession(sessionId, {
  granularity: "medium",
  modelHint: "cheap",
});

if (!r.ok) {
  console.error("summary failed:", r.error.code, r.error.context);
  return;
}

// r.value is SummaryOk — callers MUST discriminate on kind.
switch (r.value.kind) {
  case "clean":
    display(r.value.summary);
    break;
  case "degraded":
    displayDegraded(r.value.partial, r.value.skipped, r.value.droppedTailTurns);
    break;
  case "compacted":
    displayDerived(r.value.derived, r.value.compactionEntryCount);
    break;
}
```

## Three-variant output

All success returns `Result<SummaryOk, KoiError>` where `SummaryOk` has three
shapes. **You cannot read the body without narrowing** — `.summary`, `.partial`,
and `.derived` live on different variants by design so audit consumers cannot
silently ship degraded or compacted output as authoritative.

Precedence when multiple integrity states apply: `compacted > degraded > clean`.

## Granularity

`granularity` tunes token budget and prompt terseness. Schema is identical across
granularities — density differs.

| Granularity | Default `maxTokens` |
|---|---:|
| `high` | 300 |
| `medium` | 1200 |
| `detailed` | 4000 |

## Integrity: crash-artifact tail strategy (`summarizeSession` only)

When a session transcript has a `crash_artifact` skip (trailing partial write),
choose your tradeoff:

- `"reject"` (default) — fail closed, repair the transcript.
- `"drop_last_turn"` — defensively drop the last surviving turn (honest data loss
  if the partial write began a new turn).
- `"include_all"` — keep every surviving turn including the possibly-truncated one.

Mid-file `parse_error` is always rejected regardless of strategy.

## Compaction (`summarizeSession` only)

`summarizeRange` rejects compacted transcripts with `error.code === "VALIDATION"`
and `error.context.reason === "range-compacted"`.
`summarizeSession` accepts them with `allowCompacted: true`; the result comes
back as `kind: "compacted"` with a `derived` body, and `meta.rangeOrigin ===
"post-compaction"` so consumers don't persist synthetic turn bounds as original
session turns.

Without `allowCompacted: true`, `summarizeSession` fails with
`error.code === "VALIDATION"` and `error.context.reason === "session-compacted"`.

## Error signaling contract

`@koi/agent-summary` uses shared `KoiError.code` values from `@koi/core`
(`VALIDATION`, `NOT_FOUND`, `EXTERNAL`) and carries summary-specific routing
detail in `error.context.reason`.

Timeout behavior is configurable with `inFlightTimeoutMs` on `AgentSummaryDeps`
(default `30_000`). The timeout is applied to dependency calls (`cache.get`,
`modelCall`, `cache.set`) so stalled I/O returns a bounded failure instead of
hanging the request forever.

Timeout failures from model execution are reported as `error.code === "EXTERNAL"`
with `error.context.reason === "model-error"` and `error.context.timeout ===
true`. Parse failures remain non-timeout `EXTERNAL` errors with
`error.context.reason === "parse-error"` and are not automatically retryable.

## Cache

Pluggable. Default is in-memory. Inject `SummaryCache` for persistent backends.
Cache is treated as UNTRUSTED: every hit is validated against the current
request (identity, integrity invariants, Zod shape) before surfacing.

## Full API

See `packages/lib/agent-summary/src/types.ts` for public types and
`packages/lib/agent-summary/src/__tests__/` for executable integrity and edge-case behavior.
