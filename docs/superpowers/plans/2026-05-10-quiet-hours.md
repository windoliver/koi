# Quiet hours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add quiet-hours gating to `createProactiveDelivery` — `normal`-priority sends in the configured timezone window return `{ok:false, reason:"quiet_hours"}`. `urgent`/`high` always pass.

**Architecture:** Pure validation at factory construction; small `isQuietNow(now())` helper inside the factory closure. Gate runs before rate-limit gate so suppressed sends do not consume window capacity.

**Tech Stack:** TS6 strict, Bun 1.3, `bun:test`, no new deps. `Intl.DateTimeFormat` platform built-in.

**Spec:** `docs/superpowers/specs/2026-05-10-quiet-hours-design.md`
**Builds on:** Phase 3 (PR #2175) — already on this branch.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/lib/proactive/src/proactive-delivery.ts` | Validation + gate |
| `packages/lib/proactive/src/proactive-delivery.test.ts` | 7 new tests |
| `packages/lib/proactive/src/index.ts` | No change (types already exported) |
| `docs/L2/proactive.md` | Quiet-hours section |
| `docs/L3/runtime.md` | Changelog |

---

## Task 1: Validation at factory construction

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Extend `DeliveryPreferences` and add `"quiet_hours"` reason**

In `proactive-delivery.ts`, replace the `DeliveryPreferences` interface:

```typescript
export interface DeliveryPreferences {
  readonly preferredChannel?: string;
  readonly maxNotificationsPerHour?: number;
  readonly quietHoursStart?: number;
  readonly quietHoursEnd?: number;
  readonly timezone?: string;
}
```

And in the `DeliveryResult` union, add `"quiet_hours"`:

```typescript
export type DeliveryResult =
  | { readonly ok: true; readonly delivered: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "no_channels" | "rate_limited" | "all_failed" | "quiet_hours";
      readonly failures?: readonly DeliveryFailure[];
    };
```

- [ ] **Step 2: Write the failing validation test**

Add to `proactive-delivery.test.ts` inside the existing `describe`:

```typescript
  test("throws when only quietHoursStart is set", () => {
    const slack = stubAdapter("slack", async () => {});
    expect(() =>
      createProactiveDelivery({
        channels: new Map([["slack", slack]]),
        preferences: { quietHoursStart: 22 },
      }),
    ).toThrow(/quietHoursStart and quietHoursEnd must both be set/);
  });
```

- [ ] **Step 3: Run test, expect failure**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL — currently no throw.

- [ ] **Step 4: Implement validation**

In `proactive-delivery.ts`, add a top-level helper above `createProactiveDelivery`:

```typescript
function validateQuietHours(prefs: DeliveryPreferences | undefined): void {
  if (prefs === undefined) return;
  const { quietHoursStart: s, quietHoursEnd: e, timezone } = prefs;
  const sSet = s !== undefined;
  const eSet = e !== undefined;
  if (sSet !== eSet) {
    throw new Error("quietHoursStart and quietHoursEnd must both be set or both omitted");
  }
  if (sSet && eSet) {
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 23 || e < 0 || e > 23) {
      throw new Error("quietHoursStart and quietHoursEnd must be integers in [0, 23]");
    }
    if (s === e) {
      throw new Error("quietHoursStart must not equal quietHoursEnd");
    }
  }
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(0));
    } catch (cause: unknown) {
      throw new Error(`invalid timezone: ${timezone}`, { cause });
    }
  }
}
```

Then call it as the first line of `createProactiveDelivery`:

```typescript
export function createProactiveDelivery(config: ProactiveDeliveryConfig): ProactiveDelivery {
  validateQuietHours(config.preferences);
  // ...rest unchanged
```

- [ ] **Step 5: Run test, expect pass**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/superpowers/specs/2026-05-10-quiet-hours-design.md docs/superpowers/plans/2026-05-10-quiet-hours.md packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts && git commit -m "feat(proactive): validate quiet-hours preferences at construction"
```

---

## Task 2: Quiet-hours gate for normal priority

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.ts`
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write failing tests 1, 2, 3, 4**

Add to `proactive-delivery.test.ts`:

```typescript
  test("normal during quiet window → quiet_hours, adapter NOT called", async () => {
    let sendCount = 0;
    const slack = stubAdapter("slack", async () => { sendCount += 1; });
    // 2026-05-10 03:00:00 UTC — within 22-6 quiet window
    const t = Date.UTC(2026, 4, 10, 3, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r).toEqual({ ok: false, reason: "quiet_hours" });
    expect(sendCount).toBe(0);
  });

  test("normal outside quiet window → delivered", async () => {
    const slack = stubAdapter("slack", async () => {});
    // 14:00 UTC, outside 22-6
    const t = Date.UTC(2026, 4, 10, 14, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("high during quiet window → delivered (bypasses quiet)", async () => {
    const slack = stubAdapter("slack", async () => {});
    const t = Date.UTC(2026, 4, 10, 3, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("urgent during quiet window → fan-out as Phase 3", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => { sent.push("slack"); });
    const email = stubAdapter("email", async () => { sent.push("email"); });
    const t = Date.UTC(2026, 4, 10, 3, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "u" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack", "email"] });
    expect(sent.sort()).toEqual(["email", "slack"]);
  });
```

- [ ] **Step 2: Run, expect failure (gate not implemented)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: FAIL on the first new test (returns ok:true instead of quiet_hours).

- [ ] **Step 3: Implement `isQuietNow` helper + gate**

Inside `createProactiveDelivery`, after the `now` / `cap` / `WINDOW_MS` declarations, add:

```typescript
  const quietStart = preferences?.quietHoursStart;
  const quietEnd = preferences?.quietHoursEnd;
  const tz = preferences?.timezone ?? "UTC";
  const hourFormatter =
    quietStart !== undefined && quietEnd !== undefined
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" })
      : undefined;

  function isQuietNow(t: number): boolean {
    if (hourFormatter === undefined || quietStart === undefined || quietEnd === undefined) {
      return false;
    }
    const hourStr = hourFormatter.format(new Date(t));
    const h = Number.parseInt(hourStr, 10);
    if (Number.isNaN(h)) return false;
    return quietStart < quietEnd
      ? h >= quietStart && h < quietEnd
      : h >= quietStart || h < quietEnd;
  }
```

Then in the `send` closure, after the urgent branch and BEFORE `reserveSlot`, add:

```typescript
      if (notification.priority === "normal" && isQuietNow(t)) {
        return { ok: false, reason: "quiet_hours" };
      }
```

- [ ] **Step 4: Run, expect pass (4 new tests)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (19 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.ts packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "feat(proactive): suppress normal priority during quiet hours"
```

---

## Task 3: Cross-midnight + rate-limit-no-consume tests

**Files:**
- Modify: `packages/lib/proactive/src/proactive-delivery.test.ts`

- [ ] **Step 1: Write tests 5, 6**

```typescript
  test("cross-midnight window (22, 6): hours 23, 0, 5 quiet; 6, 21 not", async () => {
    const slack = stubAdapter("slack", async () => {});
    const make = (t: number) =>
      createProactiveDelivery({
        channels: new Map([["slack", slack]]),
        preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
        now: () => t,
      });
    const at = (h: number) => Date.UTC(2026, 4, 10, h, 0, 0);
    const send = (t: number) =>
      make(t).send({ priority: "normal", content: [{ kind: "text", text: "x" }] });

    expect((await send(at(23))).ok).toBe(false);
    expect((await send(at(0))).ok).toBe(false);
    expect((await send(at(5))).ok).toBe(false);
    expect((await send(at(6))).ok).toBe(true);
    expect((await send(at(21))).ok).toBe(true);
  });

  test("quiet-suppressed normal does not consume rate-limit slot", async () => {
    const slack = stubAdapter("slack", async () => {});
    let t = Date.UTC(2026, 4, 10, 3, 0, 0); // quiet
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: {
        quietHoursStart: 22,
        quietHoursEnd: 6,
        timezone: "UTC",
        maxNotificationsPerHour: 1,
      },
      now: () => t,
    });

    // Two suppressed sends inside quiet window — should not fill bucket.
    const r1 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    const r2 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });
    expect(r1).toEqual({ ok: false, reason: "quiet_hours" });
    expect(r2).toEqual({ ok: false, reason: "quiet_hours" });

    // Move outside quiet window; cap=1 should still permit one delivery.
    t = Date.UTC(2026, 4, 10, 14, 0, 0);
    const r3 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "3" }] });
    expect(r3).toEqual({ ok: true, delivered: ["slack"] });
  });
