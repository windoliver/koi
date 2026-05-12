# Quiet hours — design (Phase 4 sub-1)

**Issue:** #1301 Part 1 Phase 4 (quiet hours only)
**Date:** 2026-05-10
**Package:** `@koi/proactive`
**Builds on:** Phase 3 `createProactiveDelivery` (PR #2175)

## Purpose

Suppress `normal`-priority proactive deliveries during a configured
quiet window in the user's timezone. Higher priorities (`high`,
`urgent`) always pass; `low` retains Phase 3 routing. Multi-channel
fallback for `high` and inbox routing for `low` remain in Phase 4
follow-ups.

## Surface

```typescript
export interface DeliveryPreferences {
  readonly preferredChannel?: string;
  readonly maxNotificationsPerHour?: number;
  // Phase 4: quiet hours
  readonly quietHoursStart?: number;   // 0-23 inclusive
  readonly quietHoursEnd?: number;     // 0-23 inclusive, exclusive endpoint
  readonly timezone?: string;          // IANA tz, default "UTC"
}

export type DeliveryResult =
  | { readonly ok: true; readonly delivered: readonly string[] }
  | {
      readonly ok: false;
      readonly reason:
        | "no_channels"
        | "rate_limited"
        | "all_failed"
        | "quiet_hours"; // NEW
      readonly failures?: readonly DeliveryFailure[];
    };
```

`createProactiveDelivery` signature unchanged.

## Window semantics

Window is `[start, end)` in given timezone, with `start === end`
banned (would mean either always-quiet or never-quiet — caller bug).

| Case | Quiet when |
|---|---|
| `start < end` (e.g. 9, 17) | `start <= h < end` |
| `start > end` (cross-midnight, e.g. 22, 6) | `h >= start || h < end` |

Hour resolved via:

```typescript
new Intl.DateTimeFormat("en-US", {
  timeZone: preferences.timezone ?? "UTC",
  hour: "2-digit",
  hourCycle: "h23",
}).format(new Date(now()))
```

Then parsed to integer 0-23.

## Priority interaction

| Priority | In quiet window | Out of quiet window |
|---|---|---|
| `urgent` | fan-out (Phase 3) | fan-out (Phase 3) |
| `high` | preferred / fallback (Phase 3) | preferred / fallback (Phase 3) |
| `normal` | **return `{ok:false, reason:"quiet_hours"}`** | preferred (Phase 3) |
| `low` | preferred (Phase 3) | preferred (Phase 3) |

Only `normal` is gated by quiet hours in this slice.

## Gate ordering inside `send`

For non-urgent priorities:

1. Quiet-hours gate (normal only) — if suppressed, return early. **Does not consume rate-limit window.**
2. Rate-limit gate — `reserveSlot` as before.
3. Channel selection + send.

This ordering preserves Phase 3 invariants:
- Failed deliveries refund slot (unchanged).
- Quiet-suppressed sends never reserve a slot in the first place.

## Validation

At factory construction (`createProactiveDelivery` body, before
returning the closure), throw `Error` if:

- Exactly one of `quietHoursStart` / `quietHoursEnd` is set (must be both or neither).
- Either is non-integer or not in `[0, 23]`.
- `quietHoursStart === quietHoursEnd`.
- `timezone` is set but `Intl.DateTimeFormat` rejects it (try/catch one format call at construction).

Validation errors are caller bugs, not runtime conditions, so they
throw rather than returning a `Result`.

## Tests (6 deterministic, in-memory)

| # | Test |
|---|---|
| 1 | Normal during quiet window → `{ok:false, reason:"quiet_hours"}`, adapter NOT called |
| 2 | Normal outside quiet window → delivered as in Phase 3 |
| 3 | High during quiet window → delivered (bypasses quiet) |
| 4 | Urgent during quiet window → fan-out as in Phase 3 |
| 5 | Cross-midnight window (22, 6): hours 23 + 0 + 5 are quiet; hours 6 + 21 are not |
| 6 | Quiet-suppressed normal does not consume rate-limit slot (subsequent normal outside window passes at cap=1) |

Plus 1 validation test: factory throws when only `quietHoursStart` set.

## Non-goals

- Per-channel quiet hours
- Daily-rotating windows (different per weekday)
- Exception lists (sender/topic-based bypass)
- Queueing suppressed sends — caller decides
- Multi-channel fallback for `high` — separate Phase 4 PR
- Inbox routing for `low` — separate Phase 4 PR (no Koi inbox primitive yet)

## Files

| File | Δ | Responsibility |
|---|---|---|
| `packages/lib/proactive/src/proactive-delivery.ts` | ~+50 | Add quiet-hours gate + validation |
| `packages/lib/proactive/src/proactive-delivery.test.ts` | ~+150 | 7 new tests |
| `docs/L2/proactive.md` | +20 | Quiet-hours subsection |
| `docs/L3/runtime.md` | +1 | Changelog |

## Layer compliance

L2 — no new imports beyond Phase 3. `Intl.DateTimeFormat` is platform-builtin.
