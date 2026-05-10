# Inbox routing for `low` priority — design (Phase 4 sub-3)

**Issue:** #1301 Part 1 Phase 4 (inbox for low)
**Date:** 2026-05-10
**Package:** `@koi/proactive`
**Builds on:** Phase 3 + quiet hours + high fallback

## Purpose

Route `low`-priority proactive notifications to a pluggable, in-process
**inbox sink** instead of waking a channel. The agent picks them up on
its next session via whatever surface the host wires the sink into
(memory, scratchpad, persistent queue, etc.). Closes the third gap in
Block-style proactive delivery: low-importance composition output
should not interrupt the user.

If no inbox is configured, `low` retains Phase-3 single-attempt channel
routing — backwards compatible.

## Surface

```typescript
export interface InboxEnvelope {
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
  readonly enqueuedAt: number; // ms epoch from injected `now()`
}

export interface InboxSink {
  /** Enqueue a low-priority notification. Throwing is caught and wrapped. */
  readonly enqueue: (envelope: InboxEnvelope) => void | Promise<void>;
}

export interface ProactiveDeliveryConfig {
  readonly channels: ReadonlyMap<string, ChannelAdapter>;
  readonly preferences?: DeliveryPreferences;
  readonly now?: () => number;
  /** Optional inbox sink. When set, `low` priority writes here. */
  readonly inbox?: InboxSink; // NEW
}

export type DeliveryResult =
  | { readonly ok: true; readonly delivered: readonly string[] }
  | {
      readonly ok: false;
      readonly reason:
        | "no_channels"
        | "rate_limited"
        | "all_failed"
        | "quiet_hours";
      readonly failures?: readonly DeliveryFailure[];
    };
```

The success shape for inbox delivery reuses the existing
`{ ok: true, delivered: [...] }` variant with a special channel name:
`delivered: ["inbox"]`. No new union variant — keeps `DeliveryResult`
small.

## Routing matrix (after this slice)

| Priority | Routing |
|---|---|
| `urgent` | parallel fan-out (Phase 3) |
| `high` | preferred → fallback (Phase 4 sub-2) |
| `normal` | preferred / first; quiet-hours gated; single attempt |
| `low` | **`inbox.enqueue` if `inbox` configured; else preferred / first single attempt** |

Quiet hours do **not** gate `low` — inbox delivery is silent by design.

## Inbox semantics

- `inbox.enqueue` is called with the built envelope. Result on success:
  `{ ok: true, delivered: ["inbox"] }`.
- Caller's `enqueue` may be sync or async. Result is awaited.
- If `enqueue` throws / rejects, return:
  `{ ok: false, reason: "all_failed", failures: [{ channel: "inbox", error }] }`.
  No fallback to channels — caller chose inbox routing for `low`; failing
  silently to a channel would defeat the purpose.
- `enqueuedAt` is set from injected `now()` for deterministic tests.

## Rate limit

Inbox-routed `low` sends do **not** consume the rate-limit window. The
window models user-facing delivery; an inbox write is not user-facing
until the agent reads it.

If `low` falls through to channel routing (no inbox configured), it
follows the Phase-3 normal/low rate-limit path (consumes 1 slot;
refunded on failure).

## Channel-map empty + inbox configured

Special case: `channels.size === 0` but `inbox` is set and priority is
`low` → inbox still runs. The `no_channels` early-return only applies
when the request needs a channel.

For other priorities (`urgent`, `high`, `normal`), empty channels still
returns `no_channels` even if inbox is configured.

## Tests (8 deterministic, in-memory)

| # | Test |
|---|---|
| 1 | `low` with inbox configured → `enqueue` called with content/threadId/metadata/enqueuedAt; result `{ok:true, delivered:["inbox"]}`; channel adapter NOT called |
| 2 | `low` with no inbox configured → falls through to Phase-3 channel routing (preferred or first), single attempt |
| 3 | `low` inbox failure (sync throw) → `{ok:false, reason:"all_failed", failures:[{channel:"inbox", error:"..."}]}`; channel adapter NOT called |
| 4 | `low` inbox failure (async reject) → same as test 3 |
| 5 | `low` with inbox + empty channels map → still ok via inbox (no `no_channels`) |
| 6 | `low` inbox routing does NOT consume rate-limit slot (cap=1; two low inbox sends; one normal send still passes) |
| 7 | `normal` with inbox configured → still routes to channel (inbox is `low`-only) |
| 8 | `enqueuedAt` uses injected `now()` value verbatim |

## Non-goals

- Persistent / cross-process inbox — host responsibility (sink can wrap a queue/db)
- Multiple inboxes per agent — caller composes if needed
- Inbox dequeue API — read-side belongs to the host
- Inbox routing for `normal` quiet-hours-suppressed sends — they continue to return `quiet_hours` (caller can re-route to inbox manually if desired)

## Files

| File | Δ | Responsibility |
|---|---|---|
| `packages/lib/proactive/src/inbox-sink.ts` (new) | ~25 | `InboxSink` + `InboxEnvelope` types |
| `packages/lib/proactive/src/proactive-delivery.ts` | ~+30 | `low` branch + `inbox` config field |
| `packages/lib/proactive/src/proactive-delivery.test.ts` | ~+250 | 8 new tests |
| `packages/lib/proactive/src/index.ts` | +2 | Export `InboxSink`, `InboxEnvelope` |
| `docs/L2/proactive.md` | +20 | Inbox routing subsection + table update |
| `docs/L3/runtime.md` | +1 | Changelog |

## Layer compliance

L2 — only `@koi/core` imports. `InboxSink` lives in this package; no
new L0 contract until a second consumer appears (Rule of Three).
