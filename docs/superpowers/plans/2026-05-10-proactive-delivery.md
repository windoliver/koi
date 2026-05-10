# Proactive delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createProactiveDelivery` to `@koi/proactive` — a thin priority-routing + rate-limited dispatcher over existing `ChannelAdapter`s.

**Architecture:** Pure factory returning `{ send }`. Sliding 1-hour rate-limit window keyed by `now()` timestamps. Urgent priority fans out to all channels in parallel and bypasses rate limit; high/normal/low route to `preferredChannel` (or first channel by Map insertion order).

**Tech Stack:** TypeScript 6 strict, Bun 1.3, `bun:test`, no deps beyond `@koi/core`.

**Spec:** `docs/superpowers/specs/2026-05-10-proactive-delivery-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/lib/proactive/src/proactive-delivery.ts` (new) | Factory + types + routing + rate-limit window |
| `packages/lib/proactive/src/proactive-delivery.test.ts` (new) | All 14 unit tests |
| `packages/lib/proactive/src/index.ts` (modify) | Public exports |
| `docs/L2/proactive.md` (modify) | Delivery section |
| `docs/L3/runtime.md` (modify) | Changelog entry |

---

## Task 1: Skeleton + first failing test (no_channels)

**Files:**
- Create: `packages/lib/proactive/src/proactive-delivery.ts`
- Create: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lib/proactive/src/proactive-delivery.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, OutboundMessage } from "@koi/core";
import { createProactiveDelivery } from "./proactive-delivery.js";

function stubAdapter(name: string, send?: (m: OutboundMessage) => Promise<void>): ChannelAdapter {
  return {
    name,
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: send ?? (async () => {}),
    onMessage: () => () => {},
  };
}

describe("createProactiveDelivery", () => {
  test("returns no_channels when channel map is empty", async () => {
    const delivery = createProactiveDelivery({ channels: new Map() });
    const result = await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
    });
    expect(result).toEqual({ ok: false, reason: "no_channels" });
  });
});
```

- [ ] **Step 2: Stub the factory (test fails on assertion, not import)**

Create `packages/lib/proactive/src/proactive-delivery.ts`:

```typescript
import type { ChannelAdapter, ContentBlock, JsonObject, OutboundMessage } from "@koi/core";

export type DeliveryPriority = "low" | "normal" | "high" | "urgent";

export interface ProactiveNotification {
  readonly priority: DeliveryPriority;
  readonly content: readonly ContentBlock[];
  readonly threadId?: string;
  readonly metadata?: JsonObject;
}

export interface DeliveryPreferences {
  readonly preferredChannel?: string;
  readonly maxNotificationsPerHour?: number;
}