```

- [ ] **Step 2: Run, expect pass (no impl change)**

Run: `cd packages/lib/proactive && bun test proactive-delivery.test.ts`
Expected: PASS (21 tests total).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/proactive-delivery.test.ts
git commit -m "test(proactive): cross-midnight quiet window + rate-limit no-consume"
```

---

## Task 4: Docs + final verify

**Files:**
- Modify: `docs/L2/proactive.md`
- Modify: `docs/L3/runtime.md`

- [ ] **Step 1: Append to `docs/L2/proactive.md` Delivery section**

Append the following H3 under the Phase-3 Proactive delivery section:

```markdown
### Quiet hours (Phase 4)

Set `quietHoursStart`, `quietHoursEnd`, and optional `timezone` (IANA,
default `"UTC"`) on `DeliveryPreferences` to suppress `normal`-priority
sends within the window. `high` and `urgent` always pass; `low` is
unaffected (inbox routing is a separate Phase 4 follow-up).

```typescript
const delivery = createProactiveDelivery({
  channels,
  preferences: {
    quietHoursStart: 22,        // suppress from 22:00
    quietHoursEnd: 6,           // through 05:59
    timezone: "America/New_York",
    preferredChannel: "slack",
  },
});
```

Window is `[start, end)` in the configured timezone; cross-midnight
windows are supported (e.g. 22→6). Suppressed sends return
`{ ok: false, reason: "quiet_hours" }` and **do not** consume the rate
limit window. Validation runs at factory construction — partial config
(only one bound set), out-of-range hours, or invalid IANA timezones
throw immediately.
```

