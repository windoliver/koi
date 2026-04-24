# gov-11: Ternary GovernanceVerdict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ok: "ask"` variant to `GovernanceVerdict` (L0) and integrate it into the existing `gate()` function so policy backends can pause on async human approval, reusing the L0 `ctx.requestApproval` primitive.

**Architecture:** Extend the L0 `GovernanceVerdict` discriminated union with a third variant (`ok: "ask"`). In `@koi/governance-core`'s `gate()`, when the evaluator returns an ask verdict, forward it to `ctx.requestApproval` (the same channel the permissions middleware uses), map the returned `ApprovalDecision` to proceed / throw PERMISSION / throw TIMEOUT, and track session-scoped grants + inflight coalescing in the middleware closure. No new L2 package.

**Tech Stack:** TypeScript 6 (strict, ESM-only, `.js` extensions), Bun 1.3.x, `bun:test`, Biome.

**Reference spec:** `docs/superpowers/specs/2026-04-23-gov-11-ternary-governance-verdict-design.md`

---

### Task 1: L0 — extend `GovernanceVerdict`, add `AskId` brand + `isAskVerdict` guard

**Files:**
- Modify: `packages/kernel/core/src/governance-backend.ts`
- Modify: `packages/kernel/core/src/governance-backend.test.ts` (append)

- [ ] **Step 1: Write failing tests (append to test file)**

Append to `packages/kernel/core/src/governance-backend.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { AskId, GovernanceVerdict } from "./governance-backend.js";
import { askId, GOVERNANCE_ALLOW, isAskVerdict } from "./governance-backend.js";

describe("AskId brand", () => {
  it("constructs a branded AskId from a string", () => {
    const id: AskId = askId("ask-123");
    // Branded string remains a string at runtime.
    expect(typeof id).toBe("string");
    expect(id).toBe("ask-123");
  });
});

describe("GovernanceVerdict ask variant", () => {
  it("narrows to ok: 'ask' via isAskVerdict", () => {
    const v: GovernanceVerdict = {
      ok: "ask",
      prompt: "Allow shell:rm?",
      askId: askId("ask-1"),
    };
    expect(isAskVerdict(v)).toBe(true);
    if (isAskVerdict(v)) {
      expect(v.prompt).toBe("Allow shell:rm?");
      expect(v.askId).toBe("ask-1");
    }
  });

  it("isAskVerdict returns false for ok: true", () => {
    expect(isAskVerdict(GOVERNANCE_ALLOW)).toBe(false);
  });

  it("isAskVerdict returns false for ok: false", () => {
    const v: GovernanceVerdict = {
      ok: false,
      violations: [{ rule: "x", severity: "warning", message: "blocked" }],
    };
    expect(isAskVerdict(v)).toBe(false);
  });

  it("accepts optional metadata on ask variant", () => {
    const v: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("a"),
      metadata: { rule: "x.y", resource: "/tmp/foo" },
    };
    if (isAskVerdict(v)) {
      expect(v.metadata).toEqual({ rule: "x.y", resource: "/tmp/foo" });
    }
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test packages/kernel/core/src/governance-backend.test.ts
```

Expected: fails with "Cannot find name 'askId'" and "Cannot find name 'isAskVerdict'".

- [ ] **Step 3: Extend the L0 verdict union and add the brand + guard**

In `packages/kernel/core/src/governance-backend.ts`, replace the `GovernanceVerdict` block (lines 120-130) and append new exports:

```ts
// Brand for async-approval identifiers. Backends MUST generate
// globally-unique askIds (e.g., via crypto.randomUUID) — this is a
// documented invariant; consumers rely on it for inflight coalescing.
declare const __askIdBrand: unique symbol;
export type AskId = string & { readonly [__askIdBrand]: "AskId" };

/** Create a branded AskId from a plain string. */
export function askId(id: string): AskId {
  return id as AskId;
}

/**
 * Result of evaluating a PolicyRequest against governance rules.
 * Discriminated union on `ok`:
 * - `ok: true` — request is allowed, with optional diagnostics (info-level observations)
 * - `ok: false` — request is denied, with one or more violations
 * - `ok: "ask"` — request requires async human approval; the middleware forwards
 *   `prompt` to `ctx.requestApproval` and maps the returned ApprovalDecision to
 *   proceed / deny / timeout. `askId` MUST be globally unique per ask for
 *   inflight coalescing.
 */
export type GovernanceVerdict =
  | {
      readonly ok: true;
      readonly diagnostics?: readonly Violation[] | undefined;
    }
  | {
      readonly ok: false;
      readonly violations: readonly Violation[];
    }
  | {
      readonly ok: "ask";
      readonly prompt: string;
      readonly askId: AskId;
      readonly metadata?: JsonObject | undefined;
    };

/** Type guard for the ask variant. */
export function isAskVerdict(
  v: GovernanceVerdict,
): v is Extract<GovernanceVerdict, { ok: "ask" }> {
  return v.ok === "ask";
}
```

(`GOVERNANCE_ALLOW` stays unchanged below — it still matches the `ok: true` variant.)

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test packages/kernel/core/src/governance-backend.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck**

```bash
bun run --cwd packages/kernel/core typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/core/src/governance-backend.ts packages/kernel/core/src/governance-backend.test.ts
git commit -m "feat(core): GovernanceVerdict ok:\"ask\" variant + AskId brand (#1878)"
```