export interface ProactiveDeliveryConfig {
  readonly channels: ReadonlyMap<string, ChannelAdapter>;
  readonly preferences?: DeliveryPreferences;
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

export function createProactiveDelivery(_config: ProactiveDeliveryConfig): ProactiveDelivery {
  return { send: async () => ({ ok: true, delivered: [] }) };
}
```

- [ ] **Step 3: Run test to verify failure**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL — stub returns `ok:true` but test expects `no_channels`.

- [ ] **Step 4: Implement minimal `no_channels` branch**

Replace the factory body:

```typescript
export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  return {
    send: async (notification) => {
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      // Real routing comes in later tasks.
      return { ok: true, delivered: [] };
    },
  };
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/superpowers/specs/2026-05-10-proactive-delivery-design.md docs/superpowers/plans/2026-05-10-proactive-delivery.md packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts && git commit -m "feat(proactive): scaffold proactive delivery surface with no_channels guard"
```

---

## Task 2: High priority routes to preferredChannel + fallback

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write tests 2 + 3 inside the existing `describe`**

```typescript
  test("high priority routes to preferredChannel", async () => {
    const sent: { channel: string; msg: OutboundMessage }[] = [];
    const slack = stubAdapter("slack", async (m) => { sent.push({ channel: "slack", msg: m }); });
    const email = stubAdapter("email", async (m) => { sent.push({ channel: "email", msg: m }); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
      preferences: { preferredChannel: "email" },
    });

    const result = await delivery.send({
      priority: "high",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["email"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe("email");
    expect(sent[0]?.msg.content).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("high priority falls back to first channel when no preferred", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => { sent.push("slack"); });
    const email = stubAdapter("email", async () => { sent.push("email"); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
    });

    const result = await delivery.send({
      priority: "high",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack"] });
    expect(sent).toEqual(["slack"]);
  });
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL — current stub returns `delivered: []`.

- [ ] **Step 3: Implement priority routing for non-urgent**

Replace the factory implementation. Add helper `selectPreferred` and a single-channel send path:

```typescript
function buildOutbound(notification: ProactiveNotification): OutboundMessage {
  return {
    content: notification.content,
    ...(notification.threadId !== undefined ? { threadId: notification.threadId } : {}),
    ...(notification.metadata !== undefined ? { metadata: notification.metadata } : {}),
  };
}

function selectPreferred(
  channels: ReadonlyMap<string, ChannelAdapter>,
  preferredName: string | undefined,
): { name: string; adapter: ChannelAdapter } | undefined {
  if (preferredName !== undefined) {
    const adapter = channels.get(preferredName);
    if (adapter !== undefined) return { name: preferredName, adapter };
  }
  // First by Map insertion order.
  const first = channels.entries().next();
  if (first.done === true) return undefined;
  const [name, adapter] = first.value;
  return { name, adapter };
}

async function sendOne(
  channel: { name: string; adapter: ChannelAdapter },
  msg: OutboundMessage,
): Promise<DeliveryFailure | undefined> {
  try {
    await channel.adapter.send(msg);
    return undefined;
  } catch (e: unknown) {
    return {
      channel: channel.name,
      error: e instanceof Error ? e.message : "channel.send failed",
    };
  }
}

export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  const preferences = config.preferences;
  return {
    send: async (notification) => {
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      // Urgent fan-out comes in Task 3; for now treat all non-empty cases
      // as single-channel preferred routing.
      const target = selectPreferred(config.channels, preferences?.preferredChannel);
      if (target === undefined) {
        return { ok: false, reason: "no_channels" };
      }
      const msg = buildOutbound(notification);
      const failure = await sendOne(target, msg);
      if (failure !== undefined) {
        return { ok: false, reason: "all_failed", failures: [failure] };
      }
      return { ok: true, delivered: [target.name] };
    },
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "feat(proactive): preferred-channel and fallback routing for high priority"
```

---

## Task 3: Normal/low identical to high in Phase 3 + threadId/metadata forwarding

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Add tests 4 + 13**

```typescript
  test("normal and low priority behave identically to high in Phase 3", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => { sent.push("slack"); });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    const r1 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    const r2 = await delivery.send({ priority: "low", content: [{ kind: "text", text: "l" }] });

    expect(r1).toEqual({ ok: true, delivered: ["slack"] });
    expect(r2).toEqual({ ok: true, delivered: ["slack"] });
    expect(sent).toEqual(["slack", "slack"]);
  });

  test("threadId and metadata forwarded verbatim to OutboundMessage", async () => {
    const captured: OutboundMessage[] = [];
    const slack = stubAdapter("slack", async (m) => { captured.push(m); });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
      threadId: "T1",
      metadata: { source: "composition" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      content: [{ kind: "text", text: "hi" }],
      threadId: "T1",
      metadata: { source: "composition" },
    });
  });
```

- [ ] **Step 2: Run tests, expect pass (no impl change needed)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (5 tests).

---

## Task 4: Urgent fan-out (success, partial fail, total fail)

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write tests 5, 6, 7**

```typescript
  test("urgent priority fans out to all channels", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => { sent.push("slack"); });
    const email = stubAdapter("email", async () => { sent.push("email"); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
    });

    const result = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack", "email"] });
    expect(sent.sort()).toEqual(["email", "slack"]);
  });

  test("urgent partial failure — one channel succeeds, one fails", async () => {
    const slack = stubAdapter("slack", async () => {});
    const email = stubAdapter("email", async () => { throw new Error("smtp down"); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
    });

    const result = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("urgent total failure — every channel fails → all_failed with all in failures", async () => {
    const slack = stubAdapter("slack", async () => { throw new Error("boom"); });
    const email = stubAdapter("email", async () => { throw new Error("smtp down"); });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack], ["email", email]]),
    });

    const result = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("all_failed");
    const failures = [...(result.failures ?? [])].sort((a, b) => a.channel.localeCompare(b.channel));
    expect(failures).toEqual([
      { channel: "email", error: "smtp down" },
      { channel: "slack", error: "boom" },
    ]);
  });
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL — urgent currently routes to single preferred channel.

- [ ] **Step 3: Implement urgent fan-out branch**

In `proactive-delivery.ts`, before the preferred-channel branch in `send`, handle urgent:

```typescript
if (notification.priority === "urgent") {
  const msg = buildOutbound(notification);
  const entries = Array.from(config.channels.entries(), ([name, adapter]) => ({ name, adapter }));
  const results = await Promise.all(entries.map((c) => sendOne(c, msg)));
  const delivered: string[] = [];
  const failures: DeliveryFailure[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const failure = results[i];
    if (entry === undefined) continue;
    if (failure === undefined) {
      delivered.push(entry.name);
    } else {
      failures.push(failure);
    }
  }
  if (delivered.length === 0) {
    return { ok: false, reason: "all_failed", failures };
  }
  return { ok: true, delivered };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "feat(proactive): urgent priority fans out to all channels in parallel"
```

---

## Task 5: Rate limit (block, urgent bypass, urgent doesn't consume, sliding window)

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write tests 8, 9, 10, 11**

```typescript
  test("rate limit blocks normal priority after cap", async () => {
    let t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 2 },
      now: () => t,
    });

    const a = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    const b = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });
    const c = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "3" }] });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c).toEqual({ ok: false, reason: "rate_limited" });
  });

  test("rate-limit window slides — old entries drop, new send goes through", async () => {
    let t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    const a = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    expect(a.ok).toBe(true);

    // Same instant → still at cap.
    const b = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });
    expect(b).toEqual({ ok: false, reason: "rate_limited" });

    // Advance just past 1 hour → previous entry slides out.
    t += 3_600_001;
    const c = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "3" }] });
    expect(c.ok).toBe(true);
  });

  test("urgent bypasses rate limit even at cap", async () => {
    const t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 0 },
      now: () => t,
    });

    const r = await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "alert" }] });
    expect(r.ok).toBe(true);
  });

  test("urgent does not consume rate-limit window capacity", async () => {
    const t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    // Two urgent sends do NOT fill the bucket.
    await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "u1" }] });
    await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "u2" }] });

    // A normal send still passes — cap is not reached.
    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r.ok).toBe(true);
  });
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL — rate limit not implemented yet.

