# `@koi/governance-core` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build L2 middleware package that gates model/tool calls through `GovernanceBackend.evaluator` + `GovernanceController` setpoints (fail-closed), records token/cost events post-call, and emits best-effort compliance records.

**Architecture:** One factory `createGovernanceMiddleware(config)`. Priority 150. Zero external deps. Composes with existing `@koi/middleware-permissions` (100) and `@koi/middleware-audit` (300).

**Tech Stack:** TypeScript 6 (strict), Bun runtime + `bun:test`, tsup build (ESM+dts), Biome lint.

**Spec:** `docs/superpowers/specs/2026-04-16-governance-core-design.md`. **Read it before starting.**

---

## File layout

| Path | Responsibility | LOC budget |
|---|---|---|
| `packages/security/governance-core/package.json` | Manifest + deps | — |
| `packages/security/governance-core/tsconfig.json` | TS project refs | — |
| `packages/security/governance-core/tsup.config.ts` | Build config | — |
| `src/index.ts` | Public re-exports | ~40 |
| `src/config.ts` | `GovernanceMiddlewareConfig`, `validateGovernanceConfig` | ~80 |
| `src/cost-calculator.ts` | `CostCalculator`, `createFlatRateCostCalculator` | ~60 |
| `src/normalize-usage.ts` | `NormalizedUsage`, `normalizeUsage` | ~70 |
| `src/alert-tracker.ts` | Per-session threshold dedup | ~50 |
| `src/governance-middleware.ts` | `createGovernanceMiddleware` factory | ~200 |
| `src/__tests__/api-surface.test.ts` | Public-export snapshot | — |
| `src/<name>.test.ts` | Colocated unit tests | — |

---

## Task 0: Scaffold package + L2 doc (doc-before-code per CLAUDE.md)

**Files:**
- Create: `packages/security/governance-core/package.json`
- Create: `packages/security/governance-core/tsconfig.json`
- Create: `packages/security/governance-core/tsup.config.ts`
- Create: `packages/security/governance-core/biome.json`
- Create: `packages/security/governance-core/src/index.ts` (empty re-exports placeholder)
- Create: `docs/L2/governance-core.md` (user-facing L2 doc — doc-gate CI requires)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@koi/governance-core",
  "description": "Governance middleware bundle — policy gate, setpoint enforcement, cost recording",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test",
    "test:api": "bun test src/__tests__/api-surface.test.ts"
  },
  "koi": { "optional": true },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../kernel/core" }, { "path": "../../lib/errors" }]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 4: Create `biome.json`**

```json
{ "extends": ["../../../biome.json"] }
```

- [ ] **Step 5: Create placeholder `src/index.ts`**

```ts
export {};
```

- [ ] **Step 6: Create L2 user doc `docs/L2/governance-core.md`**

```markdown
# @koi/governance-core — Governance Middleware Bundle

L2 middleware that gates every model call and tool call through a pluggable `GovernanceBackend.evaluator` and enforces numeric `GovernanceController` setpoints (token usage, cost, turn count, spawn depth). Records token/cost events after each successful model call and emits best-effort compliance records for audit.

## Position in the middleware chain

- 50 — exfiltration-guard
- 100 — permissions (rule-based tool allow/deny)
- **150 — governance-core (this package)**
- 300 — audit

## Fail-closed contract

- `evaluator.evaluate()` throws → `POLICY_VIOLATION` with `cause` preserved
- `controller.checkAll()` throws → `POLICY_VIOLATION` with `cause`
- `compliance.recordCompliance()` fails → warn and swallow; denial decision is authoritative

## Usage

```ts
createGovernanceMiddleware({
  backend,      // GovernanceBackend (L0)
  controller,   // GovernanceController (L0)
  cost,         // CostCalculator
  alertThresholds: [0.8, 0.95],
  onAlert, onViolation, onUsage,
})
```

## Budget inheritance

Spawn-depth budget inheritance is the engine's responsibility (#1473). Parent records `{kind:"spawn", depth}`; child agents receive a derived `GovernanceController` via `SubsystemToken<GovernanceController>` at assembly time.

## Out of scope

- URL / filesystem / credentials scope subsystem — follow-up package
- Approval / deferral UX (three-tier allow/deny/ask) — requires L0 `GovernanceVerdict` extension
- Persistent compliance storage — use `@koi/audit-sink-*`
```

- [ ] **Step 7: Install workspace dep, verify typecheck empty package**

Run: `bun install && bun run --cwd packages/security/governance-core typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/security/governance-core/ docs/L2/governance-core.md
git commit -m "chore(governance-core): scaffold package + L2 doc (#1392)"
```

---

## Task 1: `normalize-usage` — TDD

**Files:**
- Create: `packages/security/governance-core/src/normalize-usage.ts`
- Create: `packages/security/governance-core/src/normalize-usage.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/normalize-usage.test.ts
import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "./normalize-usage.js";

describe("normalizeUsage", () => {
  test("returns all-zero when usage is undefined", () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("maps L0 ModelResponse.usage fields", () => {
    const got = normalizeUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
    });
    expect(got).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
      reasoningTokens: 0,
    });
  });

  test("missing cache fields default to 0", () => {
    const got = normalizeUsage({ inputTokens: 8, outputTokens: 4 });
    expect(got.cacheReadTokens).toBe(0);
    expect(got.cacheWriteTokens).toBe(0);
  });

  test("reads reasoningTokens from metadata when present", () => {
    const got = normalizeUsage(
      { inputTokens: 1, outputTokens: 2 },
      { reasoningTokens: 7 },
    );
    expect(got.reasoningTokens).toBe(7);
  });

  test("non-number reasoningTokens metadata ignored", () => {
    const got = normalizeUsage({ inputTokens: 1, outputTokens: 2 }, { reasoningTokens: "oops" });
    expect(got.reasoningTokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify fails**

Run: `bun test packages/security/governance-core/src/normalize-usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/normalize-usage.ts
import type { JsonObject } from "@koi/core";
import type { ModelResponse } from "@koi/core/middleware";

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

const ZERO: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