---

### Task 2: L0 index re-exports

**Files:**
- Modify: `packages/kernel/core/src/index.ts`

- [ ] **Step 1: Locate the governance-backend re-export block**

```bash
grep -n "governance-backend" packages/kernel/core/src/index.ts
```

Find the block re-exporting from `./governance-backend.js`.

- [ ] **Step 2: Add `AskId`, `askId`, `isAskVerdict` to that block**

Edit the block so the new names are exported alongside the existing ones. Preserve the existing export style (type exports with `type` keyword; value exports without).

Concretely, if the existing block looks like:

```ts
export type {
  // ... existing types ...
  GovernanceVerdict,
  Violation,
  ViolationSeverity,
} from "./governance-backend.js";
export {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  GOVERNANCE_ALLOW,
  VIOLATION_SEVERITY_ORDER,
} from "./governance-backend.js";
```

Add `AskId` to the type block and `askId`, `isAskVerdict` to the value block — keep keys alphabetical if the existing block is alphabetical.

- [ ] **Step 3: Typecheck + smoke test imports**

```bash
bun run --cwd packages/kernel/core typecheck
bun test packages/kernel/core/src/governance-backend.test.ts
```

Expected: clean.

- [ ] **Step 4: Update API surface snapshot if present**

```bash
bun test packages/kernel/core/src/__tests__/api-surface.test.ts 2>&1 | tail -20
```

If the snapshot fails, regenerate deliberately:

```bash
bun test packages/kernel/core/src/__tests__/api-surface.test.ts --update-snapshots
```

Inspect the diff — it must add only `AskId`, `askId`, `isAskVerdict` and the extended `GovernanceVerdict` shape. Nothing else should change.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/core/src/index.ts
# include the snapshot file ONLY if it was updated and the diff is scoped
git add packages/kernel/core/src/__tests__/__snapshots__/api-surface.test.ts.snap 2>/dev/null || true
git commit -m "feat(core): export AskId + isAskVerdict from @koi/core (#1878)"
```

---

### Task 3: grant-key utility — stable canonical-JSON SHA-256 hash

**Files:**
- Create: `packages/security/governance-core/src/grant-key.ts`
- Create: `packages/security/governance-core/src/grant-key.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/security/governance-core/src/grant-key.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { computeGrantKey } from "./grant-key.js";