- [ ] **Step 3: Implement rate-limit window**

Add to the factory (replacing the `send:` block) — hoist `now`, the window array, and the gate check:

```typescript
export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  const preferences = config.preferences;
  const now = config.now ?? Date.now;
  const cap = preferences?.maxNotificationsPerHour;
  const WINDOW_MS = 3_600_000;
  // let: window mutates on every successful non-urgent send and on every gate
  // check (slides out entries older than now() - WINDOW_MS).
  const window: number[] = [];

  function pruneWindow(t: number): void {
    while (window.length > 0) {
      const head = window[0];
      if (head === undefined || head > t - WINDOW_MS) break;
      window.shift();
    }
  }

  function reserveSlot(t: number, priority: DeliveryPriority): boolean {
    if (priority === "urgent") return true;
    if (cap === undefined) return true;
    pruneWindow(t);
    if (window.length >= cap) return false;
    // Reserve synchronously so concurrent same-instant sends cannot both pass.
    window.push(t);
    return true;
  }

  function refundSlot(t: number, priority: DeliveryPriority): void {
    if (priority === "urgent" || cap === undefined) return;
    // Remove the most-recent matching entry — undoes a failed delivery so it
    // does not consume capacity.
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i] === t) {
        window.splice(i, 1);
        return;
      }
    }
  }

  return {
    send: async (notification) => {
      if (config.channels.size === 0) {
        return { ok: false, reason: "no_channels" };
      }
      const t = now();
      if (notification.priority === "urgent") {
        // Urgent is its own path — fan-out, never gated by rate limit, never
        // consumes window capacity.
        const msg = buildOutbound(notification);
        const entries = Array.from(config.channels.entries(), ([name, adapter]) => ({ name, adapter }));
        const results = await Promise.all(entries.map((c) => sendOne(c, msg)));
        const delivered: string[] = [];
        const failures: DeliveryFailure[] = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const failure = results[i];
          if (entry === undefined) continue;
          if (failure === undefined) {
            delivered.push(entry.name);
          } else {
            failures.push(failure);
          }
        }
        if (delivered.length === 0) {
          return { ok: false, reason: "all_failed", failures };
        }
        return { ok: true, delivered };
      }
      if (!reserveSlot(t, notification.priority)) {
        return { ok: false, reason: "rate_limited" };
      }
      const target = selectPreferred(config.channels, preferences?.preferredChannel);
      if (target === undefined) {
        refundSlot(t, notification.priority);
        return { ok: false, reason: "no_channels" };
      }
      const msg = buildOutbound(notification);
      const failure = await sendOne(target, msg);
      if (failure !== undefined) {
        refundSlot(t, notification.priority);
        return { ok: false, reason: "all_failed", failures: [failure] };
      }
      return { ok: true, delivered: [target.name] };
    },
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "feat(proactive): sliding 1h rate-limit window with urgent bypass"
```