- [ ] **Step 2: Prepend changelog entry to `docs/L3/runtime.md` under `## Changelog`**

```markdown
- 2026-05-10: `@koi/proactive` adds quiet-hours gating to `createProactiveDelivery` (issue #1301 Phase 4 sub-1). `DeliveryPreferences` accepts `quietHoursStart`, `quietHoursEnd`, `timezone` (IANA, default `"UTC"`); `normal`-priority sends inside the window return `{ ok: false, reason: "quiet_hours" }` without consuming rate-limit capacity. `high` and `urgent` always pass. Cross-midnight windows supported. Validation throws at construction for partial config, out-of-range hours, or invalid timezones. Multi-channel fallback for `high` and inbox routing for `low` remain in follow-up PRs.
```

- [ ] **Step 3: Final verify**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi/packages/lib/proactive && bun run typecheck && bun run lint && bun test
cd /Users/sophiawj/.codex/worktrees/1301/koi && bun run check:layers && bun run check:doc-wiring
```

All must pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/L2/proactive.md docs/L3/runtime.md && git commit -m "docs(proactive): document quiet-hours gating"
```

---

## Self-Review Notes

- All 7 spec tests covered (Task 1: validation; Task 2: tests 1-4; Task 3: tests 5-6).
- No placeholders.
- Type names consistent with Phase 3 (`DeliveryPreferences`, `DeliveryResult`).
- Gate ordering respected: quiet → rate-limit → channel-select → send. Verified by Task-3 Test 6.
- `isQuietNow` is pure given `t` + closed-over formatter; injected `now` makes all tests deterministic.
