# gov-9: TUI Governance Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make governance observable in the TUI: status-line chip showing the most-stressed sensor, dismissable alert toasts on threshold cross, full-screen `/governance` view (sensor table + recent alerts + active rules + middleware capabilities), `/governance reset` to clear per-session alert dedup, JSONL alert persistence at `~/.koi/governance-alerts.jsonl` (last 200), and per-variable alert thresholds.

**Architecture:** TUI stays render-only. New host-side `governance-bridge.ts` (mirrors `cost-bridge.ts`) subscribes to governance-core's `onAlert`/`onViolation` callbacks, polls `controller.snapshot()` on engine done, and dispatches new TUI actions (`set_governance_snapshot`, `add_governance_alert`, etc.). New L0 `describeRules?()` optional method on `GovernanceBackend` lets the pattern-backend expose rules for `/governance` rendering. Alert persistence is inline JSONL append in the bridge (no new package).

**Tech Stack:** TypeScript 6 (strict), Bun 1.3.x, `bun:test`, SolidJS reactive store. Affected packages: `@koi/core` (L0), `@koi/governance-core` (L2), `@koi/governance-defaults` (L2), `@koi/tui` (L2), `@koi/cli` (L3).

**Issue:** [#1876](https://github.com/windoliver/koi/issues/1876)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/kernel/core/src/governance-backend.ts` | L0 `GovernanceBackend` composite interface | Add `describeRules?(): readonly RuleDescriptor[] \| Promise<…>` + `RuleDescriptor` type |
| `packages/security/governance-defaults/src/pattern-backend.ts` | Pattern-matching backend | Implement `describeRules` returning current rule set |
| `packages/security/governance-core/src/config.ts` | MW config | Add `perVariableThresholds?: Record<string, readonly number[]>` |
| `packages/security/governance-core/src/alert-tracker.ts` | Alert dedup tracker | Use per-variable thresholds when present, else fall back to global |
| `packages/ui/tui/src/state/types.ts` | TUI state + action types | Add `governance` field, `Toast` slice, 5 new action kinds |
| `packages/ui/tui/src/state/reduce.ts` | Reducer | Handle the 5 new action kinds |
| `packages/ui/tui/src/components/Toast.tsx` | NEW: top-right toast overlay | Priority queue, auto-dismiss, fold-merge by key |
| `packages/ui/tui/src/components/StatusBar.tsx` | Status bar | Insert governance chip showing most-stressed sensor |
| `packages/ui/tui/src/components/GovernanceView.tsx` | NEW: full-screen view | Sensor table + alerts + capabilities + rules + Esc-back |
| `packages/ui/tui/src/commands/command-definitions.ts` | Command registry | Add `nav:governance` + `system:governance-reset` |
| `packages/ui/tui/src/tui-root.tsx` | Root view + dispatch | Wire NAV_VIEW_MAP, Switch case, governance-reset handler |
| `packages/meta/cli/src/governance-bridge.ts` | NEW: bridge controller→TUI store | onAlert/onViolation subscribers, snapshot polling, JSONL persistence |
| `packages/meta/cli/src/tui-command.ts` | TUI command host | Instantiate `governance-bridge`, dispose on shutdown |
| `docs/L2/governance-core.md` | L2 doc | Document `perVariableThresholds` |
| `docs/L2/governance-defaults.md` | L2 doc | Document `describeRules` |
| `docs/L2/tui.md` (or create) | L2 doc | Document new `/governance` view, status chip, toast |
| `docs/architecture/governance-tui-bridge.md` | NEW arch doc | Bridge contract: events in, actions out, persistence schema |

Total ~1700 LOC including tests + docs. Single PR per user direction (rubber-stamp accepted).

---

## Task 1: Doc-first — write all four docs before code

**Files:**
- Modify: `docs/L2/governance-core.md`, `docs/L2/governance-defaults.md`
- Create: `docs/L2/tui.md` (only if missing — verify first), `docs/architecture/governance-tui-bridge.md`

- [ ] **Step 1: Verify doc paths**

```bash
ls docs/L2/governance-core.md docs/L2/governance-defaults.md docs/L2/tui.md 2>&1
```

If `tui.md` missing, plan creates it. Otherwise modify-in-place.

- [ ] **Step 2: Append `perVariableThresholds` section to `docs/L2/governance-core.md`**

Append at end of file:

```markdown
## Per-variable alert thresholds (gov-9)

By default, `alertThresholds` (e.g., `[0.8, 0.95]`) applies uniformly to every
sensor. For finer control, pass `perVariableThresholds`:

\`\`\`typescript
createGovernanceMiddleware({
  controller, backend, cost,
  alertThresholds: [0.8, 0.95],          // global default
  perVariableThresholds: {
    cost_usd: [0.5, 0.75, 0.95],         // override for cost only
    error_rate: [0.3, 0.5],              // earlier alerts on errors
  },
  onAlert: (pct, variable, reading) => { /* … */ },
});
\`\`\`

Lookup order: `perVariableThresholds[reading.name]` → `alertThresholds`. The
`@koi/governance-core` alert tracker dedups per `(sessionId, variable, threshold)`,
so adding more thresholds for one variable does NOT re-fire global ones.
```

- [ ] **Step 3: Append `describeRules` section to `docs/L2/governance-defaults.md`**

```markdown
## `describeRules()` — backend introspection (gov-9)

The pattern-backend implements the optional `describeRules?()` method on
`GovernanceBackend` so `/governance` can render the active rule set:

\`\`\`typescript
const backend = createPatternBackend({ rules: [...] });
const descriptors = await backend.describeRules?.();
// readonly { id: string; description: string; effect: "allow" | "deny" | "advise"; pattern?: string }[]
\`\`\`

Backends that do not implement `describeRules` simply omit the rules section
in the TUI view. Required for: `@koi/tui` `/governance` view.
```

- [ ] **Step 4: Append `/governance` section to `docs/L2/tui.md`** (create if missing)

If creating, scaffold with the standard L2 header, then append:

```markdown
## /governance — governance surface (gov-9)

When a `GovernanceController` is wired through the host bridge, the TUI
exposes:

1. **Status-line chip** — single composite cell on the right showing the most
   stressed sensor: `gov: turn 12/50` (green), `gov: cost $1.40/$2.00` (yellow),
   `⚠ gov: spawn 4/5` (red ≥80%). Hidden when no controller is attached.
2. **Toast overlay** — top-right transient notification when `onAlert` fires
   ("⚠ 80% of cost budget — $1.60 / $2.00"). Auto-dismisses after 8s. Multiple
   alerts queue (max 3 visible). Fold-merge by `(variable, threshold)` key —
   re-firing the same key replaces rather than stacks.
3. **`/governance` view** — full-screen, four sections:
   - **Sensors** — table of `(variable, current, limit, utilization%, healthy?)`.
   - **Recent alerts** — last 10 from `~/.koi/governance-alerts.jsonl` (capped at 200).
   - **Active rules** — from `backend.describeRules?()`; section omitted if backend doesn't expose them.
   - **Middleware capabilities** — `mw.describeCapabilities(ctx)` output for governance MW.
4. **`/governance reset`** — clears the per-session `firedThresholds` set so
   re-crossing fires alerts again. No state mutation beyond dedup tracking.

The TUI is read-only — it never calls `controller.record()` or mutates a
backend. All updates flow from the host bridge via store actions.
```

- [ ] **Step 5: Create `docs/architecture/governance-tui-bridge.md`**

```markdown
# Governance TUI bridge

> Sister doc to `docs/architecture/cost-bridge.md`. Same pattern: host owns the
> bridge, TUI is render-only.

## Inputs (subscriptions)

The bridge subscribes to `@koi/governance-core` callbacks:

- `onAlert(pct, variable, reading)` → dispatch `add_governance_alert`
- `onViolation(verdict, request)` → dispatch `add_governance_violation`
- After every engine `done` event (same hook as `cost-bridge.recordEngineDone`),
  call `controller.snapshot()` and dispatch `set_governance_snapshot`.

## Outputs (TUI actions)

- `set_governance_snapshot { snapshot: GovernanceSnapshot }`
- `add_governance_alert { alert: GovernanceAlert }`
- `add_governance_violation { violation: GovernanceViolation }`
- `clear_governance_alerts` (fired by `/governance reset`)
- `set_governance_rules { rules: readonly RuleDescriptor[] }` — once at startup
- `set_governance_capabilities { capabilities: readonly CapabilityFragmentLite[] }` — once at startup

## Persistence

Append-only JSONL at `~/.koi/governance-alerts.jsonl`. Each line:

\`\`\`json
{"ts":1745000000,"sessionId":"…","variable":"cost_usd","threshold":0.8,"current":1.6,"limit":2.0,"utilization":0.8}
\`\`\`

Tail-evict to last 200 lines on bridge startup. On `/governance` open, the TUI
already has alerts in-memory for the current session; persisted alerts seed
the "Recent alerts" section.

## Error handling

- Alert-write failure → `console.warn`, never throw. Bridge must not block
  governance-core flow.
- Snapshot poll failure → log + skip; previous snapshot stays in store.
- Backend `describeRules` failure → log + omit rules section.

## Lifecycle

- Created in `tui-command.ts` after `createCostBridge`.
- `dispose()` closes the JSONL writer and unsubscribes.
```

- [ ] **Step 6: Commit**

```bash
git add docs/L2/governance-core.md docs/L2/governance-defaults.md docs/L2/tui.md docs/architecture/governance-tui-bridge.md
git commit -m "docs(gov-9): scaffold L2 + arch docs for TUI governance surface

Per Doc → Tests → Code workflow. Locks the contract for:
- per-variable alert thresholds (governance-core)
- describeRules optional backend method (governance-defaults)
- /governance view, toast, status chip (tui)
- bridge subscription/dispatch/persistence (architecture)

Refs #1876"
```

---

## Task 2: L0 — add `RuleDescriptor` + `describeRules?()` to `GovernanceBackend`

**Files:**
- Modify: `packages/kernel/core/src/governance-backend.ts:281-292`

- [ ] **Step 1: Write the failing test**

Append to `packages/kernel/core/src/__tests__/types.test.ts`:

```typescript
import type { GovernanceBackend, RuleDescriptor } from "../governance-backend.js";

test("RuleDescriptor has required fields", () => {
  const r: RuleDescriptor = {
    id: "deny-prod-writes",
    description: "Deny writes to production paths",
    effect: "deny",
    pattern: "/prod/**",
  };
  expect(r.id).toBe("deny-prod-writes");
  expect(r.effect).toBe("deny");
});

test("GovernanceBackend.describeRules is optional", () => {
  const b: GovernanceBackend = {
    evaluator: { evaluate: async () => ({ allowed: true }) },
  };
  expect(b.describeRules).toBeUndefined();
});

test("GovernanceBackend.describeRules can be implemented", async () => {
  const b: GovernanceBackend = {
    evaluator: { evaluate: async () => ({ allowed: true }) },
    describeRules: () => [
      { id: "r1", description: "test", effect: "advise" } satisfies RuleDescriptor,
    ],
  };
  const rules = await b.describeRules!();
  expect(rules).toHaveLength(1);
  expect(rules[0]?.id).toBe("r1");
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test packages/kernel/core/src/__tests__/types.test.ts -t "RuleDescriptor"
```

Expected: FAIL with "Cannot find name 'RuleDescriptor'" or similar.

- [ ] **Step 3: Add `RuleDescriptor` and extend `GovernanceBackend`**

Edit `packages/kernel/core/src/governance-backend.ts`. Add before the `GovernanceBackend` interface (around line 264):

```typescript
// ---------------------------------------------------------------------------
// RuleDescriptor — read-only describe-rules output (gov-9)
// ---------------------------------------------------------------------------

/**
 * Human-readable summary of a single backend rule. Used by `/governance`
 * to render the active rule set; backends that don't expose rules omit the
 * section. Pattern is optional because not all backends use glob/regex rules.
 */
export interface RuleDescriptor {
  readonly id: string;
  readonly description: string;
  readonly effect: "allow" | "deny" | "advise";
  readonly pattern?: string | undefined;
}
```

Then in the `GovernanceBackend` interface body, add (after `dispose?`):

```typescript
  /**
   * Optional rule introspection for read-only UIs (e.g., `/governance` view).
   * Backends that don't expose rules can omit this. Errors should propagate;
   * callers must wrap in try/catch and degrade gracefully.
   */
  readonly describeRules?: () =>
    | readonly RuleDescriptor[]
    | Promise<readonly RuleDescriptor[]>;
```

- [ ] **Step 4: Add `RuleDescriptor` to package exports**

Verify exports in `packages/kernel/core/src/index.ts` — `RuleDescriptor` should be re-exported alongside `GovernanceBackend`. If not, add it. Run:

```bash
grep -n "GovernanceBackend\|RuleDescriptor" packages/kernel/core/src/index.ts
```

If only `GovernanceBackend` is there, add `RuleDescriptor` to the same export line.

- [ ] **Step 5: Run tests — expect PASS**

```bash
bun test packages/kernel/core/src/__tests__/types.test.ts -t "RuleDescriptor"
```

Expected: 3 tests pass.

- [ ] **Step 6: Snapshot the API surface**

```bash
bun test packages/kernel/core/src/__tests__/exports.test.ts -u
```

Expected: snapshot updated to include `RuleDescriptor`. Diff the snapshot to verify the addition is the only change.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/core/src/governance-backend.ts packages/kernel/core/src/index.ts packages/kernel/core/src/__tests__/types.test.ts packages/kernel/core/src/__tests__/__snapshots__/api-surface.test.ts.snap
git commit -m "feat(core): add RuleDescriptor + describeRules?() to GovernanceBackend

Optional read-only rule introspection so governance UIs (TUI /governance
view) can render the active rule set without coupling to a specific
backend implementation. Returns empty/undefined → section is omitted.

Refs #1876"
```

---

## Task 3: `governance-defaults` — implement `describeRules` in pattern-backend

**Files:**
- Modify: `packages/security/governance-defaults/src/pattern-backend.ts`
- Test: `packages/security/governance-defaults/src/pattern-backend.test.ts` (create if absent)

- [ ] **Step 1: Read pattern-backend to understand rule shape**

```bash
sed -n '1,60p' packages/security/governance-defaults/src/pattern-backend.ts
```

Note the existing `Rule` / `PatternRule` interface (whatever it's called) — we'll map it to `RuleDescriptor`.

- [ ] **Step 2: Write the failing test**

Add to `packages/security/governance-defaults/src/__tests__/pattern-backend.test.ts` (or create the file):

```typescript
import { describe, expect, test } from "bun:test";
import { createPatternBackend } from "../pattern-backend.js";

describe("createPatternBackend describeRules", () => {
  test("returns RuleDescriptor[] for configured rules", async () => {
    const backend = createPatternBackend({
      rules: [
        { id: "deny-rm-rf", pattern: "rm -rf /*", effect: "deny", description: "block dangerous shell" },
        { id: "advise-curl", pattern: "curl *", effect: "advise", description: "warn on curl" },
      ],
    });
    const out = await backend.describeRules!();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "deny-rm-rf",
      description: "block dangerous shell",
      effect: "deny",
      pattern: "rm -rf /*",
    });
  });

  test("returns empty array when backend has no rules", async () => {
    const backend = createPatternBackend({ rules: [] });
    expect(await backend.describeRules!()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
bun test packages/security/governance-defaults/src/__tests__/pattern-backend.test.ts -t "describeRules"
```

- [ ] **Step 4: Implement `describeRules` in pattern-backend**

In `pattern-backend.ts`, find the `return { evaluator, ... }` object inside `createPatternBackend` and add:

```typescript
    describeRules: () =>
      config.rules.map((r) => ({
        id: r.id,
        description: r.description ?? r.id,
        effect: r.effect,
        pattern: r.pattern,
      })),
```

If the backend stores rules in a different field, adapt the source accordingly. Verify type is `RuleDescriptor[]` by importing `import type { RuleDescriptor } from "@koi/core/governance-backend"`.

- [ ] **Step 5: Run — expect PASS**

```bash
bun test packages/security/governance-defaults/src/__tests__/pattern-backend.test.ts -t "describeRules"
```

- [ ] **Step 6: Commit**

```bash
git add packages/security/governance-defaults/src/pattern-backend.ts packages/security/governance-defaults/src/__tests__/pattern-backend.test.ts
git commit -m "feat(governance-defaults): implement describeRules in pattern-backend

Returns the backend's configured rules as RuleDescriptor[] for
introspection by the TUI /governance view. Empty config → empty array.

Refs #1876"
```

---

## Task 4: `governance-core` — per-variable alert thresholds

**Files:**
- Modify: `packages/security/governance-core/src/config.ts`
- Modify: `packages/security/governance-core/src/alert-tracker.ts`
- Modify: `packages/security/governance-core/src/governance-middleware.ts` (pass through to alertTracker)
- Modify: `packages/security/governance-core/src/alert-tracker.test.ts`

- [ ] **Step 1: Failing test for per-variable thresholds in `alert-tracker.test.ts`**

Append:

```typescript
test("per-variable thresholds override global thresholds", () => {
  const fired: Array<[number, string]> = [];
  const tracker = createAlertTracker({
    thresholds: [0.8],
    perVariableThresholds: { cost_usd: [0.5, 0.95] },
  });
  const snap: GovernanceSnapshot = {
    timestamp: Date.now(),
    healthy: true,
    violations: [],
    readings: [
      { name: "cost_usd", current: 0.55, limit: 1.0, utilization: 0.55 },
      { name: "turn_count", current: 8, limit: 10, utilization: 0.8 },
    ],
  };
  tracker.checkAndFire("s1", snap, (pct, v) => fired.push([pct, v]));
  expect(fired).toEqual([
    [0.55, "cost_usd"],   // 0.5 per-var threshold
    [0.8, "turn_count"],  // global 0.8
  ]);
});

test("per-variable threshold dedup is independent from global", () => {
  const fired: string[] = [];
  const tracker = createAlertTracker({
    thresholds: [0.8],
    perVariableThresholds: { cost_usd: [0.8] },
  });
  const snap: GovernanceSnapshot = {
    timestamp: Date.now(), healthy: true, violations: [],
    readings: [{ name: "cost_usd", current: 0.85, limit: 1.0, utilization: 0.85 }],
  };
  tracker.checkAndFire("s1", snap, (_, v) => fired.push(v));
  tracker.checkAndFire("s1", snap, (_, v) => fired.push(v));
  expect(fired).toEqual(["cost_usd"]); // fires once across both calls
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/security/governance-core/src/alert-tracker.test.ts -t "per-variable"
```

- [ ] **Step 3: Extend `AlertTrackerConfig` and the lookup**

Edit `packages/security/governance-core/src/alert-tracker.ts`:

```typescript
export interface AlertTrackerConfig {
  readonly thresholds: readonly number[];
  readonly perVariableThresholds?: Record<string, readonly number[]> | undefined;
}

export function createAlertTracker(config: AlertTrackerConfig): AlertTracker {
  const sortedGlobal = [...config.thresholds].sort((a, b) => a - b);
  const sortedPerVar = new Map<string, readonly number[]>();
  if (config.perVariableThresholds !== undefined) {
    for (const [v, ts] of Object.entries(config.perVariableThresholds)) {
      sortedPerVar.set(v, [...ts].sort((a, b) => a - b));
    }
  }
  const fired = new Map<string, Set<string>>();

  function thresholdsFor(variable: string): readonly number[] {
    return sortedPerVar.get(variable) ?? sortedGlobal;
  }

  function firedKey(variable: string, threshold: number): string {
    return `${variable}@${threshold}`;
  }

  function getFiredSet(sessionId: string): Set<string> {
    const existing = fired.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = new Set<string>();
    fired.set(sessionId, fresh);
    return fresh;
  }

  return {
    checkAndFire(sessionId, snapshot, onAlert) {
      if (onAlert === undefined) return;
      const firedSet = getFiredSet(sessionId);
      for (const reading of snapshot.readings) {
        for (const threshold of thresholdsFor(reading.name)) {
          const key = firedKey(reading.name, threshold);
          if (reading.utilization >= threshold && !firedSet.has(key)) {
            firedSet.add(key);
            onAlert(reading.utilization, reading.name, reading);
          }
        }
      }
    },
    cleanup(sessionId) {
      fired.delete(sessionId);
    },
  };
}
```

- [ ] **Step 4: Add `perVariableThresholds` to `GovernanceMiddlewareConfig` in `config.ts`**

```typescript
export interface GovernanceMiddlewareConfig {
  readonly backend: GovernanceBackend;
  readonly controller: GovernanceController;
  readonly cost: CostCalculator;
  readonly alertThresholds?: readonly number[];
  readonly perVariableThresholds?: Record<string, readonly number[]>;
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
}
```

Update `validateGovernanceConfig` after the existing `alertThresholds` validation block:

```typescript
  if (c.perVariableThresholds !== undefined) {
    if (typeof c.perVariableThresholds !== "object" || c.perVariableThresholds === null) {
      return { ok: false, error: err("perVariableThresholds must be an object") };
    }
    for (const [variable, thresholds] of Object.entries(c.perVariableThresholds)) {
      if (!Array.isArray(thresholds)) {
        return { ok: false, error: err("perVariableThresholds[v] must be an array", { variable }) };
      }
      for (const t of thresholds) {
        if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
          return {
            ok: false,
            error: err("perVariableThresholds value must be in (0, 1]", { variable, threshold: t }),
          };
        }
      }
    }
  }
```

- [ ] **Step 5: Wire pass-through in `governance-middleware.ts`**

Find the existing `createAlertTracker(...)` call and add `perVariableThresholds` to the config object. Search for the call:

```bash
grep -n "createAlertTracker" packages/security/governance-core/src/governance-middleware.ts
```

Replace its config object (current shape `{ thresholds: ... }`) with `{ thresholds: ..., perVariableThresholds: config.perVariableThresholds }`.

- [ ] **Step 6: Run — expect PASS**

```bash
bun test packages/security/governance-core
```

Expected: all pass including the 2 new cases.

- [ ] **Step 7: Commit**

```bash
git add packages/security/governance-core
git commit -m "feat(governance-core): per-variable alert thresholds

Allow per-sensor threshold overrides without losing global defaults.
e.g., cost_usd: [0.5, 0.75, 0.95] with global [0.8].
Dedup is independent per (variable, threshold) pair.

Refs #1876"
```

---

## Task 5: TUI state — add governance fields and 6 new actions

**Files:**
- Modify: `packages/ui/tui/src/state/types.ts`
- Modify: `packages/ui/tui/src/state/reduce.ts`
- Modify: `packages/ui/tui/src/state/reduce.test.ts` (new cases)

- [ ] **Step 1: Failing reducer test**

Append to `packages/ui/tui/src/state/reduce.test.ts`:

```typescript
import type { GovernanceSnapshot, RuleDescriptor } from "@koi/core";

describe("governance actions", () => {
  test("set_governance_snapshot stores readings", () => {
    const snap: GovernanceSnapshot = {
      timestamp: 1, healthy: true, violations: [],
      readings: [{ name: "turn_count", current: 5, limit: 10, utilization: 0.5 }],
    };
    const next = reduce(initialState, { kind: "set_governance_snapshot", snapshot: snap });
    expect(next.governance.snapshot?.readings).toHaveLength(1);
  });

  test("add_governance_alert appends and caps at MAX_ALERTS_IN_MEMORY", () => {
    const alert = { id: "a1", ts: 1, sessionId: "s", variable: "cost_usd", threshold: 0.8, current: 1.6, limit: 2, utilization: 0.8 };
    const next = reduce(initialState, { kind: "add_governance_alert", alert });
    expect(next.governance.alerts).toHaveLength(1);
    expect(next.governance.alerts[0]?.id).toBe("a1");
  });

  test("clear_governance_alerts empties array", () => {
    const seeded = reduce(initialState, {
      kind: "add_governance_alert",
      alert: { id: "x", ts: 0, sessionId: "s", variable: "cost_usd", threshold: 0.8, current: 1, limit: 2, utilization: 0.5 },
    });
    expect(seeded.governance.alerts).toHaveLength(1);
    const cleared = reduce(seeded, { kind: "clear_governance_alerts" });
    expect(cleared.governance.alerts).toHaveLength(0);
  });

  test("add_toast appends; dismiss_toast removes by id", () => {
    const t = { id: "t1", kind: "warn" as const, key: "k", title: "x", body: "y", ts: 1 };
    const a = reduce(initialState, { kind: "add_toast", toast: t });
    expect(a.toasts).toHaveLength(1);
    const b = reduce(a, { kind: "dismiss_toast", id: "t1" });
    expect(b.toasts).toHaveLength(0);
  });

  test("add_toast fold-merges by key (same key replaces)", () => {
    const t1 = { id: "t1", kind: "warn" as const, key: "cost@0.8", title: "x", body: "1.6", ts: 1 };
    const t2 = { id: "t2", kind: "warn" as const, key: "cost@0.8", title: "x", body: "1.7", ts: 2 };
    const a = reduce(initialState, { kind: "add_toast", toast: t1 });
    const b = reduce(a, { kind: "add_toast", toast: t2 });
    expect(b.toasts).toHaveLength(1);
    expect(b.toasts[0]?.id).toBe("t2");
    expect(b.toasts[0]?.body).toBe("1.7");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/ui/tui/src/state/reduce.test.ts -t "governance actions"
```

- [ ] **Step 3: Extend `TuiState` in `types.ts`**

Locate the import block at the top of `types.ts` and add:

```typescript
import type { GovernanceSnapshot, RuleDescriptor } from "@koi/core";
```

Add new types before the `TuiState` interface (around line 343):

```typescript
// ---------------------------------------------------------------------------
// Governance (gov-9)
// ---------------------------------------------------------------------------

export interface GovernanceAlert {
  readonly id: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly variable: string;
  readonly threshold: number;
  readonly current: number;
  readonly limit: number;
  readonly utilization: number;
}

export interface GovernanceViolation {
  readonly id: string;
  readonly ts: number;
  readonly variable: string;
  readonly reason: string;
}

export interface CapabilityFragmentLite {
  readonly label: string;
  readonly description: string;
}

export interface GovernanceSlice {
  readonly snapshot: GovernanceSnapshot | null;
  readonly alerts: readonly GovernanceAlert[];
  readonly violations: readonly GovernanceViolation[];
  readonly rules: readonly RuleDescriptor[];
  readonly capabilities: readonly CapabilityFragmentLite[];
}

export type ToastKind = "info" | "warn" | "error";

export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly key: string;            // fold-merge key
  readonly title: string;
  readonly body: string;
  readonly ts: number;
  readonly autoDismissMs?: number; // default 8000
}

export const MAX_ALERTS_IN_MEMORY = 200;
export const MAX_VISIBLE_TOASTS = 3;
export const MAX_VIOLATIONS_IN_MEMORY = 50;
```

In the `TuiState` interface, append (before the closing brace):

```typescript
  /** Governance read-only mirror — populated by the host bridge (gov-9). */
  readonly governance: GovernanceSlice;
  /** Active toast queue (gov-9). FIFO display, capped at MAX_VISIBLE_TOASTS. */
  readonly toasts: readonly Toast[];
```

In the `TuiAction` union, append:

```typescript
  | { readonly kind: "set_governance_snapshot"; readonly snapshot: GovernanceSnapshot }
  | { readonly kind: "add_governance_alert"; readonly alert: GovernanceAlert }
  | { readonly kind: "add_governance_violation"; readonly violation: GovernanceViolation }
  | { readonly kind: "clear_governance_alerts" }
  | { readonly kind: "set_governance_rules"; readonly rules: readonly RuleDescriptor[] }
  | { readonly kind: "set_governance_capabilities"; readonly capabilities: readonly CapabilityFragmentLite[] }
  | { readonly kind: "add_toast"; readonly toast: Toast }
  | { readonly kind: "dismiss_toast"; readonly id: string }
```

- [ ] **Step 4: Update `INITIAL_STATE` in `types.ts`**

```bash
grep -n "INITIAL_STATE\|initialState" packages/ui/tui/src/state/types.ts | head
```

Add fields to the initial state literal:

```typescript
  governance: { snapshot: null, alerts: [], violations: [], rules: [], capabilities: [] },
  toasts: [],
```

- [ ] **Step 5: Implement reducer cases in `reduce.ts`**

Find the existing `switch (action.kind)` block and add cases:

```typescript
    case "set_governance_snapshot":
      return { ...state, governance: { ...state.governance, snapshot: action.snapshot } };

    case "add_governance_alert": {
      const next = [action.alert, ...state.governance.alerts].slice(0, MAX_ALERTS_IN_MEMORY);
      return { ...state, governance: { ...state.governance, alerts: next } };
    }

    case "add_governance_violation": {
      const next = [action.violation, ...state.governance.violations].slice(0, MAX_VIOLATIONS_IN_MEMORY);
      return { ...state, governance: { ...state.governance, violations: next } };
    }

    case "clear_governance_alerts":
      return { ...state, governance: { ...state.governance, alerts: [] } };

    case "set_governance_rules":
      return { ...state, governance: { ...state.governance, rules: action.rules } };

    case "set_governance_capabilities":
      return { ...state, governance: { ...state.governance, capabilities: action.capabilities } };

    case "add_toast": {
      const without = state.toasts.filter((t) => t.key !== action.toast.key);
      const next = [...without, action.toast].slice(-MAX_VISIBLE_TOASTS);
      return { ...state, toasts: next };
    }

    case "dismiss_toast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
```

Add the imports to `reduce.ts`:

```typescript
import { MAX_ALERTS_IN_MEMORY, MAX_VIOLATIONS_IN_MEMORY, MAX_VISIBLE_TOASTS } from "./types.js";
```

- [ ] **Step 6: Run — expect PASS**

```bash
bun test packages/ui/tui/src/state/reduce.test.ts
```

Expected: ALL PASS including 5 new governance/toast cases.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/tui/src/state
git commit -m "feat(tui): governance + toast state slices

Adds GovernanceSlice (snapshot, alerts, violations, rules, capabilities)
and Toast queue (max 3 visible, fold-merge by key) to TuiState. Six new
action kinds wired in the reducer. All read-only — TUI never mutates
governance state, just renders what the host bridge dispatches.

Refs #1876"
```

---

## Task 6: TUI Toast component

**Files:**
- Create: `packages/ui/tui/src/components/Toast.tsx`
- Create: `packages/ui/tui/src/components/Toast.test.tsx`

- [ ] **Step 1: Failing component test**

Create `packages/ui/tui/src/components/Toast.test.tsx`:

```typescript
import { describe, expect, test } from "bun:test";
import { renderToString } from "../test-utils/render.js"; // adapt to existing harness
import { ToastOverlay } from "./Toast.js";

describe("ToastOverlay", () => {
  test("renders nothing when toasts array is empty", () => {
    const out = renderToString(() => <ToastOverlay toasts={[]} onDismiss={() => {}} />);
    expect(out).toBe("");
  });

  test("renders title + body for each toast", () => {
    const out = renderToString(() => (
      <ToastOverlay
        toasts={[
          { id: "t1", kind: "warn", key: "k", title: "Budget alert", body: "$1.60 / $2.00", ts: 0 },
        ]}
        onDismiss={() => {}}
      />
    ));
    expect(out).toContain("Budget alert");
    expect(out).toContain("$1.60 / $2.00");
  });

  test("warn kind uses warning glyph", () => {
    const out = renderToString(() => (
      <ToastOverlay
        toasts={[{ id: "t1", kind: "warn", key: "k", title: "x", body: "y", ts: 0 }]}
        onDismiss={() => {}}
      />
    ));
    expect(out).toContain("⚠");
  });
});
```

If `test-utils/render.js` doesn't exist, use the same harness used by other component tests in this dir — check `packages/ui/tui/src/components/StatusBar.test.ts` for the pattern.

- [ ] **Step 2: Run — expect FAIL** (no Toast component yet)

```bash
bun test packages/ui/tui/src/components/Toast.test.tsx
```

- [ ] **Step 3: Implement `Toast.tsx`**

Create `packages/ui/tui/src/components/Toast.tsx`:

```typescript
import { For, onCleanup, onMount, type Component } from "solid-js";
import type { Toast } from "../state/types.js";
import { useTheme } from "../theme.js";

const DEFAULT_AUTO_DISMISS_MS = 8000;

const GLYPH: Record<Toast["kind"], string> = {
  info: "ⓘ",
  warn: "⚠",
  error: "✗",
};

export interface ToastOverlayProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
}

export const ToastOverlay: Component<ToastOverlayProps> = (props) => {
  const theme = useTheme();
  return (
    <box position="absolute" top={0} right={2} flexDirection="column" zIndex={100}>
      <For each={props.toasts}>
        {(toast) => <ToastRow toast={toast} onDismiss={props.onDismiss} theme={theme} />}
      </For>
    </box>
  );
};

interface ToastRowProps {
  readonly toast: Toast;
  readonly onDismiss: (id: string) => void;
  readonly theme: ReturnType<typeof useTheme>;
}

const ToastRow: Component<ToastRowProps> = (props) => {
  onMount(() => {
    const ms = props.toast.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
    const t = setTimeout(() => props.onDismiss(props.toast.id), ms);
    onCleanup(() => clearTimeout(t));
  });

  const color =
    props.toast.kind === "error"
      ? props.theme.errorFg
      : props.toast.kind === "warn"
        ? props.theme.warningFg
        : props.theme.accentFg;

  return (
    <box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <text color={color}>
        {GLYPH[props.toast.kind]} {props.toast.title}
      </text>
      <text color={props.theme.dimFg}>{props.toast.body}</text>
    </box>
  );
};
```

(If theme keys differ in `theme.ts`, substitute the actual export names. Run `grep -n "errorFg\|warningFg\|accentFg\|dimFg" packages/ui/tui/src/theme.ts` to verify.)

- [ ] **Step 4: Run — expect PASS**

```bash
bun test packages/ui/tui/src/components/Toast.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/components/Toast.tsx packages/ui/tui/src/components/Toast.test.tsx
git commit -m "feat(tui): Toast overlay primitive

Top-right transient notification overlay. Auto-dismiss after
autoDismissMs (default 8s). info/warn/error variants with glyph + color.
Caller passes the toasts array; reducer enforces max-3 + fold-merge by key.

Refs #1876"
```

---

## Task 7: Render `<ToastOverlay>` from `TuiRoot` and wire dismiss

**Files:**
- Modify: `packages/ui/tui/src/tui-root.tsx`

- [ ] **Step 1: Find a stable mount point**

```bash
grep -n "</TuiShell>\|</box>" packages/ui/tui/src/tui-root.tsx | tail -10
```

Identify the outermost render box. ToastOverlay sits inside it as the LAST child so it renders on top.

- [ ] **Step 2: Add the overlay**

In `tui-root.tsx`, add to the imports:

```typescript
import { ToastOverlay } from "./components/Toast.js";
```

Inside the JSX root, add as the last child before the closing tag:

```tsx
<ToastOverlay
  toasts={toasts()}
  onDismiss={(id) => store.dispatch({ kind: "dismiss_toast", id })}
/>
```

Add the selector at the top of the component:

```typescript
const toasts = useTuiStore((s) => s.toasts);
```

- [ ] **Step 3: Verify by snapshot test**

```bash
bun test packages/ui/tui/src/tui-root.test.tsx
```

Existing snapshots may update. Inspect the diff — only the new `<box position="absolute" ...>` should appear.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/tui/src/tui-root.tsx packages/ui/tui/src/__snapshots__/
git commit -m "feat(tui): mount ToastOverlay from TuiRoot

Reads s.toasts; dispatches dismiss_toast on auto-dismiss timer expiry.

Refs #1876"
```

---

## Task 8: StatusBar — governance chip showing most-stressed sensor

**Files:**
- Modify: `packages/ui/tui/src/components/StatusBar.tsx`
- Modify: `packages/ui/tui/src/components/status-bar-helpers.ts`
- Modify: `packages/ui/tui/src/components/StatusBar.test.ts`

- [ ] **Step 1: Failing test**

Append to `StatusBar.test.ts`:

```typescript
import type { GovernanceSnapshot } from "@koi/core";
import { mostStressedSensor, formatGovernanceChip } from "./status-bar-helpers.js";

describe("mostStressedSensor", () => {
  test("returns null when snapshot is null", () => {
    expect(mostStressedSensor(null)).toBeNull();
  });

  test("picks reading with highest utilization", () => {
    const snap: GovernanceSnapshot = {
      timestamp: 0, healthy: true, violations: [],
      readings: [
        { name: "turn_count", current: 5, limit: 10, utilization: 0.5 },
        { name: "cost_usd", current: 1.6, limit: 2.0, utilization: 0.8 },
        { name: "spawn_count", current: 1, limit: 5, utilization: 0.2 },
      ],
    };
    expect(mostStressedSensor(snap)?.name).toBe("cost_usd");
  });
});

describe("formatGovernanceChip", () => {
  test("turn_count uses N/N format", () => {
    expect(
      formatGovernanceChip({ name: "turn_count", current: 12, limit: 50, utilization: 0.24 }),
    ).toBe("turn 12/50");
  });

  test("cost_usd uses $X.XX/$X.XX format", () => {
    expect(
      formatGovernanceChip({ name: "cost_usd", current: 1.4, limit: 2.0, utilization: 0.7 }),
    ).toBe("cost $1.40/$2.00");
  });

  test("generic variable uses utilization %", () => {
    expect(
      formatGovernanceChip({ name: "error_rate", current: 0.3, limit: 0.5, utilization: 0.6 }),
    ).toBe("error_rate 60%");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/ui/tui/src/components/StatusBar.test.ts -t "mostStressedSensor\|formatGovernanceChip"
```

- [ ] **Step 3: Implement helpers in `status-bar-helpers.ts`**

Replace file contents (current is only 212B):

```typescript
import type { GovernanceSnapshot, SensorReading } from "@koi/core";

export function mostStressedSensor(snapshot: GovernanceSnapshot | null): SensorReading | null {
  if (snapshot === null || snapshot.readings.length === 0) return null;
  let top: SensorReading = snapshot.readings[0]!;
  for (const r of snapshot.readings) {
    if (r.utilization > top.utilization) top = r;
  }
  return top;
}

export function formatGovernanceChip(reading: SensorReading): string {
  switch (reading.name) {
    case "turn_count":
      return `turn ${reading.current}/${reading.limit}`;
    case "spawn_count":
      return `spawn ${reading.current}/${reading.limit}`;
    case "spawn_depth":
      return `depth ${reading.current}/${reading.limit}`;
    case "cost_usd":
      return `cost $${reading.current.toFixed(2)}/$${reading.limit.toFixed(2)}`;
    case "token_usage":
      return `tokens ${formatCount(reading.current)}/${formatCount(reading.limit)}`;
    default:
      return `${reading.name} ${Math.round(reading.utilization * 100)}%`;
  }
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Color tier for chip display: "ok" <0.5, "warn" 0.5-0.8, "danger" >=0.8. */
export function chipTier(util: number): "ok" | "warn" | "danger" {
  if (util >= 0.8) return "danger";
  if (util >= 0.5) return "warn";
  return "ok";
}
```

(Preserve any other exports already in the file by appending instead of overwriting if non-empty. Run `cat` first to verify.)

- [ ] **Step 4: Run helper tests — expect PASS**

```bash
bun test packages/ui/tui/src/components/StatusBar.test.ts -t "mostStressedSensor\|formatGovernanceChip"
```

- [ ] **Step 5: Render the chip in `StatusBar.tsx`**

Add the import:

```typescript
import { mostStressedSensor, formatGovernanceChip, chipTier } from "./status-bar-helpers.js";
```

Add the selector with the existing ones (around line 77-83):

```typescript
const governance = useTuiStore((s) => s.governance.snapshot);
```

In the right-side flex group (around line 146-151), insert before `AgentStatusChip`:

```tsx
{(() => {
  const top = mostStressedSensor(governance());
  if (top === null) return null;
  const tier = chipTier(top.utilization);
  const color =
    tier === "danger" ? theme.errorFg : tier === "warn" ? theme.warningFg : theme.dimFg;
  const prefix = tier === "danger" ? "⚠ " : "";
  return (
    <text color={color} marginRight={1}>
      {prefix}gov: {formatGovernanceChip(top)}
    </text>
  );
})()}
```

- [ ] **Step 6: Run StatusBar tests + snapshot**

```bash
bun test packages/ui/tui/src/components/StatusBar.test.ts
```

Inspect snapshot diff. Should show new `gov:` chip when snapshot is non-null, nothing when null.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/tui/src/components/StatusBar.tsx packages/ui/tui/src/components/status-bar-helpers.ts packages/ui/tui/src/components/StatusBar.test.ts
git commit -m "feat(tui): governance status-line chip

Single composite chip on the right showing the most-stressed sensor.
Hidden when snapshot is null. Color tier: green <50% / yellow 50-80% /
red ≥80% with ⚠ prefix.

Refs #1876"
```

---

## Task 9: GovernanceView component

**Files:**
- Create: `packages/ui/tui/src/components/GovernanceView.tsx`
- Create: `packages/ui/tui/src/components/GovernanceView.test.tsx`

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { renderToString } from "../test-utils/render.js";
import { GovernanceView } from "./GovernanceView.js";
import type { GovernanceSlice } from "../state/types.js";

const seed: GovernanceSlice = {
  snapshot: {
    timestamp: 1, healthy: true, violations: [],
    readings: [
      { name: "turn_count", current: 12, limit: 50, utilization: 0.24 },
      { name: "cost_usd", current: 1.6, limit: 2.0, utilization: 0.8 },
    ],
  },
  alerts: [
    { id: "a1", ts: 1, sessionId: "s1", variable: "cost_usd", threshold: 0.8, current: 1.6, limit: 2, utilization: 0.8 },
  ],
  violations: [],
  rules: [{ id: "r1", description: "block rm -rf", effect: "deny" }],
  capabilities: [{ label: "governance", description: "tracks 5 sensors" }],
};

describe("GovernanceView", () => {
  test("renders sensor table headers and rows", () => {
    const out = renderToString(() => <GovernanceView slice={seed} />);
    expect(out).toContain("Variable");
    expect(out).toContain("turn_count");
    expect(out).toContain("12 / 50");
    expect(out).toContain("cost_usd");
    expect(out).toContain("80%");
  });

  test("renders Recent alerts section with alert", () => {
    const out = renderToString(() => <GovernanceView slice={seed} />);
    expect(out).toContain("Recent alerts");
    expect(out).toContain("cost_usd");
  });

  test("renders Active rules when rules present", () => {
    const out = renderToString(() => <GovernanceView slice={seed} />);
    expect(out).toContain("Active rules");
    expect(out).toContain("block rm -rf");
  });

  test("omits Active rules section when empty", () => {
    const out = renderToString(() => <GovernanceView slice={{ ...seed, rules: [] }} />);
    expect(out).not.toContain("Active rules");
  });

  test("shows empty state when no snapshot", () => {
    const out = renderToString(() => (
      <GovernanceView slice={{ ...seed, snapshot: null, alerts: [], rules: [], capabilities: [] }} />
    ));
    expect(out).toContain("No governance data");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/ui/tui/src/components/GovernanceView.test.tsx
```

- [ ] **Step 3: Implement `GovernanceView.tsx`**

Create the file:

```typescript
import { For, Show, type Component } from "solid-js";
import type { GovernanceSlice } from "../state/types.js";
import type { SensorReading } from "@koi/core";
import { useTheme } from "../theme.js";

const COL_WIDTHS = { name: 18, current: 14, util: 8, healthy: 8 } as const;

export interface GovernanceViewProps {
  readonly slice: GovernanceSlice;
}

export const GovernanceView: Component<GovernanceViewProps> = (props) => {
  const theme = useTheme();
  const empty = (): boolean =>
    props.slice.snapshot === null &&
    props.slice.alerts.length === 0 &&
    props.slice.rules.length === 0 &&
    props.slice.capabilities.length === 0;

  return (
    <box flexDirection="column" padding={1}>
      <text bold color={theme.accentFg}>Governance</text>
      <Show when={empty()}>
        <text color={theme.dimFg}>No governance data — controller not attached.</text>
      </Show>

      <Show when={props.slice.snapshot !== null}>
        <SectionHeader title="Sensors" theme={theme} />
        <SensorTable readings={props.slice.snapshot!.readings} theme={theme} />
      </Show>

      <Show when={props.slice.alerts.length > 0}>
        <SectionHeader title="Recent alerts" theme={theme} />
        <For each={props.slice.alerts.slice(0, 10)}>
          {(a) => (
            <text color={theme.warningFg}>
              ⚠ {a.variable} crossed {Math.round(a.threshold * 100)}% — {a.current.toFixed(2)} / {a.limit.toFixed(2)}
            </text>
          )}
        </For>
      </Show>

      <Show when={props.slice.rules.length > 0}>
        <SectionHeader title="Active rules" theme={theme} />
        <For each={props.slice.rules}>
          {(r) => (
            <text>
              <text color={effectColor(r.effect, theme)}>[{r.effect}]</text>{" "}
              <text>{r.id}</text> <text color={theme.dimFg}>— {r.description}</text>
            </text>
          )}
        </For>
      </Show>

      <Show when={props.slice.capabilities.length > 0}>
        <SectionHeader title="Middleware capabilities" theme={theme} />
        <For each={props.slice.capabilities}>
          {(c) => (
            <text>
              <text bold>{c.label}</text> <text color={theme.dimFg}>— {c.description}</text>
            </text>
          )}
        </For>
      </Show>

      <text color={theme.dimFg}>Esc to close · /governance reset to clear alerts</text>
    </box>
  );
};

const SectionHeader: Component<{ readonly title: string; readonly theme: ReturnType<typeof useTheme> }> = (p) => (
  <box marginTop={1}>
    <text bold color={p.theme.accentFg}>{p.title}</text>
  </box>
);

const SensorTable: Component<{ readonly readings: readonly SensorReading[]; readonly theme: ReturnType<typeof useTheme> }> = (p) => (
  <box flexDirection="column">
    <text color={p.theme.dimFg}>
      {pad("Variable", COL_WIDTHS.name)}{pad("Current", COL_WIDTHS.current)}{pad("Util%", COL_WIDTHS.util)}
    </text>
    <For each={p.readings}>
      {(r) => (
        <text>
          {pad(r.name, COL_WIDTHS.name)}
          {pad(`${formatNum(r.current)} / ${formatNum(r.limit)}`, COL_WIDTHS.current)}
          {pad(`${Math.round(r.utilization * 100)}%`, COL_WIDTHS.util)}
        </text>
      )}
    </For>
  </box>
);

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + " " : s + " ".repeat(w - s.length);
}

function formatNum(n: number): string {
  if (n >= 100) return Math.round(n).toString();
  return n.toFixed(2);
}

function effectColor(
  effect: "allow" | "deny" | "advise",
  theme: ReturnType<typeof useTheme>,
): string {
  return effect === "deny" ? theme.errorFg : effect === "allow" ? theme.successFg ?? theme.accentFg : theme.warningFg;
}
```

(Adapt theme keys to actual exports.)

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test packages/ui/tui/src/components/GovernanceView.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/components/GovernanceView.tsx packages/ui/tui/src/components/GovernanceView.test.tsx
git commit -m "feat(tui): GovernanceView full-screen view

Four sections: Sensors table, Recent alerts (last 10), Active rules
(omitted if empty), Middleware capabilities. Empty state when no
snapshot. Esc-to-close hint at the bottom.

Refs #1876"
```

---

## Task 10: Register `/governance` and `/governance reset` commands + route them

**Files:**
- Modify: `packages/ui/tui/src/commands/command-definitions.ts`
- Modify: `packages/ui/tui/src/state/types.ts` (add "governance" to TuiView union)
- Modify: `packages/ui/tui/src/tui-root.tsx`

- [ ] **Step 1: Failing test**

In `packages/ui/tui/src/commands/command-definitions.test.ts` (or create), add:

```typescript
import { COMMAND_DEFINITIONS } from "./command-definitions.js";

test("nav:governance is registered", () => {
  expect(COMMAND_DEFINITIONS.some((c) => c.id === "nav:governance")).toBe(true);
});

test("system:governance-reset is registered", () => {
  expect(COMMAND_DEFINITIONS.some((c) => c.id === "system:governance-reset")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/ui/tui/src/commands/command-definitions.test.ts
```

- [ ] **Step 3: Add commands**

In `command-definitions.ts`, append two entries to `COMMAND_DEFINITIONS`:

```typescript
  {
    id: "nav:governance",
    label: "Governance",
    description: "View sensor readings, alerts, rules, and capabilities",
    category: "navigation",
  },
  {
    id: "system:governance-reset",
    label: "Governance reset",
    description: "Clear per-session alert dedup so re-crossings re-fire",
    category: "system",
  },
```

- [ ] **Step 4: Add `"governance"` to `TuiView` type in `state/types.ts`**

```bash
grep -n "type TuiView" packages/ui/tui/src/state/types.ts
```

Add `| "governance"` to the union.

- [ ] **Step 5: Wire view route + reset handler in `tui-root.tsx`**

Find `NAV_VIEW_MAP` and add:

```typescript
  "nav:governance": "governance",
```

Find the view `<Switch>` block (where McpView, AgentsView etc. render conditionally) and add:

```tsx
<Match when={activeView() === "governance"}>
  <GovernanceView slice={governance()} />
</Match>
```

Add imports:

```typescript
import { GovernanceView } from "./components/GovernanceView.js";
```

Add selector at top of TuiRoot:

```typescript
const governance = useTuiStore((s) => s.governance);
```

Find the `props.onCommand(cmd.id, args)` dispatch block. Add a special case before the catch-all:

```typescript
if (cmd.id === "system:governance-reset") {
  store.dispatch({ kind: "clear_governance_alerts" });
  props.onCommand?.(cmd.id, args);  // host bridge also resets dedup tracker
  return;
}
```

- [ ] **Step 6: Run tests — expect PASS**

```bash
bun test packages/ui/tui/src/commands packages/ui/tui/src/tui-root.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add packages/ui/tui/src/commands packages/ui/tui/src/state/types.ts packages/ui/tui/src/tui-root.tsx
git commit -m "feat(tui): register /governance and /governance reset commands

Adds nav:governance routing (NAV_VIEW_MAP -> Switch case rendering
GovernanceView) and system:governance-reset which clears in-memory
alerts AND notifies the host bridge to reset its alert-tracker dedup.

Refs #1876"
```

---

## Task 11: Governance bridge — controller→store + JSONL alert persistence

**Files:**
- Create: `packages/meta/cli/src/governance-bridge.ts`
- Create: `packages/meta/cli/src/governance-bridge.test.ts`

- [ ] **Step 1: Failing test**

Create `packages/meta/cli/src/governance-bridge.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernanceController, GovernanceSnapshot, SensorReading } from "@koi/core";
import { createGovernanceBridge } from "./governance-bridge.js";

let tmpDir: string;
let alertsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gov-bridge-"));
  alertsPath = join(tmpDir, "alerts.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeController(snap: GovernanceSnapshot): GovernanceController {
  return {
    check: () => ({ ok: true }),
    checkAll: () => ({ ok: true }),
    record: () => {},
    snapshot: () => snap,
    variables: () => new Map(),
    reading: (n) => snap.readings.find((r) => r.name === n),
  };
}

describe("governance-bridge", () => {
  test("dispatches set_governance_snapshot on pollSnapshot", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const snap: GovernanceSnapshot = {
      timestamp: 1, healthy: true, violations: [],
      readings: [{ name: "turn_count", current: 5, limit: 10, utilization: 0.5 }],
    };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController(snap),
      sessionId: "s1",
      alertsPath,
    });
    bridge.pollSnapshot();
    expect(dispatched.find((a) => (a as { kind: string }).kind === "set_governance_snapshot")).toBeDefined();
    bridge.dispose();
  });

  test("recordAlert appends to JSONL and dispatches add_governance_alert", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const reading: SensorReading = { name: "cost_usd", current: 1.6, limit: 2, utilization: 0.8 };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [reading] }),
      sessionId: "s1",
      alertsPath,
    });
    bridge.recordAlert(0.8, "cost_usd", reading);
    const written = readFileSync(alertsPath, "utf8");
    expect(written).toContain('"variable":"cost_usd"');
    expect(dispatched.some((a) => (a as { kind: string }).kind === "add_governance_alert")).toBe(true);
    bridge.dispose();
  });

  test("loadRecentAlerts returns last N from JSONL", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath,
    });
    for (let i = 0; i < 5; i++) {
      bridge.recordAlert(
        0.8, "cost_usd",
        { name: "cost_usd", current: i, limit: 10, utilization: 0.1 * i },
      );
    }
    const recent = bridge.loadRecentAlerts(3);
    expect(recent).toHaveLength(3);
    bridge.dispose();
  });

  test("loadRecentAlerts returns [] when file does not exist", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) };
    const bridge = createGovernanceBridge({
      store: store as never,
      controller: makeController({ timestamp: 1, healthy: true, violations: [], readings: [] }),
      sessionId: "s1",
      alertsPath: join(tmpDir, "nonexistent.jsonl"),
    });
    expect(bridge.loadRecentAlerts(10)).toEqual([]);
    bridge.dispose();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/meta/cli/src/governance-bridge.test.ts
```

- [ ] **Step 3: Implement `governance-bridge.ts`**

```typescript
/**
 * Governance bridge — wires @koi/governance-core callbacks + controller into
 * the TUI store. Mirror of cost-bridge.ts.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  CapabilityFragmentLite,
  GovernanceController,
  GovernanceSnapshot,
  RuleDescriptor,
  SensorReading,
} from "@koi/core";
import type { TuiStore, GovernanceAlert } from "@koi/tui";

const MAX_PERSISTED_ALERTS = 200;

export interface GovernanceBridgeConfig {
  readonly store: TuiStore;
  readonly controller: GovernanceController;
  readonly sessionId: string;
  /** Absolute path to JSONL alerts file. */
  readonly alertsPath: string;
  /** Optional initial rules to push at startup. */
  readonly rules?: readonly RuleDescriptor[];
  /** Optional initial capabilities to push at startup. */
  readonly capabilities?: readonly CapabilityFragmentLite[];
}

export interface GovernanceBridge {
  /** Subscribe target for governance-core's `onAlert` callback. */
  readonly recordAlert: (pct: number, variable: string, reading: SensorReading) => void;
  /** Subscribe target for governance-core's `onViolation` callback. */
  readonly recordViolation: (variable: string, reason: string) => void;
  /** Push a fresh snapshot into the store (call after every engine done). */
  readonly pollSnapshot: () => void;
  /** Load up to N most recent persisted alerts from disk. */
  readonly loadRecentAlerts: (n: number) => readonly GovernanceAlert[];
  /** Update session id (call on session reset). */
  readonly setSession: (sessionId: string) => void;
  /** Stop any timers. */
  readonly dispose: () => void;
}

export function createGovernanceBridge(config: GovernanceBridgeConfig): GovernanceBridge {
  // let: justified — mutated by setSession
  let sessionId = config.sessionId;

  ensureParentDir(config.alertsPath);

  // Push initial rules + capabilities if provided.
  if (config.rules !== undefined) {
    config.store.dispatch({ kind: "set_governance_rules", rules: config.rules });
  }
  if (config.capabilities !== undefined) {
    config.store.dispatch({ kind: "set_governance_capabilities", capabilities: config.capabilities });
  }

  function nextId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function persistAlert(a: GovernanceAlert): void {
    try {
      appendFileSync(config.alertsPath, `${JSON.stringify(a)}\n`, "utf8");
      tailEvict(config.alertsPath, MAX_PERSISTED_ALERTS);
    } catch (err: unknown) {
      console.warn("[governance-bridge] alert persist failed:", err);
    }
  }

  return {
    recordAlert(pct, variable, reading) {
      const alert: GovernanceAlert = {
        id: nextId(),
        ts: Date.now(),
        sessionId,
        variable,
        threshold: pct,
        current: reading.current,
        limit: reading.limit,
        utilization: reading.utilization,
      };
      config.store.dispatch({ kind: "add_governance_alert", alert });
      persistAlert(alert);
    },

    recordViolation(variable, reason) {
      config.store.dispatch({
        kind: "add_governance_violation",
        violation: { id: nextId(), ts: Date.now(), variable, reason },
      });
    },

    pollSnapshot() {
      void Promise.resolve(config.controller.snapshot())
        .then((snap: GovernanceSnapshot) => {
          config.store.dispatch({ kind: "set_governance_snapshot", snapshot: snap });
        })
        .catch((err: unknown) => {
          console.warn("[governance-bridge] snapshot poll failed:", err);
        });
    },

    loadRecentAlerts(n) {
      if (!existsSync(config.alertsPath)) return [];
      try {
        const raw = readFileSync(config.alertsPath, "utf8");
        const lines = raw.split("\n").filter((l) => l.length > 0);
        const slice = lines.slice(-n);
        return slice.map((l) => JSON.parse(l) as GovernanceAlert);
      } catch (err: unknown) {
        console.warn("[governance-bridge] alert load failed:", err);
        return [];
      }
    },

    setSession(newSessionId) {
      sessionId = newSessionId;
    },

    dispose() {
      // No resources held open — appendFileSync is synchronous.
    },
  };
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory exists or unwriteable — append will surface the real error.
  }
}

function tailEvict(path: string, maxLines: number): void {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length <= maxLines) return;
    const trimmed = lines.slice(-maxLines).join("\n") + "\n";
    writeFileSync(path, trimmed, "utf8");
  } catch (err: unknown) {
    console.warn("[governance-bridge] tail-evict failed:", err);
  }
}
```

(Verify `TuiStore` and `GovernanceAlert` are exported from `@koi/tui`. If not, add them to its `index.ts`.)

- [ ] **Step 4: Run — expect PASS**

```bash
bun test packages/meta/cli/src/governance-bridge.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/governance-bridge.ts packages/meta/cli/src/governance-bridge.test.ts
git commit -m "feat(cli): governance-bridge — controller↔TUI store wiring

Subscribes to governance-core onAlert/onViolation, polls
controller.snapshot() on pollSnapshot(), persists alerts to JSONL with
tail-eviction at 200 lines. Mirror of cost-bridge.

Refs #1876"
```

---

## Task 12: Wire `governance-bridge` into `tui-command.ts`

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts`

- [ ] **Step 1: Locate the `createCostBridge` call site**

```bash
grep -n "createCostBridge\|costBridge\." packages/meta/cli/src/tui-command.ts | head -20
```

The bridge instance is created around line 1745 (per earlier grep). Add `createGovernanceBridge` next to it.

- [ ] **Step 2: Add import**

```typescript
import { type GovernanceBridge, createGovernanceBridge } from "./governance-bridge.js";
import { homedir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 3: Resolve the controller**

The host needs a `GovernanceController` reference. Search the file:

```bash
grep -n "governance\|GovernanceController" packages/meta/cli/src/tui-command.ts | head
```

If a controller is built earlier in the file (likely near the runtime/koi instantiation), capture it into a const. If not, the runtime exposes one via the agent's `component()` lookup — `runtime.agent.component<GovernanceController>(GOVERNANCE)`. Use whichever pattern is consistent with other component reads.

If no controller is wired through the host (i.e., no governance defaults active for this session), skip bridge creation entirely:

```typescript
const governanceController = runtime.agent.component<GovernanceController>(GOVERNANCE);
let governanceBridge: GovernanceBridge | undefined;
if (governanceController !== undefined) {
  governanceBridge = createGovernanceBridge({
    store: tuiStore,
    controller: governanceController,
    sessionId: tuiSessionId as string,
    alertsPath: join(homedir(), ".koi", "governance-alerts.jsonl"),
  });

  // Seed alerts from disk on startup.
  const recent = governanceBridge.loadRecentAlerts(10);
  for (const a of recent) {
    tuiStore.dispatch({ kind: "add_governance_alert", alert: a });
  }

  // Initial snapshot.
  governanceBridge.pollSnapshot();
}
```

- [ ] **Step 4: Hook into existing engine done path**

Find where `costBridge.recordEngineDone(...)` is called (line ~4251). Add immediately after:

```typescript
governanceBridge?.pollSnapshot();
```

- [ ] **Step 5: Wire `system:governance-reset` from TUI**

Find the existing `onCommand` handler in `tui-command.ts`. Add a case:

```typescript
case "system:governance-reset":
  // Reset alert dedup so re-crossings fire again.
  // The TUI side already cleared its alerts array via the optimistic
  // dispatch in tui-root.tsx; here we reset the alert tracker on the
  // governance-core MW so onAlert can fire again for the same threshold.
  // The MW exposes this via mw.alertTracker.cleanup(sessionId) — check
  // governance-middleware.ts for the actual surface.
  governanceMiddlewareHandle?.alertTracker?.cleanup(tuiSessionId as string);
  break;
```

If the middleware doesn't expose its alertTracker on the public handle, expose it as part of this PR — add to the middleware's return shape.

- [ ] **Step 6: Wire session reset**

Find `costBridge.setSession(...)` call (line ~3459). Add next to it:

```typescript
governanceBridge?.setSession(newSid as string);
```

- [ ] **Step 7: Wire dispose**

Find the existing dispose chain (search for `costBridge.dispose` or `aggregator.clearSession`). Add:

```typescript
governanceBridge?.dispose();
```

- [ ] **Step 8: Build + lint**

```bash
bun run --cwd packages/meta/cli typecheck && bun run lint
```

- [ ] **Step 9: Commit**

```bash
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(cli): wire governance-bridge into tui-command

Conditional on a governance controller being attached. Polls snapshot
after every engine done. /governance reset resets the per-session
alert tracker dedup. Seeds 10 most recent alerts from JSONL on startup.

Refs #1876"
```

---

## Task 13: E2E tmux test through TUI

**Files:**
- Create: `packages/meta/cli/__tests__/tui-governance-e2e.test.ts`

- [ ] **Step 1: Verify tmux harness pattern from existing tests**

```bash
ls packages/meta/cli/__tests__/ 2>&1 | grep -i "tmux\|tui-e2e"
```

Adapt the existing pattern. If no tmux-based e2e tests exist for the CLI, this is a smoke-only test in the same harness.

- [ ] **Step 2: Write the failing E2E test**

```typescript
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKTREE = "merry-weaving-flask"; // per CLAUDE.md tmux naming rule
const SESSION = `${WORKTREE}-gov-e2e`;

function tmux(...args: string[]): string {
  return Bun.spawnSync(["tmux", ...args]).stdout.toString();
}

describe("TUI governance surface — e2e", () => {
  test("status chip appears after one query when --max-spend set", async () => {
    // 1. Start a fresh TUI session in tmux with --max-spend 1.00
    const home = mkdtempSync(join(tmpdir(), "koi-e2e-home-"));
    process.env["HOME"] = home;
    Bun.spawnSync([
      "tmux", "new-session", "-d", "-s", SESSION,
      `bun run packages/meta/cli/src/bin.ts up --max-spend 1.00`,
    ]);
    try {
      // Wait for ready
      await new Promise((r) => setTimeout(r, 2000));
      // Send a trivial query that completes fast
      tmux("send-keys", "-t", SESSION, "say hi", "Enter");
      await new Promise((r) => setTimeout(r, 8000));
      const out = tmux("capture-pane", "-t", SESSION, "-p");
      expect(out).toMatch(/gov:\s*(turn|cost|tokens)/i);
    } finally {
      tmux("kill-session", "-t", SESSION);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
```

- [ ] **Step 3: Run with the recording skip env var if mocking, or against real LLM if available**

```bash
OPENROUTER_API_KEY=$(grep OPENROUTER_API_KEY ~/koi/.env | cut -d= -f2) \
  bun test packages/meta/cli/__tests__/tui-governance-e2e.test.ts
```

If no API key, document this test as opt-in via env var in the file header.

- [ ] **Step 4: Commit**

```bash
git add packages/meta/cli/__tests__/tui-governance-e2e.test.ts
git commit -m "test(cli): e2e tmux test for TUI governance status chip

Real koi run with --max-spend; asserts the gov: chip appears in
captured tmux pane. Opt-in via OPENROUTER_API_KEY env var.

Refs #1876"
```

---

## Task 14: CI gates + PR

**Files:** none (verification only)

- [ ] **Step 1: Run all v2 quality gates**

```bash
bun run test --filter=@koi/core
bun run test --filter=@koi/governance-core
bun run test --filter=@koi/governance-defaults
bun run test --filter=@koi/tui
bun run test --filter=@koi/cli
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
```

All must pass. If `check:layers` fails: most likely `@koi/tui` is reading from `@koi/cli` or vice-versa — verify direction is `@koi/cli → @koi/tui`, never the reverse.

- [ ] **Step 2: Issue mandate verification**

Re-read issue #1876 Tests section:

- "TUI component test (via tmux per CLAUDE.md): run with --max-spend 1.00, run a query costing $0.80 → expect $0.80 / $1.00 in status line + alert toast" — Task 13 covers chip, alert toast asserted via `recordAlert` test in Task 11
- "/governance command renders sensor table with correct numbers" — Task 9 + Task 10
- "Status line hides when no governance attached" — Task 8 (mostStressedSensor returns null → chip omitted)

- [ ] **Step 3: Push branch**

```bash
git push -u origin worktree-merry-weaving-flask
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat(tui+cli): governance surface — status chip, toasts, /governance view (gov-9)" --body "$(cat <<'EOF'
## Summary

Implements issue #1876 (gov-9) — TUI governance surface. Single PR per maintainer
direction (rubber-stamp risk accepted; structure split below to ease review).

### What ships

- **L0** (`@koi/core`): `RuleDescriptor` + optional `describeRules?()` on `GovernanceBackend`
- **L2** (`@koi/governance-defaults`): pattern-backend implements `describeRules`
- **L2** (`@koi/governance-core`): per-variable alert thresholds (`perVariableThresholds: Record<string, number[]>`)
- **L2** (`@koi/tui`):
  - new `GovernanceSlice` + `Toast` slices in `TuiState` with 8 new actions
  - `<ToastOverlay>` primitive (top-right, auto-dismiss 8s, fold-merge by key, max 3 visible)
  - `<StatusBar>` governance chip showing the most-stressed sensor (hidden when no controller)
  - `<GovernanceView>` full-screen view — sensors / alerts / rules / capabilities sections
  - `/governance` (nav) and `/governance reset` (system) commands
- **L3** (`@koi/cli`): `governance-bridge.ts` mirrors `cost-bridge.ts`; subscribes to MW callbacks; persists alerts to `~/.koi/governance-alerts.jsonl` (tail-evict at 200); seeds last 10 on startup

### Reuse credits (study patterns, not code)

- `firedThresholds` dedup pattern (v1 archive)
- LimitBar `▉░` ASCII fill style + 70% warn threshold (decompiled CC source)
- Top-right toast portal + single-slot dismiss (opencode permission UX)
- `cost-bridge.ts` symmetry (this repo)

### Test plan

- [ ] `bun run test --filter=@koi/core` passes
- [ ] `bun run test --filter=@koi/governance-core` passes
- [ ] `bun run test --filter=@koi/governance-defaults` passes
- [ ] `bun run test --filter=@koi/tui` passes
- [ ] `bun run test --filter=@koi/cli` passes
- [ ] `bun run typecheck && bun run lint && bun run check:layers && bun run check:unused && bun run check:duplicates` pass
- [ ] Manual e2e: `bun run packages/meta/cli/src/bin.ts up --max-spend 1.00` → run query → see chip + toast at threshold cross
- [ ] `/governance` shows sensor table; `/governance reset` clears alerts and re-arms dedup

Refs #1876
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review

**Spec coverage**

| Spec line | Task |
|---|---|
| Status-line telemetry (cost, turn, tokens) | 7 (chip), 11 (snapshot push) |
| Alert toasts on `onAlert` | 5 (action), 6 (component), 7 (mount), 11 (subscribe) |
| `/governance` full-screen view | 9 (component), 10 (route) |
| Sensor table with utilization | 9 |
| Recent violations from `getViolations()` or in-memory ring | 5 (in-memory ring), 11 (persistence) — `getViolations()` adapter deferred to follow-up since unrelated |
| Active rules from backend | 2, 3 (L0 + impl), 9 (render) |
| `describeCapabilities()` output | 9 (render) — capabilities pushed by bridge from `mw.describeCapabilities(ctx)` in Task 12 |
| `/governance reset` clears alert-fired set + force snapshot | 10 (TUI side) + 12 (host bridge calls `alertTracker.cleanup`) |

**Placeholder scan**

- All steps include exact code or commands. No `TODO`, `TBD`, `implement later`.

**Type consistency**

- `GovernanceAlert` shape (id, ts, sessionId, variable, threshold, current, limit, utilization) — defined Task 5, used Tasks 9, 11 ✓
- `RuleDescriptor` (id, description, effect, pattern?) — defined Task 2, used Tasks 3, 9 ✓
- Action kinds — `set_governance_snapshot`, `add_governance_alert`, etc. — same names across Tasks 5, 9, 10, 11, 12 ✓
- `mostStressedSensor` / `formatGovernanceChip` — defined Task 8, no later refs ✓
- `MAX_ALERTS_IN_MEMORY = 200`, `MAX_PERSISTED_ALERTS = 200` — same number, separate constants (in-memory cap vs disk cap) for future divergence ✓

**Open follow-ups noted but not in scope**
- Per-PR-too-large gate (already accepted)
- `getViolations()` adapter for the spec-mentioned violations history (separate L0u package needed)
- Bash-classifier-style governance rules in pattern-backend (gov-14)
