# Multi-channel fallback for `high` — design (Phase 4 sub-2)

**Issue:** #1301 Part 1 Phase 4 (high fallback)
**Date:** 2026-05-10
**Package:** `@koi/proactive`
**Builds on:** Phase 3 (PR #2175) + quiet hours (PR #2176)

## Purpose

Make `high`-priority delivery durable to a single channel failing.
Today (Phase 3) `high` calls `preferredChannel` once; if that adapter
throws, the send returns `all_failed`. This slice adds sequential
fallback over the remaining channels in Map insertion order.

`urgent` keeps its parallel fan-out semantics. `normal` and `low`
retain Phase-3 single-channel routing.

## Routing matrix (after this slice)

| Priority | Routing |
|---|---|
| `urgent` | parallel fan-out (Phase 3, unchanged) |
| `high` | **preferredChannel first; on failure, iterate remaining channels in Map insertion order; return on first success** |
| `normal` | preferred or first by insertion order; quiet-hours gated; single attempt (Phase 3 + Phase 4 sub-1) |
| `low` | preferred or first by insertion order; single attempt (Phase 3) |

## Algorithm for `high`

1. Build the channel attempt order:
   - If `preferredChannel` is configured AND present in `channels`, attempt it first.
   - Then attempt every other channel in Map insertion order, skipping the one already attempted.
   - If `preferredChannel` is configured but missing from `channels`, fall through to insertion order from the start.
2. Reserve 1 rate-limit slot upfront (same as Phase 3 normal path).
3. For each attempt sequentially:
   - `await adapter.send(msg)`. On success → return `{ ok: true, delivered: [name] }`.
   - On failure → record `{ channel, error }` in a local `failures` array, continue.
4. If every attempt failed → refund the slot, return `{ ok: false, reason: "all_failed", failures }`.

Sequential (not parallel) — first success wins, no wasted sends, simpler
ordering for tests.

## Rate-limit semantics

- One slot consumed per `send()` call, regardless of how many adapter
  attempts the fallback walked through.
- Slot refunded if every attempt fails (preserves Phase 3 invariant
  "failed delivery does not consume window capacity").
- Slot reserved synchronously before the first `await` (preserves Phase 3
  concurrent-cap semantics).

## Quiet-hours interaction

`high` continues to bypass quiet hours (Phase 4 sub-1 invariant). Only
`normal` is quiet-gated.

## Surface

No public type changes. `DeliveryResult` shape unchanged. `failures`
array on `all_failed` now may contain multiple entries for `high`
priority (Phase 3 already supported multi-entry for `urgent`).

## Tests (7 deterministic, in-memory)

| # | Test |
|---|---|
| 1 | High: preferred succeeds → only preferred called, `delivered: [preferred]` |
| 2 | High: preferred fails, second succeeds → both called in order, `delivered: [second]` |
| 3 | High: all channels fail → `all_failed` with failures in attempt order (preferred first) |
| 4 | High: no preferred configured → walks insertion order from start; first fails, second succeeds |
| 5 | High: single channel that fails → `all_failed`, single failure entry (regression of Phase 3) |
| 6 | High: preferred missing from channels map → walks insertion order from start (no error) |
| 7 | High fallback consumes exactly 1 rate-limit slot regardless of attempts (cap=1; one fallback send burns the bucket; second send blocked) |

Plus 1 invariant test:
- 8: Normal priority still does NOT fall back — preferred fails → `all_failed` after one attempt, second channel never called.

## Non-goals

- Backoff between attempts (try them as fast as possible, in-memory)
- Per-channel timeouts (caller wraps adapter if needed)
- Concurrent attempts (sequential is intentional)
- Fallback for `normal` or `low` (out of scope; could be added later if a real use case appears — not speculative)

## Files

| File | Δ | Responsibility |
|---|---|---|
| `packages/lib/proactive/src/proactive-delivery.ts` | ~+40 | High-priority fallback path |
| `packages/lib/proactive/src/proactive-delivery.test.ts` | ~+200 | 8 new tests |
| `docs/L2/proactive.md` | +20 | Routing-table update + "High fallback" subsection |
| `docs/L3/runtime.md` | +1 | Changelog |

## Layer compliance

L2 — no new imports. Only @koi/core.