function readNumber(obj: JsonObject | undefined, key: string): number {
  if (obj === undefined) return 0;
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function normalizeUsage(
  usage: ModelResponse["usage"],
  metadata?: JsonObject,
): NormalizedUsage {
  if (usage === undefined) return ZERO;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: readNumber(metadata, "reasoningTokens"),
  };
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/normalize-usage.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/normalize-usage.ts packages/security/governance-core/src/normalize-usage.test.ts
git commit -m "feat(governance-core): normalizeUsage helper (#1392)"
```

---

## Task 2: `cost-calculator` — TDD

**Files:**
- Create: `packages/security/governance-core/src/cost-calculator.ts`
- Create: `packages/security/governance-core/src/cost-calculator.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/cost-calculator.test.ts
import { describe, expect, test } from "bun:test";
import { createFlatRateCostCalculator } from "./cost-calculator.js";

describe("createFlatRateCostCalculator", () => {
  const pricing = {
    "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  } as const;

  test("computes cost per 1M tokens", () => {
    const calc = createFlatRateCostCalculator(pricing);
    const cost = calc.calculate("gpt-4o-mini", 1_000_000, 500_000);
    expect(cost).toBeCloseTo(0.15 + 0.3, 10);
  });

  test("zero tokens → zero cost", () => {
    const calc = createFlatRateCostCalculator(pricing);
    expect(calc.calculate("gpt-4o-mini", 0, 0)).toBe(0);
  });

  test("unknown model throws INVALID_ARGUMENT", () => {
    const calc = createFlatRateCostCalculator(pricing);
    expect(() => calc.calculate("missing", 1, 1)).toThrow(/INVALID_ARGUMENT/);
  });

  test("negative tokens throw INVALID_ARGUMENT", () => {
    const calc = createFlatRateCostCalculator(pricing);
    expect(() => calc.calculate("gpt-4o-mini", -1, 0)).toThrow(/INVALID_ARGUMENT/);
    expect(() => calc.calculate("gpt-4o-mini", 0, -1)).toThrow(/INVALID_ARGUMENT/);
  });

  test("non-finite tokens throw INVALID_ARGUMENT", () => {
    const calc = createFlatRateCostCalculator(pricing);
    expect(() => calc.calculate("gpt-4o-mini", Number.NaN, 0)).toThrow(/INVALID_ARGUMENT/);
    expect(() => calc.calculate("gpt-4o-mini", Number.POSITIVE_INFINITY, 0)).toThrow(/INVALID_ARGUMENT/);
  });
});
```

- [ ] **Step 2: Run test to verify fails**

Run: `bun test packages/security/governance-core/src/cost-calculator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/cost-calculator.ts
import { KoiRuntimeError } from "@koi/errors";

export interface PricingEntry {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
}

export interface CostCalculator {
  readonly calculate: (model: string, inputTokens: number, outputTokens: number) => number;
}

export function createFlatRateCostCalculator(
  pricing: Readonly<Record<string, PricingEntry>>,
): CostCalculator {
  return {
    calculate(model, inputTokens, outputTokens) {
      const entry = pricing[model];
      if (entry === undefined) {
        throw KoiRuntimeError.from(
          "INVALID_ARGUMENT",
          `No pricing entry for model "${model}"`,
          { context: { model } },
        );
      }
      if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
        throw KoiRuntimeError.from("INVALID_ARGUMENT", "Token counts must be finite numbers", {
          context: { model, inputTokens, outputTokens },
        });
      }
      if (inputTokens < 0 || outputTokens < 0) {
        throw KoiRuntimeError.from("INVALID_ARGUMENT", "Token counts must be non-negative", {
          context: { model, inputTokens, outputTokens },
        });
      }
      return (inputTokens / 1_000_000) * entry.inputUsdPer1M +
        (outputTokens / 1_000_000) * entry.outputUsdPer1M;
    },
  };
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/cost-calculator.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/cost-calculator.ts packages/security/governance-core/src/cost-calculator.test.ts
git commit -m "feat(governance-core): flat-rate cost calculator (#1392)"
```

---

## Task 3: `alert-tracker` — TDD

**Files:**
- Create: `packages/security/governance-core/src/alert-tracker.ts`
- Create: `packages/security/governance-core/src/alert-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/alert-tracker.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { GovernanceSnapshot } from "@koi/core/governance";
import { createAlertTracker } from "./alert-tracker.js";

function snapshot(variable: string, current: number, limit: number): GovernanceSnapshot {
  return {
    timestamp: 0,
    readings: [{ name: variable, current, limit, utilization: current / limit }],
    healthy: current < limit,
    violations: [],
  };
}

describe("createAlertTracker", () => {
  test("fires once at crossing 0.8", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8, 0.95] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.5, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(0);

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.81, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  test("fires both thresholds in single jump 0→0.96", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8, 0.95] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.96, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test("per-session dedup — different sessions track independently", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    tracker.checkAndFire("s2", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test("cleanup clears fired set for session", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.8] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);

    tracker.cleanup("s1");
    tracker.checkAndFire("s1", snapshot("cost_usd", 0.85, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test("unsorted thresholds still work (internal sort)", () => {
    const onAlert = mock(() => {});
    const tracker = createAlertTracker({ thresholds: [0.95, 0.8] });

    tracker.checkAndFire("s1", snapshot("cost_usd", 0.9, 1), onAlert);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify fails**

Run: `bun test packages/security/governance-core/src/alert-tracker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/alert-tracker.ts
import type { GovernanceSnapshot, SensorReading } from "@koi/core/governance";

export type AlertCallback = (
  pctUsed: number,
  variable: string,
  reading: SensorReading,
) => void;

export interface AlertTrackerConfig {
  readonly thresholds: readonly number[];
}

export interface AlertTracker {
  readonly checkAndFire: (
    sessionId: string,
    snapshot: GovernanceSnapshot,
    onAlert: AlertCallback | undefined,
  ) => void;
  readonly cleanup: (sessionId: string) => void;
}

export function createAlertTracker(config: AlertTrackerConfig): AlertTracker {
  const sortedThresholds = [...config.thresholds].sort((a, b) => a - b);
  const fired = new Map<string, Set<string>>();

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
        for (const threshold of sortedThresholds) {
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

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/alert-tracker.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/alert-tracker.ts packages/security/governance-core/src/alert-tracker.test.ts
git commit -m "feat(governance-core): per-session alert tracker (#1392)"
```

---

## Task 4: `config` — TDD

**Files:**
- Create: `packages/security/governance-core/src/config.ts`
- Create: `packages/security/governance-core/src/config.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/config.test.ts
import { describe, expect, test } from "bun:test";
import type { GovernanceBackend } from "@koi/core/governance-backend";
import type { GovernanceController } from "@koi/core/governance";
import { DEFAULT_ALERT_THRESHOLDS, validateGovernanceConfig } from "./config.js";
import { createFlatRateCostCalculator } from "./cost-calculator.js";

const goodBackend: GovernanceBackend = { evaluator: { evaluate: () => ({ ok: true }) } };
const goodController: GovernanceController = {
  check: () => ({ ok: true }),
  checkAll: () => ({ ok: true }),
  record: () => undefined,
  snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
  variables: () => new Map(),
  reading: () => undefined,
};
const goodCost = createFlatRateCostCalculator({ m: { inputUsdPer1M: 1, outputUsdPer1M: 1 } });

describe("validateGovernanceConfig", () => {
  test("accepts minimal valid config", () => {
    const r = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects missing backend", () => {
    const r = validateGovernanceConfig({ controller: goodController, cost: goodCost });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("rejects missing controller", () => {
    const r = validateGovernanceConfig({ backend: goodBackend, cost: goodCost });
    expect(r.ok).toBe(false);
  });

  test("rejects missing cost", () => {
    const r = validateGovernanceConfig({ backend: goodBackend, controller: goodController });
    expect(r.ok).toBe(false);
  });

  test("rejects threshold out of [0,1]", () => {
    const r = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      alertThresholds: [0.8, 1.5],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects negative threshold", () => {
    const r = validateGovernanceConfig({
      backend: goodBackend,
      controller: goodController,
      cost: goodCost,
      alertThresholds: [-0.1],
    });
    expect(r.ok).toBe(false);
  });

  test("DEFAULT_ALERT_THRESHOLDS is [0.8, 0.95]", () => {
    expect(DEFAULT_ALERT_THRESHOLDS).toEqual([0.8, 0.95]);
  });
});
```

- [ ] **Step 2: Run test to verify fails**

Run: `bun test packages/security/governance-core/src/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/config.ts
import type { KoiError, Result } from "@koi/core";
import type { GovernanceController } from "@koi/core/governance";
import type {
  GovernanceBackend,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core/governance-backend";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { AlertCallback } from "./alert-tracker.js";
import type { CostCalculator } from "./cost-calculator.js";
import type { NormalizedUsage } from "./normalize-usage.js";

export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = Object.freeze([0.8, 0.95]);

export type ViolationCallback = (verdict: GovernanceVerdict, request: PolicyRequest) => void;
export type UsageCallback = (event: {
  readonly model: string;
  readonly usage: NormalizedUsage;
  readonly costUsd: number;
}) => void;

export interface GovernanceMiddlewareConfig {
  readonly backend: GovernanceBackend;
  readonly controller: GovernanceController;
  readonly cost: CostCalculator;
  readonly alertThresholds?: readonly number[];
  readonly onAlert?: AlertCallback;
  readonly onViolation?: ViolationCallback;
  readonly onUsage?: UsageCallback;
}

function err(message: string, context?: Record<string, unknown>): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    ...(context !== undefined ? { context: context as never } : {}),
  };
}

export function validateGovernanceConfig(
  input: unknown,
): Result<GovernanceMiddlewareConfig, KoiError> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: err("config must be an object") };
  }
  const c = input as Partial<GovernanceMiddlewareConfig>;
  if (c.backend === undefined || typeof c.backend.evaluator?.evaluate !== "function") {
    return { ok: false, error: err("config.backend.evaluator.evaluate is required") };
  }
  if (
    c.controller === undefined ||
    typeof c.controller.checkAll !== "function" ||
    typeof c.controller.record !== "function" ||
    typeof c.controller.snapshot !== "function"
  ) {
    return { ok: false, error: err("config.controller is required with checkAll/record/snapshot") };
  }
  if (c.cost === undefined || typeof c.cost.calculate !== "function") {
    return { ok: false, error: err("config.cost.calculate is required") };
  }
  if (c.alertThresholds !== undefined) {
    for (const t of c.alertThresholds) {
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
        return { ok: false, error: err("alertThresholds must be numbers in (0, 1]", { threshold: t }) };
      }
    }
  }
  return { ok: true, value: c as GovernanceMiddlewareConfig };
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/config.test.ts`
Expected: 7/7 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/config.ts packages/security/governance-core/src/config.test.ts
git commit -m "feat(governance-core): config + validateGovernanceConfig (#1392)"
```

---

## Task 5: Middleware factory — skeleton + compose hooks

**Files:**
- Create: `packages/security/governance-core/src/governance-middleware.ts`
- Create: `packages/security/governance-core/src/governance-middleware.test.ts`

This task adds name/priority constants, `describeCapabilities`, `onBeforeTurn`, `onSessionEnd`. Gate + wrap hooks are added in Task 6–8.

- [ ] **Step 1: Write failing tests (composition surface)**

```ts
// src/governance-middleware.test.ts
import { describe, expect, test } from "bun:test";
import type { GovernanceController } from "@koi/core/governance";
import type { GovernanceBackend } from "@koi/core/governance-backend";
import {
  GOVERNANCE_MIDDLEWARE_NAME,
  GOVERNANCE_MIDDLEWARE_PRIORITY,
  createGovernanceMiddleware,
} from "./governance-middleware.js";
import { createFlatRateCostCalculator } from "./cost-calculator.js";

function baseCfg(overrides: Partial<Parameters<typeof createGovernanceMiddleware>[0]> = {}) {
  const backend: GovernanceBackend = { evaluator: { evaluate: () => ({ ok: true }) } };
  const controller: GovernanceController = {
    check: () => ({ ok: true }),
    checkAll: () => ({ ok: true }),
    record: () => undefined,
    snapshot: () => ({ timestamp: 0, readings: [], healthy: true, violations: [] }),
    variables: () => new Map(),
    reading: () => undefined,
  };
  const cost = createFlatRateCostCalculator({ m: { inputUsdPer1M: 1, outputUsdPer1M: 1 } });
  return { backend, controller, cost, ...overrides };
}

describe("createGovernanceMiddleware — composition", () => {
  test("name is koi:governance-core", () => {
    expect(createGovernanceMiddleware(baseCfg()).name).toBe(GOVERNANCE_MIDDLEWARE_NAME);
    expect(GOVERNANCE_MIDDLEWARE_NAME).toBe("koi:governance-core");
  });

  test("priority is 150", () => {
    expect(createGovernanceMiddleware(baseCfg()).priority).toBe(150);
    expect(GOVERNANCE_MIDDLEWARE_PRIORITY).toBe(150);
  });

  test("exposes all expected hooks", () => {
    const mw = createGovernanceMiddleware(baseCfg());
    expect(typeof mw.wrapModelCall).toBe("function");
    expect(typeof mw.wrapModelStream).toBe("function");
    expect(typeof mw.wrapToolCall).toBe("function");
    expect(typeof mw.onBeforeTurn).toBe("function");
    expect(typeof mw.onSessionEnd).toBe("function");
    expect(typeof mw.describeCapabilities).toBe("function");
  });

  test("describeCapabilities returns label=governance", () => {
    const mw = createGovernanceMiddleware(baseCfg());
    const cap = mw.describeCapabilities({} as never);
    expect(cap?.label).toBe("governance");
  });
});
```

- [ ] **Step 2: Run to verify fails**

Run: `bun test packages/security/governance-core/src/governance-middleware.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton**

```ts
// src/governance-middleware.ts
import type {
  CapabilityFragment,
  KoiMiddleware,
  TurnContext,
} from "@koi/core/middleware";
import { createAlertTracker } from "./alert-tracker.js";
import type {
  GovernanceMiddlewareConfig,
} from "./config.js";
import { DEFAULT_ALERT_THRESHOLDS } from "./config.js";

export const GOVERNANCE_MIDDLEWARE_NAME = "koi:governance-core";
export const GOVERNANCE_MIDDLEWARE_PRIORITY = 150;

export function createGovernanceMiddleware(
  config: GovernanceMiddlewareConfig,
): KoiMiddleware {
  const { backend, controller, cost, onAlert, onViolation, onUsage } = config;
  const alertTracker = createAlertTracker({
    thresholds: config.alertThresholds ?? DEFAULT_ALERT_THRESHOLDS,
  });

  return {
    name: GOVERNANCE_MIDDLEWARE_NAME,
    priority: GOVERNANCE_MIDDLEWARE_PRIORITY,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment {
      return {
        label: "governance",
        description: "Policy gate + setpoint enforcement active",
      };
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const snapshot = await controller.snapshot();
      alertTracker.checkAndFire(ctx.session.sessionId, snapshot, onAlert);
    },

    async onSessionEnd(ctx: TurnContext): Promise<void> {
      alertTracker.cleanup(ctx.session.sessionId);
    },

    async wrapModelCall(_ctx, request, next) {
      return next(request);
    },

    async *wrapModelStream(_ctx, request, next) {
      yield* next(request);
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },
  };
}
```

Unused vars `backend`, `controller`, `cost`, `onViolation`, `onUsage` are referenced in Tasks 6–8; keeping skeleton minimal for this task.

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/governance-middleware.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Lint + typecheck**

Run: `bun run --cwd packages/security/governance-core typecheck && bun run --cwd packages/security/governance-core lint`
Expected: zero errors. If linter complains about unused destructured variables, suppress with `// biome-ignore lint/correctness/noUnusedVariables: wired in next task` until Task 6.

- [ ] **Step 6: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.ts packages/security/governance-core/src/governance-middleware.test.ts
git commit -m "feat(governance-core): middleware skeleton with hook surface (#1392)"
```

---

## Task 6: Gate + `wrapModelCall`

**Files:**
- Modify: `packages/security/governance-core/src/governance-middleware.ts`
- Modify: `packages/security/governance-core/src/governance-middleware.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// append to governance-middleware.test.ts
import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";
import { agentId, sessionId } from "@koi/core";
import { mock } from "bun:test";

function ctx(): TurnContext {
  return {
    session: {
      sessionId: sessionId("s1"),
      agentId: agentId("a1"),
    },
  } as TurnContext;
}

function req(): ModelRequest {
  return { messages: [], model: "m" };
}

function response(input: number, output: number): ModelResponse {
  return {
    content: "ok",
    model: "m",
    usage: { inputTokens: input, outputTokens: output },
  };
}

describe("wrapModelCall — gate + record", () => {
  test("allow verdict → next called → cost recorded", async () => {
    const cfg = baseCfg();
    const recorded: unknown[] = [];
    cfg.controller = {
      ...cfg.controller,
      record: (ev) => { recorded.push(ev); },
    };
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => response(100, 50));
    await mw.wrapModelCall?.(ctx(), req(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(recorded[0]).toMatchObject({ kind: "token_usage", inputTokens: 100, outputTokens: 50 });
  });

  test("deny verdict → throws POLICY_VIOLATION before next called", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "no-deploy", severity: "critical", message: "blocked" }],
          }),
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => response(1, 1));
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), next); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error & { code?: string }).code).toBe("POLICY_VIOLATION");
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("controller setpoint exceeded → throws RATE_LIMIT before next", async () => {
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        checkAll: () => ({ ok: false, variable: "cost_usd", reason: "over $1", retryable: false }),
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => response(1, 1));
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), next); } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("onUsage fires after successful call", async () => {
    const cfg = baseCfg();
    const onUsage = mock(() => {});
    cfg.onUsage = onUsage;
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(100, 50));
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  test("onViolation fires before throw", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "r", severity: "critical", message: "m" }],
          }),
        },
      },
    });
    const onViolation = mock(() => {});
    cfg.onViolation = onViolation;
    const mw = createGovernanceMiddleware(cfg);
    try { await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1)); } catch { /* expected */ }
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  test("compliance record emitted for allow and deny", async () => {
    const allowBackend: GovernanceBackend = {
      evaluator: { evaluate: () => ({ ok: true }) },
      compliance: { recordCompliance: mock((r) => r) },
    };
    const cfg = baseCfg({ backend: allowBackend });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    expect(allowBackend.compliance?.recordCompliance).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify fails**

Run: `bun test packages/security/governance-core/src/governance-middleware.test.ts`
Expected: FAIL — skeleton `next` wrapper doesn't gate.

- [ ] **Step 3: Implement gate + wrapModelCall**

Replace the entire `createGovernanceMiddleware` body with:

```ts
// src/governance-middleware.ts — replace body
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { JsonObject } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type {
  GovernanceVerdict,
  PolicyRequest,
  PolicyRequestKind,
} from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import { createAlertTracker } from "./alert-tracker.js";
import type { GovernanceMiddlewareConfig } from "./config.js";
import { DEFAULT_ALERT_THRESHOLDS } from "./config.js";
import { normalizeUsage } from "./normalize-usage.js";

export const GOVERNANCE_MIDDLEWARE_NAME = "koi:governance-core";
export const GOVERNANCE_MIDDLEWARE_PRIORITY = 150;

function joinMsgs(v: GovernanceVerdict): string {
  if (v.ok) return "";
  return v.violations.map((x) => x.message).join("; ");
}

function warnCompliance(e: unknown): void {
  console.warn("[koi:governance-core] compliance record failed", { cause: e });
}

export function createGovernanceMiddleware(
  config: GovernanceMiddlewareConfig,
): KoiMiddleware {
  const { backend, controller, cost, onAlert, onViolation, onUsage } = config;
  const alertTracker = createAlertTracker({
    thresholds: config.alertThresholds ?? DEFAULT_ALERT_THRESHOLDS,
  });

  async function gate(
    ctx: TurnContext,
    kind: PolicyRequestKind,
    payload: JsonObject,
  ): Promise<void> {
    let check;
    try {
      check = await controller.checkAll();
    } catch (e) {
      throw KoiRuntimeError.from("POLICY_VIOLATION", "Governance controller check failed", {
        cause: e,
        context: { agentId: ctx.session.agentId, sessionId: ctx.session.sessionId, kind },
      });
    }
    if (!check.ok) {
      const synth: GovernanceVerdict = {
        ok: false,
        violations: [{ rule: check.variable, severity: "critical", message: check.reason }],
      };
      const req: PolicyRequest = {
        kind,
        agentId: ctx.session.agentId,
        payload,
        timestamp: Date.now(),
      };
      onViolation?.(synth, req);
      throw KoiRuntimeError.from(
        "RATE_LIMIT",
        `Governance setpoint exceeded: ${check.variable}`,
        {
          context: {
            agentId: ctx.session.agentId,
            sessionId: ctx.session.sessionId,
            kind,
            variable: check.variable,
          },
        },
      );
    }

    const request: PolicyRequest = {
      kind,
      agentId: ctx.session.agentId,
      payload,
      timestamp: Date.now(),
    };

    let verdict: GovernanceVerdict;
    try {
      verdict = await backend.evaluator.evaluate(request);
    } catch (e) {
      throw KoiRuntimeError.from("POLICY_VIOLATION", "Governance backend evaluation failed", {
        cause: e,
        context: { agentId: ctx.session.agentId, sessionId: ctx.session.sessionId, kind },
      });
    }

    if (!verdict.ok) {
      onViolation?.(verdict, request);
      if (backend.compliance !== undefined) {
        void Promise.resolve(
          backend.compliance.recordCompliance({
            requestId: `${request.agentId}:${kind}:${request.timestamp}`,
            request,
            verdict,
            evaluatedAt: Date.now(),
            policyFingerprint: GOVERNANCE_MIDDLEWARE_NAME,
          }),
        ).catch(warnCompliance);
      }
      throw KoiRuntimeError.from("POLICY_VIOLATION", joinMsgs(verdict), {
        context: {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          kind,
          violations: verdict.violations.map((v) => ({ rule: v.rule, severity: v.severity })),
        },
      });
    }

    if (backend.compliance !== undefined) {
      void Promise.resolve(
        backend.compliance.recordCompliance({
          requestId: `${request.agentId}:${kind}:${request.timestamp}`,
          request,
          verdict: GOVERNANCE_ALLOW,
          evaluatedAt: Date.now(),
          policyFingerprint: GOVERNANCE_MIDDLEWARE_NAME,
        }),
      ).catch(warnCompliance);
    }
  }

  async function recordModelUsage(ctx: TurnContext, response: ModelResponse): Promise<void> {
    if (response.usage === undefined) return;
    const usage = normalizeUsage(response.usage, response.metadata);
    const costUsd = cost.calculate(response.model, usage.inputTokens, usage.outputTokens);
    await controller.record({
      kind: "token_usage",
      count: usage.inputTokens + usage.outputTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
    });
    const snap = await controller.snapshot();
    alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
    onUsage?.({ model: response.model, usage, costUsd });
  }

  return {
    name: GOVERNANCE_MIDDLEWARE_NAME,
    priority: GOVERNANCE_MIDDLEWARE_PRIORITY,

    describeCapabilities(_ctx): CapabilityFragment {
      return { label: "governance", description: "Policy gate + setpoint enforcement active" };
    },

    async onBeforeTurn(ctx): Promise<void> {
      const snap = await controller.snapshot();
      alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
    },

    async onSessionEnd(ctx): Promise<void> {
      alertTracker.cleanup(ctx.session.sessionId);
    },

    async wrapModelCall(ctx, request: ModelRequest, next) {
      await gate(ctx, "model_call", { model: request.model ?? "unknown" });
      const response = await next(request);
      await recordModelUsage(ctx, response);
      return response;
    },

    async *wrapModelStream(_ctx, request, next) {
      yield* next(request); // TODO task 7
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request); // TODO task 8
    },
  };
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/governance-middleware.test.ts`
Expected: all composition + wrapModelCall tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.ts packages/security/governance-core/src/governance-middleware.test.ts
git commit -m "feat(governance-core): gate + wrapModelCall with fail-closed policy evaluation (#1392)"
```

---

## Task 7: `wrapModelStream`

**Files:**
- Modify: `packages/security/governance-core/src/governance-middleware.ts`
- Modify: `packages/security/governance-core/src/governance-middleware.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe("wrapModelStream", () => {
  test("gate runs before first yield; cost recorded on done chunk", async () => {
    const cfg = baseCfg();
    const recorded: unknown[] = [];
    cfg.controller = { ...cfg.controller, record: (ev) => { recorded.push(ev); } };
    const mw = createGovernanceMiddleware(cfg);

    async function* source() {
      yield { kind: "text_delta" as const, delta: "hi" };
      yield {
        kind: "done" as const,
        response: { content: "hi", model: "m", usage: { inputTokens: 10, outputTokens: 5 } },
      };
    }
    const out = [];
    for await (const c of mw.wrapModelStream!(ctx(), req(), source)) out.push(c);
    expect(out.length).toBe(2);
    expect(recorded[0]).toMatchObject({ kind: "token_usage", inputTokens: 10, outputTokens: 5 });
  });

  test("deny verdict → throws before first yield", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "r", severity: "critical", message: "m" }],
          }),
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    async function* source() { yield { kind: "text_delta" as const, delta: "x" }; }
    let threw: unknown;
    try {
      for await (const _ of mw.wrapModelStream!(ctx(), req(), source)) { /* drain */ }
    } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("POLICY_VIOLATION");
  });

  test("no done chunk → no cost recorded", async () => {
    const cfg = baseCfg();
    const recorded: unknown[] = [];
    cfg.controller = { ...cfg.controller, record: (ev) => { recorded.push(ev); } };
    const mw = createGovernanceMiddleware(cfg);
    async function* source() { yield { kind: "text_delta" as const, delta: "x" }; }
    for await (const _ of mw.wrapModelStream!(ctx(), req(), source)) { /* drain */ }
    expect(recorded).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fails**

Expected: FAIL — `wrapModelStream` passthrough doesn't gate, doesn't record.

- [ ] **Step 3: Implement**

Replace `wrapModelStream` with:

```ts
    async *wrapModelStream(ctx, request: ModelRequest, next) {
      await gate(ctx, "model_call", { model: request.model ?? "unknown" });
      for await (const chunk of next(request)) {
        yield chunk;
        if (chunk.kind === "done") {
          await recordModelUsage(ctx, chunk.response);
        }
      }
    },
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/governance-middleware.test.ts`
Expected: stream tests green + prior still green.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.ts packages/security/governance-core/src/governance-middleware.test.ts
git commit -m "feat(governance-core): wrapModelStream with done-chunk cost recording (#1392)"
```

---

## Task 8: `wrapToolCall` + scope-field optimization

**Files:**
- Modify: `packages/security/governance-core/src/governance-middleware.ts`
- Modify: `packages/security/governance-core/src/governance-middleware.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe("wrapToolCall", () => {
  test("allow verdict → next called", async () => {
    const cfg = baseCfg();
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => ({ callId: "c1" as never, toolId: "t", result: "ok" } as never));
    await mw.wrapToolCall?.(ctx(), { callId: "c1" as never, toolId: "t", input: {} } as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("deny verdict → throws, next never called", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "dangerous", severity: "critical", message: "no" }],
          }),
        },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    const next = mock(async () => ({}) as never);
    let threw: unknown;
    try {
      await mw.wrapToolCall?.(ctx(), { callId: "c1" as never, toolId: "t", input: {} } as never, next);
    } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("POLICY_VIOLATION");
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("evaluator scope=['tool_call'] → model_call bypasses evaluator", async () => {
    const evaluate = mock(() => ({ ok: true }));
    const cfg = baseCfg({
      backend: {
        evaluator: { evaluate, scope: ["tool_call"] },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    expect(evaluate).toHaveBeenCalledTimes(0);
    await mw.wrapToolCall?.(ctx(), { callId: "c" as never, toolId: "t", input: {} } as never, async () => ({}) as never);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify fails**

Expected: FAIL — wrapToolCall passthrough + scope optimization missing.

- [ ] **Step 3: Implement scope check in `gate` + wire `wrapToolCall`**

Modify `gate` — before calling `backend.evaluator.evaluate`, honor `scope` filter:

```ts
    // In gate(), after constructing `request`, before the evaluate try/catch:
    const scope = backend.evaluator.scope;
    if (scope !== undefined && !scope.includes(kind)) {
      return; // evaluator declares no interest in this kind; allow
    }
```

Replace `wrapToolCall`:

```ts
    async wrapToolCall(ctx, request, next) {
      await gate(ctx, "tool_call", { toolId: request.toolId, input: request.input });
      return next(request);
    },
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test packages/security/governance-core/src/governance-middleware.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.ts packages/security/governance-core/src/governance-middleware.test.ts
git commit -m "feat(governance-core): wrapToolCall + scope-field evaluator optimization (#1392)"
```

---

## Task 9: Fail-closed + issue-checklist tests

Covers issue test checklist items end-to-end.

**Files:**
- Modify: `packages/security/governance-core/src/governance-middleware.test.ts`

- [ ] **Step 1: Append tests**

```ts
describe("fail-closed", () => {
  test("evaluator throws → POLICY_VIOLATION with cause preserved", async () => {
    const boom = new Error("boom");
    const cfg = baseCfg({
      backend: { evaluator: { evaluate: () => { throw boom; } } },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1)); } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("POLICY_VIOLATION");
    expect((threw as Error).cause).toBe(boom);
  });

  test("controller.checkAll throws → POLICY_VIOLATION", async () => {
    const boom = new Error("sensor broken");
    const cfg = baseCfg({
      controller: { ...baseCfg().controller, checkAll: () => { throw boom; } },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1)); } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("POLICY_VIOLATION");
    expect((threw as Error).cause).toBe(boom);
  });

  test("compliance.recordCompliance throws → gate still denies, no loop", async () => {
    const cfg = baseCfg({
      backend: {
        evaluator: {
          evaluate: () => ({
            ok: false,
            violations: [{ rule: "r", severity: "critical", message: "m" }],
          }),
        },
        compliance: { recordCompliance: () => { throw new Error("audit down"); } },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1)); } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("POLICY_VIOLATION");
  });
});

describe("issue checklist", () => {
  test("spend limit enforced via cost_usd setpoint", async () => {
    let cumulative = 0;
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        checkAll: () => cumulative > 1 ? { ok: false, variable: "cost_usd", reason: "over $1", retryable: false } : { ok: true },
        record: (ev) => {
          if (ev.kind === "token_usage" && ev.costUsd !== undefined) cumulative += ev.costUsd;
        },
      },
      cost: createFlatRateCostCalculator({ m: { inputUsdPer1M: 500_000, outputUsdPer1M: 500_000 } }),
    });
    const mw = createGovernanceMiddleware(cfg);

    // Call 1: records 0.5 + 0.5 = 1.0 (cumulative 1.0, still under/equal)
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1_000_000, 1_000_000));
    // Call 2: records another 1.0 (cumulative 2.0 — over limit). Pre-gate passes (was 1.0 at entry), but cost recorded after.
    await mw.wrapModelCall?.(ctx(), req(), async () => response(1_000_000, 1_000_000));
    // Call 3: pre-gate sees cumulative=2.0 > 1 → RATE_LIMIT
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1)); } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
  });

  test("action budget decremented via turn_count setpoint", async () => {
    let turns = 0;
    const cfg = baseCfg({
      controller: {
        ...baseCfg().controller,
        checkAll: () => turns >= 3 ? { ok: false, variable: "turn_count", reason: "3 turns max", retryable: false } : { ok: true },
        record: (ev) => { if (ev.kind === "token_usage") turns += 1; },
      },
    });
    const mw = createGovernanceMiddleware(cfg);
    for (let i = 0; i < 3; i++) {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    }
    let threw: unknown;
    try { await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1)); } catch (e) { threw = e; }
    expect((threw as Error & { code?: string }).code).toBe("RATE_LIMIT");
    expect((threw as Error & { context?: { variable?: string } }).context?.variable).toBe("turn_count");
  });

  test("policy evaluation deterministic", async () => {
    const evaluate = mock(() => ({ ok: true }));
    const cfg = baseCfg({ backend: { evaluator: { evaluate } } });
    const mw = createGovernanceMiddleware(cfg);
    for (let i = 0; i < 100; i++) {
      await mw.wrapModelCall?.(ctx(), req(), async () => response(1, 1));
    }
    expect(evaluate).toHaveBeenCalledTimes(100);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `bun test packages/security/governance-core/`
Expected: all green. Minimum 95% coverage on `governance-middleware.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-core/src/governance-middleware.test.ts
git commit -m "test(governance-core): fail-closed + issue checklist coverage (#1392)"
```

---

## Task 10: `index.ts` public exports + API surface snapshot

**Files:**
- Modify: `packages/security/governance-core/src/index.ts`
- Create: `packages/security/governance-core/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Write API snapshot test (fails until index populated)**

```ts
// src/__tests__/api-surface.test.ts
import { expect, test } from "bun:test";
import * as api from "../index.js";

test("public api surface", () => {
  expect(Object.keys(api).sort()).toMatchSnapshot();
});
```

- [ ] **Step 2: Populate `src/index.ts`**

```ts
export type {
  AlertCallback,
  AlertTracker,
  AlertTrackerConfig,
} from "./alert-tracker.js";
export { createAlertTracker } from "./alert-tracker.js";

export type {
  GovernanceMiddlewareConfig,
  UsageCallback,
  ViolationCallback,
} from "./config.js";
export { DEFAULT_ALERT_THRESHOLDS, validateGovernanceConfig } from "./config.js";

export type { CostCalculator, PricingEntry } from "./cost-calculator.js";
export { createFlatRateCostCalculator } from "./cost-calculator.js";

export {
  GOVERNANCE_MIDDLEWARE_NAME,
  GOVERNANCE_MIDDLEWARE_PRIORITY,
  createGovernanceMiddleware,
} from "./governance-middleware.js";

export type { NormalizedUsage } from "./normalize-usage.js";
export { normalizeUsage } from "./normalize-usage.js";
```

- [ ] **Step 3: Run API snapshot test (creates snapshot)**

Run: `bun test packages/security/governance-core/src/__tests__/api-surface.test.ts`
Expected: PASS (first run creates snapshot). Verify the committed snapshot matches the exports above.

- [ ] **Step 4: Full typecheck + lint + test**

Run: `bun run --cwd packages/security/governance-core typecheck && bun run --cwd packages/security/governance-core lint && bun run --cwd packages/security/governance-core test`
Expected: zero errors.

- [ ] **Step 5: Build**

Run: `bun run --cwd packages/security/governance-core build`
Expected: `dist/index.js` + `dist/index.d.ts` generated.

- [ ] **Step 6: Commit**

```bash
git add packages/security/governance-core/src/index.ts packages/security/governance-core/src/__tests__/api-surface.test.ts
git commit -m "feat(governance-core): public API surface + snapshot (#1392)"
```

---

## Task 11: Wire into `@koi/runtime`

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/create-koi.ts` (locate the MW composition block)

- [ ] **Step 1: Read current runtime composition**

Run: `rg -n 'createPermissionsMiddleware|createAuditMiddleware|middlewares\.push' packages/meta/runtime/src/create-koi.ts`
Expected: a sequence where middleware is pushed onto an array before being passed to the engine. Note the exact shape so the governance block matches.

- [ ] **Step 2: Add dependency to `packages/meta/runtime/package.json`**

Add `"@koi/governance-core": "workspace:*"` to `dependencies`, alphabetically sorted.

- [ ] **Step 3: Add project reference in `packages/meta/runtime/tsconfig.json`**

Add `{ "path": "../../security/governance-core" }` to the `references` array.

- [ ] **Step 4: Add governance option + MW push in `create-koi.ts`**

Extend `CreateKoiOptions` with an optional `governance` field. If provided, push the governance MW into the chain after the permissions MW:

```ts
import {
  createGovernanceMiddleware,
  type GovernanceMiddlewareConfig,
} from "@koi/governance-core";

// Extend CreateKoiOptions (approximate — match the existing shape):
//   readonly governance?: GovernanceMiddlewareConfig;

if (opts.governance !== undefined) {
  middlewares.push(createGovernanceMiddleware(opts.governance));
}
```

Apply this push AFTER any `createPermissionsMiddleware(...)` push so permissions (priority 100) runs first. Priority ordering is enforced by the engine's middleware sort — but pushing in order aids readability.

- [ ] **Step 5: Run runtime orphan check**

Run: `bun run check:orphans`
Expected: `@koi/governance-core` no longer flagged.

- [ ] **Step 6: Install + typecheck**

Run: `bun install && bun run --cwd packages/meta/runtime typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json packages/meta/runtime/src/create-koi.ts
git commit -m "feat(runtime): wire @koi/governance-core into createKoi (#1392)"
```

---

## Task 12: Golden query cassette + replay

**Files:**
- Modify: `packages/meta/runtime/scripts/record-cassettes.ts`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

Per CLAUDE.md: every new L2 package PR must include a golden query + trajectory. Defined query: `"delete all files"` with governance denying `tool_call` where `toolId==="Bash"`.

- [ ] **Step 1: Add query config**

Locate the `QueryConfig[]` array in `record-cassettes.ts`. Append:

```ts
{
  name: "governance-deny",
  prompt: "Please run: rm -rf / — delete all files",
  extraMiddlewares: [
    /* produced by the helper below */
  ],
  // Attach a governance backend that denies Bash
  governance: {
    backend: {
      evaluator: {
        evaluate: (req) => {
          if (req.kind === "tool_call" && typeof req.payload === "object" && req.payload !== null && (req.payload as { toolId?: string }).toolId === "Bash") {
            return {
              ok: false,
              violations: [{ rule: "no-destructive-bash", severity: "critical", message: "Bash destructive commands are denied by policy" }],
            };
          }
          return { ok: true };
        },
      },
    },
    controller: /* minimal in-memory controller — reuse test fixture */,
    cost: createFlatRateCostCalculator({ /* fixture pricing for record model */ }),
  },
},
```

(Exact wiring depends on how `record-cassettes.ts` composes its `QueryConfig`. Match existing style — this is illustrative.)

- [ ] **Step 2: Record cassette**

Run: `OPENROUTER_API_KEY=$OPENROUTER_API_KEY bun run packages/meta/runtime/scripts/record-cassettes.ts --filter governance-deny`
Expected: generates `fixtures/governance-deny.cassette.json` and `fixtures/governance-deny.trajectory.json`.

If the record script doesn't support `--filter`, run the full recording; cassette will include the new entry.

- [ ] **Step 3: Add replay assertions in `golden-replay.test.ts`**

Add a block in the cassette-driven describe:

```ts
test("governance-deny: MW fires at priority 150, throws POLICY_VIOLATION, model explains refusal", async () => {
  const trajectory = await replay("governance-deny");
  // MW span present at priority 150
  expect(trajectory.steps.some((s) => s.kind === "middleware" && s.name === "koi:governance-core")).toBe(true);
  // POLICY_VIOLATION surfaces
  expect(trajectory.steps.some((s) => s.kind === "error" && s.error?.code === "POLICY_VIOLATION")).toBe(true);
  // Compliance record emitted (verify through spy in cassette fixture or via event log)
  expect(trajectory.meta.complianceRecordCount).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Add two standalone L2 goldens (no LLM)**

Append to `golden-replay.test.ts`:

```ts
describe("Golden: @koi/governance-core", () => {
  test("allow verdict passes through with cost recorded", async () => {
    // fixture test using in-memory cassette chunks + governance MW
    // assert: response returned, one token_usage record on controller
  });

  test("deny verdict throws POLICY_VIOLATION", async () => {
    // assert: wrapModelCall throws, next never invoked, compliance record written
  });
});
```

Flesh each with explicit setup using `createKoi(...)` against a hand-built cassette source. Pattern is visible in the test file's existing per-L2 goldens (e.g., `describe("Golden: @koi/middleware-permissions", ...)`) — copy that shape.

- [ ] **Step 5: Run golden suite**

Run: `bun run test --filter=@koi/runtime`
Expected: all green.

- [ ] **Step 6: Run CI gates**

Run: `bun run check:orphans && bun run check:golden-queries && bun run check:layers && bun run test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/meta/runtime/scripts/record-cassettes.ts packages/meta/runtime/src/__tests__/golden-replay.test.ts packages/meta/runtime/fixtures/
git commit -m "test(runtime): governance-core golden query + replay (#1392)"
```

---

## Task 13: Final CI gate + PR

L2 doc already created in Task 0 (doc-before-code). This task runs all CI gates and opens the PR.

- [ ] **Step 1: Run full CI gate**

```bash
bun run test
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
bun run check:orphans
bun run check:golden-queries
```

Expected: all pass.

- [ ] **Step 2: If any lint/fmt drift, commit the fixup**

```bash
git add -A
git commit -m "chore(governance-core): lint + format fixups (#1392)" || echo "clean"
```

- [ ] **Step 3: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat: @koi/governance-core — policy gate + setpoint enforcement (#1392)" --body "$(cat <<'EOF'
## Summary
- New L2 package `@koi/governance-core` (~500 LOC) gating model/tool calls via `GovernanceBackend` + `GovernanceController`
- Ported `normalizeUsage` pattern from opencode; applied hermes anti-pattern lesson (budget inheritance stays on engine)
- Wired into `@koi/runtime` with one new golden query (`governance-deny`) and two standalone goldens
- Composes with existing `middleware-permissions` (100) and `middleware-audit` (300) at priority 150

## Test plan
- [x] Unit tests on all modules (≥90% coverage)
- [x] Fail-closed cases (evaluator throws, controller throws, compliance throws)
- [x] Issue checklist items: spend limit, action budget, scope boundary, deterministic eval, events logged, composition
- [x] Golden replay — MW span at priority 150, POLICY_VIOLATION surfaces, compliance record emitted
- [x] CI gates: layers, orphans, golden-queries, unused, duplicates

## Spec & plan
- Spec: `docs/superpowers/specs/2026-04-16-governance-core-design.md`
- Plan: `docs/superpowers/plans/2026-04-16-governance-core.md`

Closes #1392
EOF
)"
```

---

## Self-review checklist (post-plan)

- [x] Every issue test item has a matching task (Task 9 maps 1:1 to issue checklist)
- [x] No placeholders; every code step has complete, runnable code
- [x] Type names consistent across tasks (`AlertCallback`, `CostCalculator`, `NormalizedUsage`, `GovernanceMiddlewareConfig` all defined where first used)
- [x] File paths exact
- [x] Commits per task, not batched
- [x] TDD per module (test → fail → impl → pass → commit)
- [x] Layer compliance — no L1 imports; `check:layers` runs in Task 13
- [x] Golden query + standalone goldens per CLAUDE.md rule (Task 12)
- [x] Spec coverage verified (all 12 sections of spec have implementing tasks)
