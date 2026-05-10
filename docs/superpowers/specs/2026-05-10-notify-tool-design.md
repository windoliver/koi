# `notify` tool — design

**Issue:** #1195 (v2 Phase 3a `@koi/proactive`)
**Date:** 2026-05-10
**Package:** `@koi/proactive`

## Purpose

Give an agent a thin LLM-callable surface to send a one-shot text message to
itself out via any `ChannelAdapter` attached to the agent. Fire-and-forget,
no state, no retries.

## Surface

```typescript
notify({
  channel: string,        // channel name (matches "channel:<name>" component key)
  text: string,           // text content (single TextBlock)
  thread_id?: string,     // optional thread continuity (forwarded to OutboundMessage.threadId)
  metadata?: JsonObject,  // optional adapter-specific hints (forwarded to OutboundMessage.metadata)
}) =>
  | { ok: true }
  | { ok: false, error: string, available_channels?: readonly string[] }
```

## Wiring

Mirrors the `sleep`/`schedule_cron` pattern:

- `createNotifyTool({ resolveChannel })` — pure factory taking a `(name) => ChannelAdapter | undefined` lookup.
- `createNotifyToolProvider()` — `ComponentProvider`. At `attach()`:
  1. Snapshot `agent.components()` keys matching `^channel:` into `Map<name, ChannelAdapter>`.
  2. If empty → return `skipped: [{ name: "notify", reason: "no ChannelAdapter components attached" }]`.
  3. Build the tool with a closure-bound lookup over the snapshot.

The snapshot is taken at attach time. Channels added or removed after attach
are not reflected by `notify` until reattach. This mirrors the existing
proactive-tools snapshot semantics for `SchedulerComponent` and is documented.

## Tool body (high level)

1. Validate args with zod (channel non-empty, text non-empty, thread_id non-empty if present).
2. Look up adapter. Miss → `{ ok: false, error: "unknown channel: <name>", available_channels: [sorted names] }`.
3. Build `OutboundMessage`:
   ```typescript
   {
     content: [{ kind: "text", text }],
     ...(thread_id !== undefined ? { threadId: thread_id } : {}),
     ...(metadata !== undefined ? { metadata } : {}),
   }
   ```
4. `await adapter.send(msg)`. Catch → `{ ok: false, error: format(err) }` (no rethrow).
5. Return `{ ok: true }`.

No state. No idempotency. No retries. The tool is a thin pass-through.

## Out of scope (YAGNI)

- Multi-channel broadcast (`channel: string[]`).
- Rich content blocks (file, image, button, custom).
- Scheduled notify (`notify_at`) — would belong as a separate proactive tool combining scheduler + notify.
- Cross-restart dedup — channel adapters own this via their own idempotency store.
- Per-channel capability gating — adapter rejects what it doesn't support; `notify` does not pre-check.

## Tests

Unit (`notify-tool.test.ts`, ~150 lines):

- Unknown channel returns `ok: false` with sorted `available_channels`.
- Successful send forwards exact `OutboundMessage` shape (content, threadId, metadata).
- Adapter `send` rejection becomes `{ ok: false, error }` — never throws to caller.
- Empty channel name / empty text rejected at zod boundary.
- `thread_id` and `metadata` omitted from outbound when not provided (no `undefined` keys).

Provider (added to `provider.test.ts`):

- No `channel:*` components → `skipped` entry, tool not installed.
- Multiple `channel:*` components → all available; lookup hits both.
- Channel added after attach → not visible (snapshot semantics documented).

## Files

- `packages/lib/proactive/src/notify-tool.ts` (~80 lines, new)
- `packages/lib/proactive/src/notify-tool.test.ts` (~150 lines, new)
- `packages/lib/proactive/src/create-proactive-tools.ts` — add `"notify"` to `PROACTIVE_TOOL_NAMES`, wire into `assembleProactiveTools`
- `packages/lib/proactive/src/provider.ts` — enumerate `channel:*` components, pass `resolveChannel` into config
- `packages/lib/proactive/src/types.ts` — extend `ProactiveToolsConfig` with optional `resolveChannel`
- `packages/lib/proactive/src/index.ts` — export new factories/types
- `docs/L2/proactive.md` — add `notify` row to Tools table + behavior section

## Layer compliance

- Imports only `@koi/core` (L0) and `@koi/tools-core` (L0u) — no peer L2 deps.
- No vendor types, no I/O, no state. Adapter `send` is the only side effect.
