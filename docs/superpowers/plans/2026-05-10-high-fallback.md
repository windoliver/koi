# High-priority multi-channel fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Add sequential multi-channel fallback to `high`-priority sends. On adapter failure, walk remaining channels in Map insertion order until one succeeds.

**Architecture:** New `selectHighOrder()` helper returns the ordered attempt list (preferred first, then insertion order, deduped). New `send` branch for `high` runs `sendOne` sequentially and short-circuits on success. Rate-limit slot reserved once upfront, refunded only if every attempt fails.

**Tech Stack:** TS6 strict, Bun 1.3, `bun:test`. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-10-high-fallback-design.md`
**Builds on:** Phase 3 + quiet-hours (already on this branch).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/lib/proactive/src/proactive-delivery.ts` | Add `selectHighOrder` + high branch |
| `packages/lib/proactive/src/proactive-delivery.test.ts` | 8 new tests |
| `docs/L2/proactive.md` | Routing table + High fallback subsection |
| `docs/L3/runtime.md` | Changelog |

---

## Task 1: `selectHighOrder` helper

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`

- [ ] **Step 1: Add helper above `createProactiveDelivery`**

After the `selectPreferred` helper, add:

```typescript
function selectHighOrder(
  channels: ReadonlyMap<string, ChannelAdapter>,
  preferredName: string | undefined,
): readonly { name: string; adapter: ChannelAdapter }[] {
  const out: { name: string; adapter: ChannelAdapter }[] = [];
  if (preferredName !== undefined) {
    const adapter = channels.get(preferredName);
    if (adapter !== undefined) {
      out.push({ name: preferredName, adapter });
    }
  }
  for (const [name, adapter] of channels) {
    if (name === preferredName) continue;
    out.push({ name, adapter });
  }
  return out;
}
```

- [ ] **Step 2: Run existing tests to ensure no regression**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (21 tests).

No commit yet — Task 2 wires it in.

---

## Task 2: High-priority fallback branch + first 3 tests

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write failing tests 1, 2, 3**

Append to `proactive-delivery.test.ts` inside the existing `describe`:

```typescript
  test("high: preferred succeeds → only preferred called", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => {
      sent.push("slack");
    });
    const email = stubAdapter("email", async () => {
      sent.push("email");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["email"] });
    expect(sent).toEqual(["email"]);
  });

  test("high: preferred fails, second succeeds → walks fallback in order", async () => {
    const calls: string[] = [];
    const slack = stubAdapter("slack", async () => {
      calls.push("slack");
    });
    const email = stubAdapter("email", async () => {
      calls.push("email");
      throw new Error("smtp down");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
    expect(calls).toEqual(["email", "slack"]);
  });

  test("high: every channel fails → all_failed with failures in attempt order", async () => {
    const slack = stubAdapter("slack", async () => {
      throw new Error("net");
    });
    const email = stubAdapter("email", async () => {
      throw new Error("smtp");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({
      ok: false,
      reason: "all_failed",
      failures: [
        { channel: "email", error: "smtp" },
        { channel: "slack", error: "net" },
      ],
    });
  });
```

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL on test 2 (current `high` returns `all_failed` after one attempt; doesn't walk).

- [ ] **Step 3: Implement high branch in `send`**

In `proactive-delivery.ts`, after the quiet-hours gate (line `if (notification.priority === "normal" && isQuietNow(t))`) and before `if (!reserveSlot(...))`, add the high branch:

```typescript
      if (notification.priority === "high") {
        if (!reserveSlot(t, notification.priority)) {
          return { ok: false, reason: "rate_limited" };
        }
        const order = selectHighOrder(config.channels, preferences?.preferredChannel);
        if (order.length === 0) {
          refundSlot(t, notification.priority);
          return { ok: false, reason: "no_channels" };
        }
        const msg = buildOutbound(notification);
        const failures: DeliveryFailure[] = [];
        for (const target of order) {
          const failure = await sendOne(target, msg);
          if (failure === undefined) {
            return { ok: true, delivered: [target.name] };
          }
          failures.push(failure);
        }
        refundSlot(t, notification.priority);
        return { ok: false, reason: "all_failed", failures };
      }
```

- [ ] **Step 4: Run, expect pass**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (24 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/superpowers/specs/2026-05-10-high-fallback-design.md docs/superpowers/plans/2026-05-10-high-fallback.md packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts && git commit -m "feat(proactive): high priority falls back through remaining channels on failure"
```

---

## Task 3: Edge-case tests (no preferred, single-channel, missing preferred)

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write tests 4, 5, 6**

```typescript
  test("high: no preferred configured → walks insertion order from start", async () => {
    const calls: string[] = [];
    const slack = stubAdapter("slack", async () => {
      calls.push("slack");
      throw new Error("net");
    });
    const email = stubAdapter("email", async () => {
      calls.push("email");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["email"] });
    expect(calls).toEqual(["slack", "email"]);
  });

  test("high: single channel that fails → all_failed with single failure", async () => {
    const slack = stubAdapter("slack", async () => {
      throw new Error("net");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({
      ok: false,
      reason: "all_failed",
      failures: [{ channel: "slack", error: "net" }],
    });
  });

  test("high: preferred missing from channels map → walks insertion order", async () => {
    const calls: string[] = [];
    const slack = stubAdapter("slack", async () => {
      calls.push("slack");
    });
    const email = stubAdapter("email", async () => {
      calls.push("email");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "discord" }, // not in map
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
    expect(calls).toEqual(["slack"]);
  });
```

- [ ] **Step 2: Run, expect pass (no impl change)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (27 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "test(proactive): high fallback edge cases — no preferred, single channel, missing preferred"
```

---

## Task 4: Rate-limit-1-slot test + normal-doesn't-fall-back test

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write tests 7 + 8**

```typescript
  test("high fallback consumes exactly 1 rate-limit slot regardless of attempts", async () => {
    const t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {
      throw new Error("net");
    });
    const email = stubAdapter("email", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    // First high send walks slack→email; should consume 1 slot, not 2.
    const r1 = await delivery.send({ priority: "high", content: [{ kind: "text", text: "1" }] });
    expect(r1).toEqual({ ok: true, delivered: ["email"] });

    // Bucket is now full at 1/1; next non-urgent must be rate-limited.
    const r2 = await delivery.send({ priority: "high", content: [{ kind: "text", text: "2" }] });
    expect(r2).toEqual({ ok: false, reason: "rate_limited" });
  });

  test("normal does NOT fall back — preferred fails → all_failed after one attempt", async () => {
    const calls: string[] = [];
    const slack = stubAdapter("slack", async () => {
      calls.push("slack");
    });
    const email = stubAdapter("email", async () => {
      calls.push("email");
      throw new Error("smtp");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r).toEqual({
      ok: false,
      reason: "all_failed",
      failures: [{ channel: "email", error: "smtp" }],
    });
    expect(calls).toEqual(["email"]);
  });
```

- [ ] **Step 2: Run, expect pass (no impl change)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (29 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "test(proactive): high fallback consumes 1 rate-limit slot; normal does not fall back"
```

---

## Task 5: Docs + final verify

**Files:**
- Modify: `docs/L2/proactive.md`
- Modify: `docs/L3/runtime.md`

- [ ] **Step 1: Update routing table in `docs/L2/proactive.md`**

Find the routing table that lists `high` and update its row to:

Old:
```markdown
| `high` | `preferredChannel` if configured, else first channel by Map insertion order | yes — counted against the sliding 1-hour cap | no |
```

New:
```markdown
| `high` | preferred channel first; on failure, walks remaining channels in Map insertion order; first success wins | yes — exactly 1 slot per send call regardless of attempts | no |
```

- [ ] **Step 2: Append "High fallback (Phase 4)" subsection to `docs/L2/proactive.md` immediately after the "Quiet hours (Phase 4)" subsection**

```markdown
### High fallback (Phase 4)

`high` priority survives a single-channel failure. Delivery walks
channels sequentially — preferred first if configured, then remaining
channels in Map insertion order. The first adapter that resolves
without throwing wins; later channels are not attempted. If every
channel throws, the result is `{ ok: false, reason: "all_failed",
failures: [...] }` with failures listed in attempt order.

Rate limit: exactly one slot is consumed per `send()` call regardless
of how many adapters the fallback walks. The slot is refunded if every
attempt fails (Phase 3 invariant).

`normal` and `low` retain single-attempt routing — there is no
fallback for those priorities.
```

- [ ] **Step 3: Prepend changelog entry to `docs/L3/runtime.md` under `## Changelog`**

```markdown
- 2026-05-10: `@koi/proactive` adds sequential multi-channel fallback for `high` priority in `createProactiveDelivery` (issue #1301 Phase 4 sub-2). `high` sends now attempt `preferredChannel` first; on adapter failure they walk remaining channels in Map insertion order and return on first success. Rate limit counts each `send()` call as exactly one slot regardless of how many attempts the fallback performs; slot is refunded if every attempt fails. `urgent` keeps parallel fan-out; `normal` and `low` retain single-attempt routing.
```

- [ ] **Step 4: Final verify**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi/packages/lib/proactive && bun run typecheck && bun run lint && bun test
cd /Users/sophiawj/.codex/worktrees/1301/koi && bun run check:layers && bun run check:doc-wiring
```

All must pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/L2/proactive.md docs/L3/runtime.md && git commit -m "docs(proactive): document high-priority fallback"
```

---

## Self-Review Notes

- All 8 spec tests covered (Task 2: tests 1-3; Task 3: tests 4-6; Task 4: tests 7-8).
- No placeholders.
- Type names consistent with existing `DeliveryResult`, `DeliveryFailure`, `ChannelAdapter`.
- Rate-limit semantics: 1 slot per send, refund on total fail. Test 7 proves it.
- `normal` regression test (Task 4 test 8) proves fallback is `high`-only.
- `selectHighOrder` returns frozen-ish `readonly` array; preferred-missing case (test 6) handled by `channels.get` returning undefined and falling into the `for` loop from the start.