describe("computeGrantKey", () => {
  it("produces a 64-char hex SHA-256 digest", () => {
    const key = computeGrantKey("tool_call", { toolId: "shell", input: { cmd: "ls" } });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across object key order", () => {
    const a = computeGrantKey("tool_call", { a: 1, b: 2, c: { x: 10, y: 20 } });
    const b = computeGrantKey("tool_call", { c: { y: 20, x: 10 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order", () => {
    const a = computeGrantKey("tool_call", { items: [1, 2, 3] });
    const b = computeGrantKey("tool_call", { items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("differentiates by kind", () => {
    const payload = { toolId: "shell", input: { cmd: "ls" } };
    expect(computeGrantKey("tool_call", payload)).not.toBe(
      computeGrantKey("model_call", payload),
    );
  });

  it("differentiates by payload", () => {
    expect(computeGrantKey("tool_call", { input: { cmd: "ls" } })).not.toBe(
      computeGrantKey("tool_call", { input: { cmd: "rm" } }),
    );
  });

  it("handles null and undefined values consistently", () => {
    // `undefined` is dropped by JSON — documenting the behavior
    const a = computeGrantKey("tool_call", { x: null });
    const b = computeGrantKey("tool_call", { x: null });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test packages/security/governance-core/src/grant-key.test.ts
```

Expected: fails — module not found.

- [ ] **Step 3: Implement `grant-key.ts`**

Create `packages/security/governance-core/src/grant-key.ts`:

```ts
import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";

/**
 * Compute a stable SHA-256 hex digest for a (kind, payload) pair.
 * Used as the session-scoped grant key so approving one (kind, payload)
 * cannot bleed into a materially different call.
 *
 * Canonicalization rules:
 *   - Object keys are sorted recursively.
 *   - Arrays preserve order (semantically meaningful).
 *   - `undefined` values are dropped (JSON semantics).
 */
export function computeGrantKey(kind: PolicyRequestKind, payload: JsonObject): string {
  const canonical = canonicalJsonStringify({ kind, payload });
  const bytes = new TextEncoder().encode(canonical);
  const digest = Bun.CryptoHasher.hash("sha256", bytes, "hex");
  return typeof digest === "string" ? digest : Buffer.from(digest).toString("hex");
}

function canonicalJsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const sorted: Record<string, unknown> = {};
      for (const [k, v2] of entries) sorted[k] = v2;
      return sorted;
    }
    return val;
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test packages/security/governance-core/src/grant-key.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/grant-key.ts packages/security/governance-core/src/grant-key.test.ts
git commit -m "feat(governance-core): computeGrantKey — canonical-JSON SHA-256 (#1878)"
```

---

### Task 4: with-timeout utility

**Files:**
- Create: `packages/security/governance-core/src/with-timeout.ts`
- Create: `packages/security/governance-core/src/with-timeout.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/security/governance-core/src/with-timeout.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ApprovalTimeoutError, isApprovalTimeout, withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("resolves with the promise value when it settles first", async () => {
    const p = Promise.resolve(42);
    await expect(withTimeout(p, 1000)).resolves.toBe(42);
  });

  it("rejects with ApprovalTimeoutError when the timer fires first", async () => {
    const p = new Promise<number>((res) => setTimeout(() => res(1), 200));
    await expect(withTimeout(p, 10)).rejects.toBeInstanceOf(ApprovalTimeoutError);
  });

  it("isApprovalTimeout returns true only for ApprovalTimeoutError instances", () => {
    expect(isApprovalTimeout(new ApprovalTimeoutError("t"))).toBe(true);
    expect(isApprovalTimeout(new Error("other"))).toBe(false);
    expect(isApprovalTimeout("str")).toBe(false);
  });

  it("rejects with AbortError when the abort signal fires first", async () => {
    const ctrl = new AbortController();
    const p = new Promise<number>((res) => setTimeout(() => res(1), 200));
    setTimeout(() => ctrl.abort(), 10);
    await expect(withTimeout(p, 1000, ctrl.signal)).rejects.toThrow();
  });

  it("does not leak timers after resolution", async () => {
    // Smoke test — the test runner would hang on a leaked timer
    const p = Promise.resolve("ok");
    await withTimeout(p, 10_000);
  });

  it("propagates underlying promise rejections as-is", async () => {
    const p = Promise.reject(new Error("underlying"));
    await expect(withTimeout(p, 1000)).rejects.toThrow("underlying");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test packages/security/governance-core/src/with-timeout.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `with-timeout.ts`**

Create `packages/security/governance-core/src/with-timeout.ts`:

```ts
/**
 * ApprovalTimeoutError — sentinel thrown by `withTimeout` when the timer
 * fires before the inner promise settles. Callers distinguish via
 * `isApprovalTimeout` to map to `KoiRuntimeError({ code: "TIMEOUT" })`.
 */
export class ApprovalTimeoutError extends Error {
  override readonly name = "ApprovalTimeoutError";
}

export function isApprovalTimeout(e: unknown): e is ApprovalTimeoutError {
  return e instanceof ApprovalTimeoutError;
}

/**
 * Race a promise against a timeout and an optional abort signal.
 * Clears the timeout on settlement to avoid leaking handles.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener !== undefined && abortSignal !== undefined) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ApprovalTimeoutError(`Approval timed out after ${ms}ms`)));
    }, ms);

    let abortListener: (() => void) | undefined;
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        finish(() => reject(new DOMException("Aborted", "AbortError")));
        return;
      }
      abortListener = (): void => {
        finish(() => reject(new DOMException("Aborted", "AbortError")));
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }

    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test packages/security/governance-core/src/with-timeout.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/with-timeout.ts packages/security/governance-core/src/with-timeout.test.ts
git commit -m "feat(governance-core): withTimeout + ApprovalTimeoutError (#1878)"
```

---

### Task 5: Config additions — `approvalTimeoutMs`, `onApprovalPersist`, `PersistentGrant`

**Files:**
- Modify: `packages/security/governance-core/src/config.ts`
- Modify: `packages/security/governance-core/src/config.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `packages/security/governance-core/src/config.test.ts`:

```ts
import { validateGovernanceConfig } from "./config.js";

describe("validateGovernanceConfig — ask-verdict config", () => {
  const baseValid = {
    backend: { evaluator: { evaluate: () => ({ ok: true }) } },
    controller: {
      checkAll: async () => ({ ok: true }),
      record: async () => undefined,
      snapshot: () => ({}),
    },
    cost: { calculate: () => 0 },
  };

  it("accepts missing approvalTimeoutMs (defaulted later)", () => {
    const res = validateGovernanceConfig(baseValid);
    expect(res.ok).toBe(true);
  });

  it("rejects approvalTimeoutMs: 0", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: 0 });
    expect(res.ok).toBe(false);
  });

  it("rejects approvalTimeoutMs: -1", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: -1 });
    expect(res.ok).toBe(false);
  });

  it("rejects approvalTimeoutMs: NaN", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: Number.NaN });
    expect(res.ok).toBe(false);
  });

  it("rejects approvalTimeoutMs: '60'", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: "60" });
    expect(res.ok).toBe(false);
  });

  it("accepts approvalTimeoutMs: 60000", () => {
    const res = validateGovernanceConfig({ ...baseValid, approvalTimeoutMs: 60000 });
    expect(res.ok).toBe(true);
  });

  it("rejects onApprovalPersist that is not a function", () => {
    const res = validateGovernanceConfig({ ...baseValid, onApprovalPersist: "nope" });
    expect(res.ok).toBe(false);
  });

  it("accepts onApprovalPersist as a function", () => {
    const res = validateGovernanceConfig({
      ...baseValid,
      onApprovalPersist: () => undefined,
    });
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/security/governance-core/src/config.test.ts
```

Expected: fails — new fields not yet recognised.

- [ ] **Step 3: Extend config.ts**

In `packages/security/governance-core/src/config.ts`, add imports + new types + validation.

At the top of the imports block:

```ts
import type { AgentId, SessionId } from "@koi/core";
```

Add this near the other type exports (after `UsageCallback`):

```ts
export interface PersistentGrant {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly payload: JsonObject;
  readonly grantKey: string;
  readonly grantedAt: number;
}

export type PersistentGrantCallback = (grant: PersistentGrant) => void;

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000 as const;
```

(`PolicyRequestKind` and `JsonObject` are already in scope; if not, add `PolicyRequestKind` to the `@koi/core/governance-backend` import and `JsonObject` to the `@koi/core` import.)

Extend `GovernanceMiddlewareConfig`:

```ts
export interface GovernanceMiddlewareConfig {
  readonly backend: GovernanceBackend;
  readonly controller: GovernanceController;
  readonly cost: CostCalculator;
  readonly alertThresholds?: readonly number[];
  readonly perVariableThresholds?: Record<string, readonly number[]>;
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
  readonly observerOnly?: boolean;
  /**
   * Timeout for async approvals triggered by ok:"ask" verdicts.
   * Defaults to DEFAULT_APPROVAL_TIMEOUT_MS (60_000ms) when omitted.
   * When the timer fires before the user responds, the middleware throws
   * KoiRuntimeError({ code: "TIMEOUT" }).
   */
  readonly approvalTimeoutMs?: number;
  /**
   * Observation callback fired when the user grants `always-allow` with
   * scope:"always" on a governance ask. Hosts plug gov-12 persistence here.
   * If omitted, `always` behaves identically to session-only (grant is
   * kept in-memory for the session and dropped on onSessionEnd).
   */
  readonly onApprovalPersist?: PersistentGrantCallback;
}
```

Extend `validateGovernanceConfig` (insert before `return { ok: true, ...}`):

```ts
  if (c.approvalTimeoutMs !== undefined) {
    if (
      typeof c.approvalTimeoutMs !== "number" ||
      !Number.isFinite(c.approvalTimeoutMs) ||
      !Number.isInteger(c.approvalTimeoutMs) ||
      c.approvalTimeoutMs <= 0
    ) {
      return {
        ok: false,
        error: err("approvalTimeoutMs must be a positive integer", {
          approvalTimeoutMs: c.approvalTimeoutMs as never,
        }),
      };
    }
  }
  if (c.onApprovalPersist !== undefined && typeof c.onApprovalPersist !== "function") {
    return { ok: false, error: err("onApprovalPersist must be a function") };
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/config.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/config.ts packages/security/governance-core/src/config.test.ts
git commit -m "feat(governance-core): approvalTimeoutMs + onApprovalPersist config (#1878)"
```

---

### Task 6: governance-core index re-exports

**Files:**
- Modify: `packages/security/governance-core/src/index.ts`

- [ ] **Step 1: Add the new exports**

Edit `packages/security/governance-core/src/index.ts` to add (next to existing `config` exports):

```ts
export type {
  GovernanceMiddlewareConfig,
  PersistentGrant,
  PersistentGrantCallback,
  UsageCallback,
  ViolationCallback,
} from "./config.js";
export {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  validateGovernanceConfig,
} from "./config.js";
```

(Merge with the existing `config` export block — do not duplicate.)

- [ ] **Step 2: Typecheck**

```bash
bun run --cwd packages/security/governance-core typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/index.ts
git commit -m "feat(governance-core): export PersistentGrant + DEFAULT_APPROVAL_TIMEOUT_MS (#1878)"
```

---

### Task 7: gate() — ask → allow happy path

**Files:**
- Create: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`
- Modify: `packages/security/governance-core/src/governance-middleware.ts`

This is the first of seven tasks that evolve `gate()`. Each task adds one branch + its test. The closure state (`sessionGrants`, `inflightAsks`, `sessionAborts`) is added incrementally as branches need it.

- [ ] **Step 1: Create the test file with a shared harness + the ask→allow test**

Create `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`:

```ts
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { JsonObject } from "@koi/core";
import { agentId as toAgentId, sessionId as toSessionId, askId } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest } from "@koi/core/governance-backend";
import type {
  ApprovalDecision,
  ApprovalHandler,
  ModelRequest,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { createGovernanceMiddleware } from "../governance-middleware.js";
import type { GovernanceMiddlewareConfig } from "../config.js";

function makeCtx(overrides: {
  readonly sessionId?: string;
  readonly requestApproval?: ApprovalHandler | undefined;
} = {}): TurnContext {
  const sId = overrides.sessionId ?? "sess-1";
  return {
    session: {
      agentId: "agent-1",
      sessionId: toSessionId(sId),
      runId: "run-1" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t-0" as never,
    messages: [],
    metadata: {},
    ...(overrides.requestApproval !== undefined ? { requestApproval: overrides.requestApproval } : {}),
  };
}

function makeConfig(overrides: Partial<GovernanceMiddlewareConfig> & {
  readonly verdict: GovernanceVerdict;
}): GovernanceMiddlewareConfig {
  const { verdict, ...rest } = overrides;
  return {
    backend: {
      evaluator: { evaluate: () => verdict },
    },
    controller: {
      checkAll: async () => ({ ok: true }) as never,
      record: async () => undefined,
      snapshot: () => ({}) as never,
    },
    cost: { calculate: () => 0 },
    ...rest,
  } as GovernanceMiddlewareConfig;
}

const askVerdict = (id = "ask-1"): GovernanceVerdict => ({
  ok: "ask",
  prompt: "Allow this?",
  askId: askId(id),
});

function modelReq(): ModelRequest {
  return { model: "m", messages: [] } as ModelRequest;
}

describe("gate() — ask verdict", () => {
  it("resolves when handler returns ApprovalDecision.allow", async () => {
    const handler = mock<ApprovalHandler>(async () => ({ kind: "allow" }) as ApprovalDecision);
    const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
    const ctx = makeCtx({ requestApproval: handler });
    const next = async () => ({ content: "ok" } as never);

    await expect(mw.wrapModelCall!(ctx, modelReq(), next)).resolves.toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

Expected: fails because `gate()` does not yet handle `ok: "ask"` — it throws from the PERMISSION path.

- [ ] **Step 3: Add closure state + `ensureSessionAbort` helper to the middleware**

In `packages/security/governance-core/src/governance-middleware.ts`, inside the `createGovernanceMiddleware` function (after the existing `let degraded = false;` etc. declarations, before the `gate()` function), add:

```ts
  // Ask-verdict state (gov-11)
  const sessionGrants = new Map<string, Set<string>>();
  const inflightAsks = new Map<string, Promise<ApprovalDecision>>();
  const sessionAborts = new Map<string, AbortController>();

  function ensureSessionAbort(sId: string): AbortController {
    let ctrl = sessionAborts.get(sId);
    if (ctrl === undefined) {
      ctrl = new AbortController();
      sessionAborts.set(sId, ctrl);
    }
    return ctrl;
  }

  function ensureSessionGrantSet(sId: string): Set<string> {
    let set = sessionGrants.get(sId);
    if (set === undefined) {
      set = new Set();
      sessionGrants.set(sId, set);
    }
    return set;
  }
```

Add top-of-file imports (merge with existing blocks):

```ts
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@koi/core/middleware";
import { computeGrantKey } from "./grant-key.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./config.js";
import { isApprovalTimeout, withTimeout } from "./with-timeout.js";
```

And extract `approvalTimeoutMs` + `onApprovalPersist` from the destructured config at line 59:

```ts
  const {
    backend,
    controller,
    cost,
    onAlert,
    onViolation,
    onUsage,
    onApprovalPersist,
  } = config;
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
```

- [ ] **Step 4: Add the ask branch in `gate()`**

In `gate()` (currently ends with `emitCompliance(request, kind, GOVERNANCE_ALLOW);` at line 243), replace the final section from `if (!verdict.ok)` onward with:

```ts
    if (verdict.ok === "ask") {
      await handleAskVerdict(ctx, kind, payload, verdict, request);
      return;
    }

    if (verdict.ok === false) {
      onViolation?.(verdict, request);
      emitCompliance(request, kind, verdict);
      throw KoiRuntimeError.from("PERMISSION", joinMsgs(verdict), {
        context: {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          kind,
          violations: verdict.violations.map((v) => ({
            rule: v.rule,
            severity: v.severity,
          })),
        },
      });
    }

    emitCompliance(request, kind, GOVERNANCE_ALLOW);
```

And add the `handleAskVerdict` helper immediately below `gate()`:

```ts
  async function handleAskVerdict(
    ctx: TurnContext,
    kind: PolicyRequestKind,
    payload: JsonObject,
    verdict: Extract<GovernanceVerdict, { ok: "ask" }>,
    request: PolicyRequest,
  ): Promise<void> {
    const sId = ctx.session.sessionId;
    const grantKey = computeGrantKey(kind, payload);

    // Session-scoped grant fast-path (future task adds this branch).
    if (ensureSessionGrantSet(sId).has(grantKey)) {
      emitCompliance(request, kind, GOVERNANCE_ALLOW);
      return;
    }

    const handler = ctx.requestApproval;
    if (handler === undefined) {
      throw KoiRuntimeError.from(
        "PERMISSION",
        "Governance verdict requires approval but no handler is configured",
        { context: { agentId: ctx.session.agentId, sessionId: sId, kind, askId: verdict.askId } },
      );
    }

    // Inflight coalescing (future task exercises this branch).
    let pending = inflightAsks.get(verdict.askId);
    if (pending === undefined) {
      const approvalReq: ApprovalRequest = {
        toolId: `governance:${kind}`,
        input: payload,
        reason: verdict.prompt,
        ...(verdict.metadata !== undefined
          ? { metadata: { askId: verdict.askId, ...verdict.metadata } }
          : { metadata: { askId: verdict.askId } }),
      };
      pending = withTimeout(
        Promise.resolve(handler(approvalReq)),
        approvalTimeoutMs,
        ensureSessionAbort(sId).signal,
      );
      inflightAsks.set(verdict.askId, pending);
      pending.finally(() => inflightAsks.delete(verdict.askId));
    }

    let decision: ApprovalDecision;
    try {
      decision = await pending;
    } catch (e) {
      if (isApprovalTimeout(e)) {
        throw KoiRuntimeError.from("TIMEOUT", `Approval timed out after ${approvalTimeoutMs}ms`, {
          cause: e,
          context: { agentId: ctx.session.agentId, sessionId: sId, kind, askId: verdict.askId },
        });
      }
      throw KoiRuntimeError.from("PERMISSION", "Approval handler failed", {
        cause: e,
        context: { agentId: ctx.session.agentId, sessionId: sId, kind, askId: verdict.askId },
      });
    }

    switch (decision.kind) {
      case "allow":
        emitCompliance(request, kind, GOVERNANCE_ALLOW);
        return;
      case "always-allow":
        ensureSessionGrantSet(sId).add(grantKey);
        if (decision.scope === "always" && onApprovalPersist !== undefined) {
          onApprovalPersist({
            kind,
            agentId: toAgentId(ctx.session.agentId),
            sessionId: sId,
            payload,
            grantKey,
            grantedAt: Date.now(),
          });
        }
        emitCompliance(request, kind, GOVERNANCE_ALLOW);
        return;
      case "deny":
        throw KoiRuntimeError.from("PERMISSION", decision.reason || verdict.prompt, {
          context: { agentId: ctx.session.agentId, sessionId: sId, kind, askId: verdict.askId },
        });
      case "modify":
        throw KoiRuntimeError.from(
          "PERMISSION",
          "Governance asks do not support input modification",
          { context: { agentId: ctx.session.agentId, sessionId: sId, kind, askId: verdict.askId } },
        );
    }
  }
```

(Note: this implementation already covers tasks 8–13. Subsequent tasks only add new tests that exercise the branches already present; the production code here is the complete ask-branch. If a subsequent test surfaces a gap, fix the gap in that task.)

- [ ] **Step 5: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
bun test packages/security/governance-core/src/governance-middleware.test.ts
```

Expected: ask-verdict test passes; existing regression tests still pass.

- [ ] **Step 6: Typecheck**

```bash
bun run --cwd packages/security/governance-core typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.ts packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "feat(governance-core): gate() handles ok:\"ask\" verdict (#1878)"
```

---

### Task 8: ask → deny and ask → modify

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append tests**

Inside the `describe("gate() — ask verdict", ...)` block in the test file:

```ts
it("throws PERMISSION with the decision reason on ApprovalDecision.deny", async () => {
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "deny",
    reason: "user rejected",
  }) as ApprovalDecision);
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  try {
    await mw.wrapModelCall!(ctx, modelReq(), next);
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(KoiRuntimeError);
    expect((e as KoiRuntimeError).code).toBe("PERMISSION");
    expect((e as KoiRuntimeError).message).toBe("user rejected");
  }
});

it("throws PERMISSION with 'modification not supported' on ApprovalDecision.modify", async () => {
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "modify",
    updatedInput: {},
  }) as ApprovalDecision);
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  try {
    await mw.wrapModelCall!(ctx, modelReq(), next);
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(KoiRuntimeError);
    expect((e as KoiRuntimeError).code).toBe("PERMISSION");
    expect((e as KoiRuntimeError).message).toMatch(/modification not supported/i);
  }
});

it("throws PERMISSION with the prompt when decision.reason is empty", async () => {
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "deny",
    reason: "",
  }) as ApprovalDecision);
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  try {
    await mw.wrapModelCall!(ctx, modelReq(), next);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as KoiRuntimeError).message).toBe("Allow this?");
  }
});
```

- [ ] **Step 2: Run — expect PASS (implementation added in Task 7 covers these)**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): ask verdict deny + modify paths (#1878)"
```

---

### Task 9: ask → fail closed when no handler

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append test**

```ts
it("throws PERMISSION when ctx.requestApproval is undefined", async () => {
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict() }));
  const ctx = makeCtx(); // no handler
  const next = async () => ({ content: "x" } as never);

  try {
    await mw.wrapModelCall!(ctx, modelReq(), next);
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(KoiRuntimeError);
    expect((e as KoiRuntimeError).code).toBe("PERMISSION");
    expect((e as KoiRuntimeError).message).toMatch(/no handler is configured/);
  }
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): fail-closed when no approval handler (#1878)"
```

---

### Task 10: ask → always-allow session fast-path

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append test**

```ts
it("always-allow session: second identical call skips the handler", async () => {
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "always-allow",
    scope: "session",
  }) as ApprovalDecision);
  const onApprovalPersist = mock(() => undefined);
  const mw = createGovernanceMiddleware(makeConfig({
    verdict: askVerdict(),
    onApprovalPersist,
  }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  await mw.wrapModelCall!(ctx, modelReq(), next);
  await mw.wrapModelCall!(ctx, modelReq(), next);

  expect(handler).toHaveBeenCalledTimes(1);
  expect(onApprovalPersist).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): session-scoped always-allow fast-path (#1878)"
```

---

### Task 11: ask → always-allow scope=always fires `onApprovalPersist`

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append test**

```ts
it("always-allow scope=always: fires onApprovalPersist with PersistentGrant", async () => {
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "always-allow",
    scope: "always",
  }) as ApprovalDecision);
  const grants: unknown[] = [];
  const onApprovalPersist = (g: unknown): void => { grants.push(g); };

  const mw = createGovernanceMiddleware(makeConfig({
    verdict: askVerdict(),
    onApprovalPersist,
  }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  await mw.wrapModelCall!(ctx, modelReq(), next);

  expect(grants).toHaveLength(1);
  const g = grants[0] as Record<string, unknown>;
  expect(g.kind).toBe("model_call");
  expect(g.agentId).toBe("agent-1");
  expect(g.sessionId).toBe("sess-1");
  expect(typeof g.grantKey).toBe("string");
  expect((g.grantKey as string)).toMatch(/^[0-9a-f]{64}$/);
  expect(typeof g.grantedAt).toBe("number");
});

it("always-allow scope=always also populates session grant (no re-ask on second call)", async () => {
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "always-allow",
    scope: "always",
  }) as ApprovalDecision);
  const mw = createGovernanceMiddleware(makeConfig({
    verdict: askVerdict(),
    onApprovalPersist: () => undefined,
  }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  await mw.wrapModelCall!(ctx, modelReq(), next);
  await mw.wrapModelCall!(ctx, modelReq(), next);

  expect(handler).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): always-allow always fires onApprovalPersist (#1878)"
```

---

### Task 12: ask → timeout

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append test**

```ts
it("throws TIMEOUT when handler does not resolve within approvalTimeoutMs", async () => {
  // Handler never resolves
  const handler = mock<ApprovalHandler>(() => new Promise(() => {}));
  const mw = createGovernanceMiddleware(makeConfig({
    verdict: askVerdict(),
    approvalTimeoutMs: 20,
  }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  try {
    await mw.wrapModelCall!(ctx, modelReq(), next);
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(KoiRuntimeError);
    expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
  }
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): ask verdict timeout → TIMEOUT (#1878)"
```

---

### Task 13: inflight coalescing by `askId`

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append test**

```ts
it("coalesces two concurrent asks with the same askId into one handler call", async () => {
  // Shared deferred so two concurrent calls can overlap
  let resolveApproval: (d: ApprovalDecision) => void = () => {};
  const handler = mock<ApprovalHandler>(
    () => new Promise<ApprovalDecision>((res) => { resolveApproval = res; }),
  );

  // Backend always returns the same askId
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict("shared-id") }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  const p1 = mw.wrapModelCall!(ctx, modelReq(), next);
  const p2 = mw.wrapModelCall!(ctx, modelReq(), next);

  // Resolve the single shared approval
  resolveApproval({ kind: "allow" });

  await expect(p1).resolves.toBeDefined();
  await expect(p2).resolves.toBeDefined();

  expect(handler).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): inflight coalescing by askId (#1878)"
```

---

### Task 14: `onSessionEnd` cleanup — drop grants and abort pending

**Files:**
- Modify: `packages/security/governance-core/src/governance-middleware.ts`
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
it("onSessionEnd drops session grants", async () => {
  let verdict: GovernanceVerdict = askVerdict("a1");
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "always-allow",
    scope: "session",
  }) as ApprovalDecision);
  const mw = createGovernanceMiddleware({
    ...makeConfig({ verdict: askVerdict("a1") }),
    backend: { evaluator: { evaluate: () => verdict } } as never,
  });
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  await mw.wrapModelCall!(ctx, modelReq(), next);         // handler called once, grant set
  await mw.wrapModelCall!(ctx, modelReq(), next);         // fast-path, no handler
  expect(handler).toHaveBeenCalledTimes(1);

  await mw.onSessionEnd!(ctx.session);

  // New ask with a new askId so inflight-coalesce doesn't mask behavior
  verdict = askVerdict("a2");
  await mw.wrapModelCall!(ctx, modelReq(), next);         // must re-ask after session end
  expect(handler).toHaveBeenCalledTimes(2);
});

it("onSessionEnd aborts a pending ask with PERMISSION", async () => {
  const handler = mock<ApprovalHandler>(() => new Promise(() => {}));
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict("pending-1") }));
  const ctx = makeCtx({ requestApproval: handler });
  const next = async () => ({ content: "x" } as never);

  const pending = mw.wrapModelCall!(ctx, modelReq(), next);
  // End the session while the ask is in-flight
  setTimeout(() => { void mw.onSessionEnd!(ctx.session); }, 5);

  try {
    await pending;
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(KoiRuntimeError);
    expect((e as KoiRuntimeError).code).toBe("PERMISSION");
  }
});
```

- [ ] **Step 2: Run — expect FAIL** (onSessionEnd does not yet touch gov-11 state)

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Extend `onSessionEnd` in the middleware**

In `packages/security/governance-core/src/governance-middleware.ts`, the current `onSessionEnd` (near line 450) only calls `alertTracker.cleanup(ctx.sessionId)`. Extend it:

```ts
    async onSessionEnd(ctx: SessionContext): Promise<void> {
      alertTracker.cleanup(ctx.sessionId);

      // gov-11: abort pending asks and drop session grants.
      const abort = sessionAborts.get(ctx.sessionId);
      if (abort !== undefined) {
        abort.abort();
        sessionAborts.delete(ctx.sessionId);
      }
      sessionGrants.delete(ctx.sessionId);

      // degraded-latch handling remains: preserved cumulative counters mean
      // the latch MUST survive session boundaries. Do not clear here.
    },
```

Also: the abort path currently throws `DOMException("AbortError")` from `withTimeout`, which `handleAskVerdict` catches and converts to PERMISSION via its generic `else` branch. Verify by reading the existing catch block added in Task 7 — it already does:

```ts
    } catch (e) {
      if (isApprovalTimeout(e)) { throw KoiRuntimeError.from("TIMEOUT", ...); }
      throw KoiRuntimeError.from("PERMISSION", "Approval handler failed", { cause: e, ... });
    }
```

This maps AbortError → PERMISSION, which is the expected behavior. No further changes.

- [ ] **Step 4: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.ts packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "feat(governance-core): onSessionEnd aborts pending asks, drops grants (#1878)"
```

---

### Task 15: Scope regression tests — payload + kind isolation

**Files:**
- Modify: `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

- [ ] **Step 1: Append tests**

```ts
it("grant for {cmd:'ls'} does NOT cover {cmd:'rm'}", async () => {
  // The test config is for model_call; payload differs by `model` field.
  let currentModel = "m1";
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "always-allow",
    scope: "session",
  }) as ApprovalDecision);

  const mw = createGovernanceMiddleware(makeConfig({
    verdict: askVerdict("grant-key-1"),
  }));
  const ctx = makeCtx({ requestApproval: handler });

  const next = async () => ({ content: "x" } as never);

  await mw.wrapModelCall!(ctx, { model: "m1" } as ModelRequest, next);   // approve + cache
  await mw.wrapModelCall!(ctx, { model: "m1" } as ModelRequest, next);   // fast-path
  await mw.wrapModelCall!(ctx, { model: "m2" } as ModelRequest, next);   // different payload → re-ask

  expect(handler).toHaveBeenCalledTimes(2);
  expect(currentModel).toBe("m1"); // suppress unused warning; ignore
});

it("grant for tool_call does NOT cover model_call with identical payload", async () => {
  // Use the wrapToolCall hook — produces kind:"tool_call".
  const handler = mock<ApprovalHandler>(async () => ({
    kind: "always-allow",
    scope: "session",
  }) as ApprovalDecision);
  const mw = createGovernanceMiddleware(makeConfig({ verdict: askVerdict("k1") }));
  const ctx = makeCtx({ requestApproval: handler });

  const next = async () => ({ output: "ok" } as never);

  // First: tool_call with payload {toolId:"t", input:{}}
  if (mw.wrapToolCall !== undefined) {
    await mw.wrapToolCall(ctx, { toolId: "t", input: {} } as never, next);
    // Second: model_call — different `kind` → must re-ask
    await mw.wrapModelCall!(ctx, modelReq(), async () => ({ content: "x" } as never));
  }

  expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
});
```

(The second test is a smoke check — if `wrapToolCall` is not wired for this middleware path in the test harness, delete the check and keep only the first test.)

- [ ] **Step 2: Run — expect PASS**

```bash
bun test packages/security/governance-core/src/__tests__/ask-verdict.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/__tests__/ask-verdict.test.ts
git commit -m "test(governance-core): grant-key payload + kind scoping (#1878)"
```

---

### Task 16: Final validation — full suite + layer check + lint + typecheck

**Files:** (no edits; verification only)

- [ ] **Step 1: Full test suite**

```bash
bun run test
```

Expected: all tests pass. If a test file unrelated to gov-11 breaks, investigate — do NOT weaken it to make CI green.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: clean.

- [ ] **Step 4: Layer check — verifies no L0 boundary violations**

```bash
bun run check:layers
```

Expected: clean. `@koi/core` adds no imports. `@koi/governance-core` still depends only on L0 + L0u.

- [ ] **Step 5: Unused-export check**

```bash
bun run check:unused
```

Expected: clean. (If `ApprovalTimeoutError` or `PersistentGrantCallback` flag as unused, wire them into the public `index.ts` or document the intent.)

- [ ] **Step 6: Coverage for the touched packages**

```bash
bun run test --filter=@koi/core --filter=@koi/governance-core --coverage
```

Expected: coverage on `governance-backend.ts`, `governance-middleware.ts`, `config.ts`, `grant-key.ts`, `with-timeout.ts` each at ≥ 80% lines / functions / statements. Any gap fills as a focused unit test (no padding).

- [ ] **Step 7: If the repo has a PR body template / issue closer, prepare it**

```bash
git log --oneline main..HEAD
```

Verify the commit sequence is intact. If repo uses `gh pr create`, the PR title should read:
`feat(governance): gov-11 ternary GovernanceVerdict — allow/deny/ask + HITL (#1878)`

Body should link the spec doc and include the "Unblocks" list (#1879, #1399).

- [ ] **Step 8: Final commit (only if anything small remains)**

No-op if everything is already committed. Otherwise:

```bash
git add -p   # stage only the intended hunks
git commit -m "chore(governance-core): polish gov-11 edge cases (#1878)"
```

---

## Self-review checklist (plan author)

- [x] Every L0 spec change has a Task 1 step.
- [x] AskId brand + constructor + guard exported via Task 2.
- [x] grant-key utility → Task 3 (new file + tests).
- [x] with-timeout utility → Task 4 (new file + tests).
- [x] Config extensions + validation → Task 5.
- [x] index re-exports → Task 6.
- [x] `gate()` ask branch + all decision outcomes → Tasks 7–11.
- [x] Timeout → Task 12.
- [x] Inflight coalescing → Task 13.
- [x] `onSessionEnd` abort + grant drop → Task 14.
- [x] Payload/kind scoping regression → Task 15.
- [x] Full CI gate + coverage → Task 16.
- [x] No placeholders ("TBD", "similar to", "etc.") in any step.
- [x] Function/type names consistent across tasks (`computeGrantKey`, `handleAskVerdict`, `ensureSessionAbort`, `ensureSessionGrantSet`, `PersistentGrant`, `PersistentGrantCallback`, `DEFAULT_APPROVAL_TIMEOUT_MS`).
- [x] Every code step includes the actual code to write.
- [x] Every test step includes the exact assertions.