---

## Task 6: Adapter throw + concurrent-cap-1 tests

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Add tests 12 + 14**

```typescript
  test("adapter throw on single channel → all_failed without propagation", async () => {
    const slack = stubAdapter("slack", async () => { throw new Error("network"); });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    const result = await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({
      ok: false,
      reason: "all_failed",
      failures: [{ channel: "slack", error: "network" }],
    });
  });

  test("two concurrent sends at cap=1 — exactly one passes", async () => {
    const t = 1_700_000_000_000;
    let releaseA: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { releaseA = resolve; });
    let inFlight = 0;
    const slack = stubAdapter("slack", async () => {
      inFlight += 1;
      try {
        await blocker;
      } finally {
        inFlight -= 1;
      }
    });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    const p1 = delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    const p2 = delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });

    // Wait one microtask so both reservations are evaluated synchronously.
    await Promise.resolve();
    expect(inFlight).toBe(1);

    releaseA?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    const ok = [r1, r2].filter((r) => r.ok);
    const blocked = [r1, r2].filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual({ ok: false, reason: "rate_limited" });
  });
```

- [ ] **Step 2: Run tests, expect pass (no impl change needed)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "test(proactive): adapter-throw and concurrent-cap edge cases"
```

---

## Task 7: Public exports + docs + final verify

**Files:**
- Modify: `packages/lib/proactive/src/index.ts`
- Modify: `docs/L2/proactive.md`
- Modify: `docs/L3/runtime.md`

- [ ] **Step 1: Add exports**

Append to `packages/lib/proactive/src/index.ts`:

```typescript
export {
  createProactiveDelivery,
  type DeliveryFailure,
  type DeliveryPreferences,
  type DeliveryPriority,
  type DeliveryResult,
  type ProactiveDelivery,
  type ProactiveDeliveryConfig,
  type ProactiveNotification,
} from "./proactive-delivery.js";
```

- [ ] **Step 2: Add docs section**

Read `docs/L2/proactive.md` and append a new H2 section near the end (after the existing Composition triggers section):

```markdown
## Proactive delivery — `createProactiveDelivery`

