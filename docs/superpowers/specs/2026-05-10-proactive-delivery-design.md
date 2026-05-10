# Proactive delivery — design (Phase 3 basic)

**Issue:** #1301 Part 1 (basic preferred channel + rate limit)
**Date:** 2026-05-10
**Package:** `@koi/proactive`

## Purpose

Route composition outcomes (and any other proactive notification) to the
user via existing `ChannelAdapter`s without waiting for the user to ask.
Phase 3 scope: priority routing + per-hour rate limit. Phase 4 (quiet
hours, multi-channel fallback, inbox routing for `low`) tracked
separately.

## Surface

```typescript
export type DeliveryPriority = "low" | "normal" | "high" | "urgent";

export interface ProactiveNotification {
  readonly priority: DeliveryPriority;
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
}

export interface DeliveryPreferences {
  /** Channel name from `channels` map. If absent, the first channel by Map insertion order is used. */
  readonly preferredChannel?: string;
  /** Sliding 1-hour cap. Default: unlimited. `urgent` always bypasses. */
  readonly maxNotificationsPerHour?: number;
}

export interface ProactiveDeliveryConfig {
  readonly channels: ReadonlyMap<string, ChannelAdapter>;
  readonly preferences?: DeliveryPreferences;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export type DeliveryFailure = { readonly channel: string; readonly error: string };

export type DeliveryResult =
  | { readonly ok: true; readonly delivered: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "no_channels" | "rate_limited" | "all_failed";
      readonly failures?: readonly DeliveryFailure[];
    };

export interface ProactiveDelivery {
  readonly send: (notification: ProactiveNotification) => Promise<DeliveryResult>;
}

export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery;
```

## Routing

| Priority | Routing | Rate-limit subject |
|---|---|---|
| `urgent` | Fan out to ALL channels in parallel. Success if ≥1 delivered. Returns the names of channels that delivered. | No |
| `high`, `normal`, `low` | `preferredChannel` if configured; else first channel by Map insertion order. | Yes |

Phase 4 will split `high` (multi-channel fallback), `normal` (preferred + quiet hours), and `low` (inbox only). For Phase 3 they all behave identically.

## Rate limit

- Sliding 1-hour window keyed by `now()` timestamps of *successful* deliveries.
- On each `send`:
  1. Drop window entries older than `now() - 3_600_000` ms.
  2. If `priority !== "urgent"` and `window.length >= maxNotificationsPerHour`, return `{ok:false, reason:"rate_limited"}`.
- Urgent deliveries do not increment the window — they neither consume capacity nor starve normal sends.
- A failed delivery does NOT consume window capacity.

## Errors

- Empty `channels` map → `{ok:false, reason:"no_channels"}`.
- Adapter `send` rejection on a single-channel path → `{ok:false, reason:"all_failed", failures:[{channel, error}]}`.
- Urgent fan-out: per-channel `send` rejections collected into `failures`. If at least one channel succeeds, result is `{ok:true, delivered:[...successes]}`. If every channel fails, `{ok:false, reason:"all_failed", failures:[...all]}`.
- Adapter exceptions never propagate to the caller — always wrapped into `failures[]`.

## Concurrency

The window is a single shared array; rate-limit decisions are made synchronously before any `await`, so two concurrent `send()` calls with `maxNotificationsPerHour=1` cannot both pass the gate (the second observes the first's reservation slot). Urgent sends do not reserve a slot.

## Non-goals

- Quiet hours / timezone gating — Phase 4
- Multi-channel fallback for `high` — Phase 4
- Inbox routing for `low` — Phase 4 (no Koi inbox primitive yet)
- Cross-process rate-limit persistence — in-memory only; resets on restart
- Per-channel rate limits — caller composes if needed

## Tests (14 deterministic, all in-memory)

| # | Test |
|---|------|
| 1 | `no_channels` when channels map empty |
| 2 | High priority routes to `preferredChannel` |
| 3 | High priority falls back to first channel when no preferred |
| 4 | Normal/low behave identically to high in Phase 3 |
| 5 | Urgent fan-out — both channels receive |
| 6 | Urgent partial fail — one fails, one succeeds → `ok:true, delivered:[winner]` |
| 7 | Urgent total fail → `ok:false, reason:"all_failed"` with both in `failures` |
| 8 | Rate limit blocks `normal` after cap |
| 9 | Window slides — old entries drop, new send goes through |
| 10 | Urgent bypasses rate limit (no `rate_limited` even at cap) |
| 11 | Urgent does not consume window capacity |
| 12 | Adapter throw on single channel → `all_failed`, no propagation |
| 13 | `threadId` and `metadata` forwarded to `OutboundMessage` verbatim |
| 14 | Two concurrent sends at cap=1 → exactly one passes |

## Files

| File | Lines (est.) | Responsibility |
|------|--------------|----------------|
| `packages/lib/proactive/src/proactive-delivery.ts` (new) | ~180 | Factory + routing + rate-limit window |
| `packages/lib/proactive/src/proactive-delivery.test.ts` (new) | ~320 | All 14 tests |
| `packages/lib/proactive/src/index.ts` (modify) | +6 | Public exports |
| `docs/L2/proactive.md` (modify) | +30 | Delivery section |
| `docs/L3/runtime.md` (modify) | +1 | Changelog |

## Layer compliance

L2 — imports only `@koi/core` (L0) for `ChannelAdapter`/`ContentBlock`/`OutboundMessage`/`JsonObject`. No peer L2 deps.