Routes a `ProactiveNotification` to one or more attached `ChannelAdapter`s
based on priority. Phase 3 surface; quiet hours, multi-channel fallback,
and inbox routing for `low` priority are deferred to Phase 4.

```typescript
import { createProactiveDelivery } from "@koi/proactive";

const delivery = createProactiveDelivery({
  channels: new Map([
    ["slack", slackAdapter],
    ["email", emailAdapter],
  ]),
  preferences: {
    preferredChannel: "slack",
    maxNotificationsPerHour: 30,
  },
});

const result = await delivery.send({
  priority: "high",
  content: [{ kind: "text", text: "Composition completed: dispatched diagnostic agent." }],
});
```

Routing rules:

| Priority | Routes to | Rate-limited |
|---|---|---|
| `urgent` | every channel in parallel; success if at least one delivered | no — bypasses cap and does not consume window capacity |
| `high` / `normal` / `low` | `preferredChannel` if configured, else first channel by Map insertion order | yes — counted against the sliding 1-hour cap |

Failures are wrapped: an adapter `send` rejection becomes `{ ok: false,
reason: "all_failed", failures: [{ channel, error }] }`. Adapter
exceptions never propagate. Failed deliveries refund their rate-limit
slot. Concurrent sends at cap-1 cannot both pass — the gate reserves
its slot synchronously before any `await`.
```

- [ ] **Step 3: Add changelog entry**

Read the top of the Changelog section in `docs/L3/runtime.md` (around line 625), and prepend a new entry under `## Changelog`:

```markdown
- 2026-05-10: `@koi/proactive` adds `createProactiveDelivery` (issue #1301 Phase 3). Priority-routing dispatcher over existing `ChannelAdapter`s — `urgent` fans out to all channels and bypasses rate limits; `high`/`normal`/`low` route to `preferredChannel` (or first by Map insertion order) and are gated by a sliding 1-hour `maxNotificationsPerHour` cap. Adapter exceptions are wrapped into `failures[]`; failed deliveries refund their rate slot. Quiet hours, multi-channel fallback, and inbox-routing for `low` are deferred to Phase 4. No `RuntimeConfig` surface change — hosts wire `createProactiveDelivery` themselves and pass the channel map.
```

- [ ] **Step 4: Verify**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi/packages/lib/proactive && bun run typecheck && bun run lint && bun test
cd /Users/sophiawj/.codex/worktrees/1301/koi && bun run check:layers && bun run check:doc-wiring
```

Expected: all pass.

- [ ] **Step 5: Commit + push**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add packages/lib/proactive/src/index.ts docs/L2/proactive.md docs/L3/runtime.md && git commit -m "docs(proactive): export and document createProactiveDelivery"
```

---

## Self-Review Notes

- Spec coverage: every spec test (1-14) maps to a Task (1: no_channels; 2: high preferred + fallback; 3: normal/low + threadId/metadata; 4: urgent fan-out / partial / total; 5: rate-limit block + slide + urgent bypass + urgent no-consume; 6: adapter-throw + concurrent-cap; 7: exports + docs).
- No placeholders.
- Type consistency: `DeliveryPriority`, `DeliveryResult`, `DeliveryFailure`, `ProactiveNotification`, `ProactiveDelivery` used consistently across source + tests + exports.
- Rate-limit refund-on-fail rule in spec ("A failed delivery does NOT consume window capacity") is implemented in `sendOne` failure branches via `refundSlot`. Concurrent-cap test verifies the synchronous reservation behavior.
