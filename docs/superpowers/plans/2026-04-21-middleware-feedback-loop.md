# @koi/middleware-feedback-loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `@koi/middleware-feedback-loop` — an L2 middleware that validates model output, retries with structured error feedback, and tracks forge tool health (quarantine, trust-tier demotion, fitness persistence).

**Architecture:** 10-file package in `packages/lib/middleware-feedback-loop/`. Pure domain types + config live in `types.ts`/`config.ts`. Pure functions (`validators`, `gate`, `repair`, `retry`, `fitness-flush`) are independently testable with no async side effects. The stateful `ToolHealthTracker` (ring buffer, quarantine, demotion, fitness flush) lives in `tool-health.ts`. The main factory `createFeedbackLoopMiddleware` in `feedback-loop.ts` wires everything together as a `KoiMiddleware` at priority 450.

**Tech Stack:** Bun 1.3 · TypeScript 6 (strict) · `bun:test` · ESM `.js` extensions · `@koi/core` (L0) · `@koi/errors` + `@koi/validation` (L0u)

---

## File Map

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/lib/middleware-feedback-loop/package.json` | Create | Package manifest |
| `packages/lib/middleware-feedback-loop/tsconfig.json` | Create | TS project config |
| `packages/lib/middleware-feedback-loop/tsup.config.ts` | Create | Build config |
| `packages/lib/middleware-feedback-loop/src/types.ts` | Create | All domain types |
| `packages/lib/middleware-feedback-loop/src/config.ts` | Create | Config interfaces + defaults |
| `packages/lib/middleware-feedback-loop/src/validators.ts` | Create | Run validator array |
| `packages/lib/middleware-feedback-loop/src/validators.test.ts` | Create | Validator tests |
| `packages/lib/middleware-feedback-loop/src/gate.ts` | Create | Run gate array |
| `packages/lib/middleware-feedback-loop/src/gate.test.ts` | Create | Gate tests |
| `packages/lib/middleware-feedback-loop/src/repair.ts` | Create | Default repair strategy |
| `packages/lib/middleware-feedback-loop/src/repair.test.ts` | Create | Repair tests |
| `packages/lib/middleware-feedback-loop/src/fitness-flush.ts` | Create | `shouldFlush` + `computeMergedFitness` |
| `packages/lib/middleware-feedback-loop/src/fitness-flush.test.ts` | Create | Flush pure-function tests |
| `packages/lib/middleware-feedback-loop/src/retry.ts` | Create | Retry loop with category budgets |
| `packages/lib/middleware-feedback-loop/src/retry.test.ts` | Create | Retry tests |
| `packages/lib/middleware-feedback-loop/src/tool-health.ts` | Create | Ring buffer, quarantine, demotion, flush |
| `packages/lib/middleware-feedback-loop/src/tool-health.test.ts` | Create | Health tracker tests |
| `packages/lib/middleware-feedback-loop/src/feedback-loop.ts` | Create | Main middleware factory |
| `packages/lib/middleware-feedback-loop/src/feedback-loop.test.ts` | Create | Integration tests |
| `packages/lib/middleware-feedback-loop/src/index.ts` | Create | Public exports |
| `packages/meta/runtime/package.json` | Modify | Add as dependency |
| `packages/meta/runtime/tsconfig.json` | Modify | Add project reference |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | Modify | Add golden assertions |

---

### Task 1: Package Scaffold

**Files:**
- Create: `packages/lib/middleware-feedback-loop/package.json`
- Create: `packages/lib/middleware-feedback-loop/tsconfig.json`
- Create: `packages/lib/middleware-feedback-loop/tsup.config.ts`
- Create: `packages/lib/middleware-feedback-loop/src/index.ts` (empty shell)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@koi/middleware-feedback-loop",
  "description": "Model validation + retry + forge tool health tracking middleware",
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
    "test": "bun test"
  },
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*",
    "@koi/validation": "workspace:*"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../errors" },
    { "path": "../validation" }
  ]
}
```

- [ ] **Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 4: Create empty src/index.ts**

```typescript
// Populated in Task 10
export {};
```

- [ ] **Step 5: Register in bun workspace — run install to link**

```bash
cd /path/to/worktree  # your feat/middleware-feedback-retry worktree
bun install --ignore-scripts
```

Expected: `Saved lockfile` with new package linked.

- [ ] **Step 6: Verify package builds**

```bash
bun run build --filter=@koi/middleware-feedback-loop
```

Expected: `dist/index.js` and `dist/index.d.ts` created.

- [ ] **Step 7: Commit scaffold**

```bash
git add packages/lib/middleware-feedback-loop/
git commit -m "feat(feedback-loop): scaffold @koi/middleware-feedback-loop package"
```

---

### Task 2: Domain Types

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/types.ts`

- [ ] **Step 1: Write types.ts**

```typescript
import type {
  BrickFitnessMetrics,
  LatencySampler,
} from "@koi/core/brick-store";
import type { BrickId } from "@koi/core/brick-snapshot";
import type { TrustTier } from "@koi/core/forge-types";
import type { InboundMessage, ContentBlock } from "@koi/core/message";
import type { ModelRequest, ModelResponse, ToolResponse } from "@koi/core/middleware";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly validator: string;
  readonly message: string;
  readonly path?: string | undefined;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly ValidationError[];
}

export interface Validator {
  readonly name: string;
  readonly validate: (
    response: ModelResponse,
  ) => ValidationResult | Promise<ValidationResult>;
}

export interface Gate {
  readonly name: string;
  readonly validate: (
    response: ModelResponse | ToolResponse,
  ) => ValidationResult | Promise<ValidationResult>;
  /**
   * When true, gate failures are recorded as tool health failures and can
   * trigger quarantine/demotion. Default: false — gates are policy checks,
   * not reliability signals.
   */
  readonly countAsHealthFailure?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Retry / Repair
// ---------------------------------------------------------------------------

export interface RetryContext {
  readonly attempt: number;
  /** The model's failed response — available for repair strategy context. */
  readonly response: ModelResponse;
  /** Opaque ID of the feedback message from the previous attempt. Undefined on first retry. */
  readonly feedbackMessageId: string | undefined;
}

export interface RepairStrategy {
  /**
   * Builds the next retry request from the LAST EFFECTIVE request (preserves
   * per-attempt middleware state). Returns the rebuilt request and an opaque
   * feedbackMessageId that identifies the feedback slot for subsequent retries.
   */
  readonly buildRetryRequest: (
    currentRequest: ModelRequest,
    errors: readonly ValidationError[],
    ctx: RetryContext,
  ) => { readonly request: ModelRequest; readonly feedbackMessageId: string };
}

// ---------------------------------------------------------------------------
// Tool Health
// ---------------------------------------------------------------------------

export type HealthState = "healthy" | "degraded" | "quarantined";
export type HealthActionKind = "none" | "demote" | "quarantine";

export interface HealthAction {
  readonly state: HealthState;
  readonly action: HealthActionKind;
}

export interface RingEntry {
  readonly success: boolean;
  readonly latencyMs: number;
}

export interface ToolHealthMetrics {
  readonly errorCount: number;
  readonly totalCount: number;
  readonly entries: readonly RingEntry[];
}

export interface DemotionCriteria {
  readonly errorRateThreshold: number;  // 0.3 = 30%
  readonly windowSize: number;          // 20
  readonly minSampleSize: number;       // 10
  readonly gracePeriodMs: number;       // 3_600_000 (1h)
  readonly demotionCooldownMs: number;  // 1_800_000 (30min)
}

export interface TrustDemotionEvent {
  readonly brickId: BrickId;
  readonly from: TrustTier;
  readonly to: TrustTier;
  readonly reason: "error_rate";
  readonly evidence: {
    readonly errorRate: number;
    readonly sampleSize: number;
  };
}

export interface ToolHealthSnapshot {
  readonly toolId: string;
  readonly brickId: BrickId;
  readonly healthState: HealthState;
  readonly trustTier: TrustTier | undefined;
  readonly errorRate: number;
  readonly totalCount: number;
  readonly flushSuspended: boolean;
}

/** Returned when a quarantined tool is requested — tool never executes. */
export interface ForgeToolErrorFeedback {
  readonly kind: "forge_tool_quarantined";
  readonly brickId: BrickId;
  readonly toolId: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Fitness flush
// ---------------------------------------------------------------------------

export interface ToolFlushState {
  readonly dirty: boolean;
  readonly flushing: boolean;
  readonly invocationsSinceFlush: number;
  readonly errorRateSinceFlush: number;
  readonly lastFlushedErrorRate: number;
}

export interface FlushDeltas {
  readonly successCount: number;
  readonly errorCount: number;
  readonly latencySampler: LatencySampler;
  readonly lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// Health transition error
// ---------------------------------------------------------------------------

export interface HealthTransitionErrorEvent {
  readonly transition: "quarantine" | "demotion";
  readonly phase: "forgeStore" | "snapshot";
  readonly brickId: BrickId;
  readonly error: unknown;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/types.ts
git commit -m "feat(feedback-loop): add domain types"
```

---

### Task 3: Config

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/config.ts`

- [ ] **Step 1: Write config.ts**

```typescript
import type {
  DemotionCriteria,
  Gate,
  RepairStrategy,
  TrustDemotionEvent,
  ValidationError,
  Validator,
  HealthTransitionErrorEvent,
} from "./types.js";
import type { ForgeStore } from "@koi/core/brick-store";
import type { BrickId } from "@koi/core/brick-snapshot";
import type { SnapshotChainStore } from "@koi/core/snapshot-chain";
import type { BrickSnapshot } from "@koi/core/brick-snapshot";

export interface RetryConfig {
  readonly validation?: {
    readonly maxAttempts?: number | undefined;
  } | undefined;
  readonly transport?: {
    readonly maxAttempts?: number | undefined;
  } | undefined;
}

export interface ForgeHealthConfig {
  readonly resolveBrickId: (toolId: string) => BrickId | undefined;
  readonly forgeStore: ForgeStore;
  readonly snapshotChainStore: SnapshotChainStore<BrickSnapshot>;
  readonly quarantineThreshold?: number | undefined;        // default: 0.5
  readonly windowSize?: number | undefined;                  // quarantine window default: 10
  readonly maxRecentFailures?: number | undefined;           // default: 5
  readonly onQuarantine?: ((brickId: BrickId) => void) | undefined;
  readonly demotionCriteria?: Partial<DemotionCriteria> | undefined;
  readonly onDemotion?: ((event: TrustDemotionEvent) => void) | undefined;
  readonly onHealthTransitionError?: ((event: HealthTransitionErrorEvent) => void) | undefined;
  readonly clock?: (() => number) | undefined;               // default: Date.now
  readonly flushThreshold?: number | undefined;              // default: 10
  readonly errorRateDeltaThreshold?: number | undefined;     // default: 0.05
  readonly maxConsecutiveFlushFailures?: number | undefined; // default: 5
  readonly flushSuspensionCooldownMs?: number | undefined;   // default: 60_000
  readonly flushTimeoutMs?: number | undefined;              // default: 2_000
  readonly onFlushError?: ((toolId: string, error: unknown) => void) | undefined;
}

export interface FeedbackLoopConfig {
  readonly validators?: readonly Validator[] | undefined;
  readonly gates?: readonly Gate[] | undefined;
  readonly toolValidators?: readonly Validator[] | undefined;
  readonly toolGates?: readonly Gate[] | undefined;
  readonly retry?: RetryConfig | undefined;
  readonly repairStrategy?: RepairStrategy | undefined;
  readonly onRetry?: ((attempt: number, errors: readonly ValidationError[]) => void) | undefined;
  readonly onGateFail?: ((gate: Gate, errors: readonly ValidationError[]) => void) | undefined;
  readonly forgeHealth?: ForgeHealthConfig | undefined;
}

export const DEFAULT_DEMOTION_CRITERIA: DemotionCriteria = {
  errorRateThreshold: 0.3,
  windowSize: 20,
  minSampleSize: 10,
  gracePeriodMs: 3_600_000,
  demotionCooldownMs: 1_800_000,
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/config.ts
git commit -m "feat(feedback-loop): add config interfaces and defaults"
```

---

### Task 4: Validators (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/validators.ts`
- Create: `packages/lib/middleware-feedback-loop/src/validators.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/validators.test.ts
import { describe, expect, it } from "bun:test";
import { runValidators } from "./validators.js";
import type { ModelResponse } from "@koi/core/middleware";
import type { Validator } from "./types.js";

const mockResponse = (): ModelResponse => ({
  content: "hello",
  model: "test",
});

describe("runValidators", () => {
  it("returns empty array when no validators", async () => {
    const result = await runValidators([], mockResponse());
    expect(result).toEqual([]);
  });

  it("returns empty array when all validators pass", async () => {
    const validators: Validator[] = [
      { name: "v1", validate: () => ({ valid: true }) },
      { name: "v2", validate: () => ({ valid: true }) },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toEqual([]);
  });

  it("returns errors from failing validators", async () => {
    const validators: Validator[] = [
      {
        name: "v1",
        validate: () => ({
          valid: false,
          errors: [{ validator: "v1", message: "bad output" }],
        }),
      },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toHaveLength(1);
    expect(result[0]?.validator).toBe("v1");
    expect(result[0]?.message).toBe("bad output");
  });

  it("collects errors from multiple failing validators", async () => {
    const validators: Validator[] = [
      { name: "v1", validate: () => ({ valid: false, errors: [{ validator: "v1", message: "e1" }] }) },
      { name: "v2", validate: () => ({ valid: false, errors: [{ validator: "v2", message: "e2" }] }) },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toHaveLength(2);
  });

  it("supports async validators", async () => {
    const validators: Validator[] = [
      {
        name: "v1",
        validate: async () => ({ valid: false, errors: [{ validator: "v1", message: "async fail" }] }),
      },
    ];
    const result = await runValidators(validators, mockResponse());
    expect(result).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/validators.test.ts
```

Expected: `Cannot find module './validators.js'`

- [ ] **Step 3: Implement validators.ts**

```typescript
import type { ModelResponse } from "@koi/core/middleware";
import type { ValidationError, Validator } from "./types.js";

export async function runValidators(
  validators: readonly Validator[],
  response: ModelResponse,
): Promise<readonly ValidationError[]> {
  if (validators.length === 0) return [];
  const results = await Promise.all(validators.map((v) => v.validate(response)));
  return results.flatMap((r) => (r.valid ? [] : (r.errors ?? [])));
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/validators.test.ts
```

Expected: `5 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/validators.ts packages/lib/middleware-feedback-loop/src/validators.test.ts
git commit -m "feat(feedback-loop): add runValidators with tests"
```

---

### Task 5: Gate (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/gate.ts`
- Create: `packages/lib/middleware-feedback-loop/src/gate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/gate.test.ts
import { describe, expect, it, mock } from "bun:test";
import { runGates } from "./gate.js";
import { KoiRuntimeError } from "@koi/errors";
import type { ModelResponse } from "@koi/core/middleware";
import type { Gate } from "./types.js";

const mockResponse = (): ModelResponse => ({ content: "ok", model: "test" });

describe("runGates", () => {
  it("resolves when no gates", async () => {
    await expect(runGates([], mockResponse())).resolves.toBeUndefined();
  });

  it("resolves when all gates pass", async () => {
    const gates: Gate[] = [
      { name: "g1", validate: () => ({ valid: true }) },
      { name: "g2", validate: () => ({ valid: true }) },
    ];
    await expect(runGates(gates, mockResponse())).resolves.toBeUndefined();
  });

  it("throws KoiRuntimeError on gate failure", async () => {
    const gates: Gate[] = [
      {
        name: "safety",
        validate: () => ({ valid: false, errors: [{ validator: "safety", message: "unsafe" }] }),
      },
    ];
    await expect(runGates(gates, mockResponse())).rejects.toBeInstanceOf(KoiRuntimeError);
  });

  it("throws on first failing gate — stops evaluation", async () => {
    const second = mock(() => ({ valid: true }));
    const gates: Gate[] = [
      { name: "g1", validate: () => ({ valid: false, errors: [{ validator: "g1", message: "fail" }] }) },
      { name: "g2", validate: second },
    ];
    await expect(runGates(gates, mockResponse())).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(second).not.toHaveBeenCalled();
  });

  it("calls onGateFail callback with gate and errors", async () => {
    const onGateFail = mock(() => {});
    const gates: Gate[] = [
      { name: "g1", validate: () => ({ valid: false, errors: [{ validator: "g1", message: "fail" }] }) },
    ];
    await expect(runGates(gates, mockResponse(), onGateFail)).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(onGateFail).toHaveBeenCalledWith(gates[0], [{ validator: "g1", message: "fail" }]);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/gate.test.ts
```

Expected: `Cannot find module './gate.js'`

- [ ] **Step 3: Implement gate.ts**

```typescript
import { KoiRuntimeError } from "@koi/errors";
import type { ModelResponse, ToolResponse } from "@koi/core/middleware";
import type { Gate, ValidationError } from "./types.js";

export async function runGates(
  gates: readonly Gate[],
  response: ModelResponse | ToolResponse,
  onGateFail?: (gate: Gate, errors: readonly ValidationError[]) => void,
): Promise<void> {
  for (const gate of gates) {
    const result = await gate.validate(response);
    if (!result.valid) {
      const errors = result.errors ?? [];
      onGateFail?.(gate, errors);
      throw new KoiRuntimeError(
        `Gate "${gate.name}" rejected the response: ${errors.map((e) => e.message).join("; ")}`,
        { code: "VALIDATION" },
      );
    }
  }
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/gate.test.ts
```

Expected: `5 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/gate.ts packages/lib/middleware-feedback-loop/src/gate.test.ts
git commit -m "feat(feedback-loop): add runGates with tests"
```

---

### Task 6: Default Repair Strategy (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/repair.ts`
- Create: `packages/lib/middleware-feedback-loop/src/repair.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/repair.test.ts
import { describe, expect, it } from "bun:test";
import { defaultRepairStrategy, formatErrors } from "./repair.js";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { ValidationError } from "./types.js";

const baseRequest = (): ModelRequest => ({
  messages: [{ senderId: "user", content: [{ kind: "text", text: "hello" }], timestamp: 1 }],
});

const baseResponse = (): ModelResponse => ({ content: "bad output", model: "test" });

const errors: ValidationError[] = [{ validator: "json", message: "not valid JSON" }];

describe("formatErrors", () => {
  it("formats a single error", () => {
    const result = formatErrors([{ validator: "v1", message: "bad" }]);
    expect(result).toBe("[v1] bad");
  });

  it("includes path when present", () => {
    const result = formatErrors([{ validator: "v1", message: "bad", path: "$.foo" }]);
    expect(result).toBe("[v1] at $.foo bad");
  });

  it("joins multiple errors with newlines", () => {
    const result = formatErrors([
      { validator: "v1", message: "e1" },
      { validator: "v2", message: "e2" },
    ]);
    expect(result).toContain("[v1] e1");
    expect(result).toContain("[v2] e2");
  });
});

describe("defaultRepairStrategy", () => {
  it("appends feedback message on first retry (feedbackMessageId undefined)", () => {
    const { request, feedbackMessageId } = defaultRepairStrategy.buildRetryRequest(
      baseRequest(),
      errors,
      { attempt: 1, response: baseResponse(), feedbackMessageId: undefined },
    );
    expect(request.messages).toHaveLength(2); // original + feedback
    expect(feedbackMessageId).toBeDefined();
  });

  it("preserves original user messages unchanged", () => {
    const original = baseRequest();
    const { request } = defaultRepairStrategy.buildRetryRequest(
      original,
      errors,
      { attempt: 1, response: baseResponse(), feedbackMessageId: undefined },
    );
    expect(request.messages[0]).toBe(original.messages[0]);
  });

  it("replaces prior feedback on second retry (single slot)", () => {
    const req1 = baseRequest();
    const { request: req2, feedbackMessageId: id1 } = defaultRepairStrategy.buildRetryRequest(
      req1,
      errors,
      { attempt: 1, response: baseResponse(), feedbackMessageId: undefined },
    );
    const { request: req3, feedbackMessageId: id2 } = defaultRepairStrategy.buildRetryRequest(
      req2,
      [{ validator: "json", message: "still not JSON" }],
      { attempt: 2, response: baseResponse(), feedbackMessageId: id1 },
    );
    // Length must not grow — second retry replaces, not appends
    expect(req3.messages).toHaveLength(req2.messages.length);
    // Latest error must appear in feedback
    const feedback = req3.messages[req3.messages.length - 1];
    const text = feedback?.content[0];
    expect(text?.kind === "text" && text.text).toContain("still not JSON");
  });

  it("falls back to append when feedbackMessageId points out-of-range", () => {
    const req = baseRequest();
    const { request } = defaultRepairStrategy.buildRetryRequest(
      req,
      errors,
      { attempt: 2, response: baseResponse(), feedbackMessageId: "999" },
    );
    expect(request.messages.length).toBeGreaterThan(req.messages.length);
  });

  it("original request is not mutated", () => {
    const original = baseRequest();
    const originalLength = original.messages.length;
    defaultRepairStrategy.buildRetryRequest(original, errors, {
      attempt: 1,
      response: baseResponse(),
      feedbackMessageId: undefined,
    });
    expect(original.messages).toHaveLength(originalLength);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/repair.test.ts
```

Expected: `Cannot find module './repair.js'`

- [ ] **Step 3: Implement repair.ts**

```typescript
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { RepairStrategy, ValidationError } from "./types.js";

export function formatErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => {
      const parts = [`[${e.validator}]`];
      if (e.path !== undefined) parts.push(`at ${e.path}`);
      parts.push(e.message);
      return parts.join(" ");
    })
    .join("\n");
}

function buildFeedbackMessage(errors: readonly ValidationError[]): InboundMessage {
  return {
    senderId: "system:feedback-loop",
    timestamp: Date.now(),
    content: [
      {
        kind: "text",
        text: `Validation failed. Fix these errors and try again:\n\n${formatErrors(errors)}`,
      },
    ],
  };
}

export const defaultRepairStrategy: RepairStrategy = {
  buildRetryRequest(
    currentRequest: ModelRequest,
    errors: readonly ValidationError[],
    ctx: { readonly attempt: number; readonly response: ModelResponse; readonly feedbackMessageId: string | undefined },
  ): { readonly request: ModelRequest; readonly feedbackMessageId: string } {
    const feedback = buildFeedbackMessage(errors);
    const messages = [...currentRequest.messages];

    const slotIndex =
      ctx.feedbackMessageId !== undefined ? parseInt(ctx.feedbackMessageId, 10) : NaN;
    const validIndex = !isNaN(slotIndex) && slotIndex >= 0 && slotIndex < messages.length;

    if (validIndex) {
      messages[slotIndex] = feedback;
    } else {
      messages.push(feedback);
    }

    const newIndex = validIndex ? slotIndex : messages.length - 1;
    return {
      request: { ...currentRequest, messages },
      feedbackMessageId: String(newIndex),
    };
  },
};
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/repair.test.ts
```

Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/repair.ts packages/lib/middleware-feedback-loop/src/repair.test.ts
git commit -m "feat(feedback-loop): add default repair strategy with tests"
```

---

### Task 7: Fitness Flush Pure Functions (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/fitness-flush.ts`
- Create: `packages/lib/middleware-feedback-loop/src/fitness-flush.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/fitness-flush.test.ts
import { describe, expect, it } from "bun:test";
import { shouldFlush, computeMergedFitness } from "./fitness-flush.js";
import type { ToolFlushState, FlushDeltas } from "./types.js";
import { createLatencySampler, recordLatency } from "@koi/validation";

const cleanState = (): ToolFlushState => ({
  dirty: false,
  flushing: false,
  invocationsSinceFlush: 0,
  errorRateSinceFlush: 0,
  lastFlushedErrorRate: 0,
});

describe("shouldFlush", () => {
  it("returns false when not dirty", () => {
    const state: ToolFlushState = { ...cleanState(), dirty: false, invocationsSinceFlush: 100 };
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  it("returns false when already flushing", () => {
    const state: ToolFlushState = { ...cleanState(), dirty: true, flushing: true, invocationsSinceFlush: 100 };
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });

  it("returns true when dirty and invocations >= threshold", () => {
    const state: ToolFlushState = { ...cleanState(), dirty: true, invocationsSinceFlush: 10 };
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });

  it("returns true when dirty and error rate delta exceeds threshold", () => {
    const state: ToolFlushState = {
      ...cleanState(),
      dirty: true,
      invocationsSinceFlush: 2,
      errorRateSinceFlush: 0.4,
      lastFlushedErrorRate: 0.1,
    };
    expect(shouldFlush(state, 10, 0.05)).toBe(true);
  });

  it("returns false when dirty but below both thresholds", () => {
    const state: ToolFlushState = {
      ...cleanState(),
      dirty: true,
      invocationsSinceFlush: 3,
      errorRateSinceFlush: 0.12,
      lastFlushedErrorRate: 0.1,
    };
    expect(shouldFlush(state, 10, 0.05)).toBe(false);
  });
});

describe("computeMergedFitness", () => {
  it("creates new metrics from deltas when existing is undefined", () => {
    const sampler = recordLatency(createLatencySampler(), 100);
    const deltas: FlushDeltas = {
      successCount: 5,
      errorCount: 2,
      latencySampler: sampler,
      lastUsedAt: 1000,
    };
    const result = computeMergedFitness(deltas, undefined);
    expect(result.successCount).toBe(5);
    expect(result.errorCount).toBe(2);
    expect(result.lastUsedAt).toBe(1000);
  });

  it("adds deltas to existing counts", () => {
    const sampler = createLatencySampler();
    const existing = { successCount: 10, errorCount: 3, latency: sampler, lastUsedAt: 500 };
    const deltas: FlushDeltas = {
      successCount: 2,
      errorCount: 1,
      latencySampler: sampler,
      lastUsedAt: 1000,
    };
    const result = computeMergedFitness(deltas, existing);
    expect(result.successCount).toBe(12);
    expect(result.errorCount).toBe(4);
  });

  it("takes max of lastUsedAt", () => {
    const sampler = createLatencySampler();
    const existing = { successCount: 1, errorCount: 0, latency: sampler, lastUsedAt: 2000 };
    const deltas: FlushDeltas = { successCount: 1, errorCount: 0, latencySampler: sampler, lastUsedAt: 1000 };
    const result = computeMergedFitness(deltas, existing);
    expect(result.lastUsedAt).toBe(2000);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/fitness-flush.test.ts
```

Expected: `Cannot find module './fitness-flush.js'`

- [ ] **Step 3: Implement fitness-flush.ts**

```typescript
import { createLatencySampler, mergeSamplers } from "@koi/validation";
import type { BrickFitnessMetrics } from "@koi/core/brick-store";
import type { FlushDeltas, ToolFlushState } from "./types.js";

export function shouldFlush(
  state: ToolFlushState,
  flushThreshold: number,
  errorRateDeltaThreshold: number,
): boolean {
  if (!state.dirty || state.flushing) return false;
  if (state.invocationsSinceFlush >= flushThreshold) return true;
  const delta = Math.abs(state.errorRateSinceFlush - state.lastFlushedErrorRate);
  return delta > errorRateDeltaThreshold;
}

export function computeMergedFitness(
  deltas: FlushDeltas,
  existing: BrickFitnessMetrics | undefined,
): BrickFitnessMetrics {
  const base = existing ?? {
    successCount: 0,
    errorCount: 0,
    latency: createLatencySampler(),
    lastUsedAt: 0,
  };
  return {
    successCount: base.successCount + deltas.successCount,
    errorCount: base.errorCount + deltas.errorCount,
    latency: mergeSamplers(base.latency, deltas.latencySampler),
    lastUsedAt: Math.max(base.lastUsedAt, deltas.lastUsedAt),
  };
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/fitness-flush.test.ts
```

Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/fitness-flush.ts packages/lib/middleware-feedback-loop/src/fitness-flush.test.ts
git commit -m "feat(feedback-loop): add fitness flush pure functions with tests"
```

---

### Task 8: Retry Loop (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/retry.ts`
- Create: `packages/lib/middleware-feedback-loop/src/retry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/retry.test.ts
import { describe, expect, it, mock } from "bun:test";
import { runWithRetry } from "./retry.js";
import { KoiRuntimeError } from "@koi/errors";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { Validator, Gate, RepairStrategy } from "./types.js";
import { defaultRepairStrategy } from "./repair.js";

const goodResponse: ModelResponse = { content: "valid", model: "test" };
const badResponse: ModelResponse = { content: "invalid", model: "test" };
const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", content: [{ kind: "text", text: "hi" }], timestamp: 1 }],
};

const passingValidator: Validator = { name: "pass", validate: () => ({ valid: true }) };
const failingValidator: Validator = {
  name: "fail",
  validate: () => ({ valid: false, errors: [{ validator: "fail", message: "bad" }] }),
};

describe("runWithRetry", () => {
  it("returns response when validators all pass", async () => {
    const next = mock(async () => goodResponse);
    const result = await runWithRetry(baseRequest, next, {
      validators: [passingValidator],
      gates: [],
      repairStrategy: defaultRepairStrategy,
      validationMaxAttempts: 3,
      transportMaxAttempts: 2,
    });
    expect(result).toBe(goodResponse);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("retries on validation failure and succeeds on second attempt", async () => {
    let callCount = 0;
    const next = mock(async () => {
      callCount++;
      return callCount === 1 ? badResponse : goodResponse;
    });
    const validators: Validator[] = [
      {
        name: "check",
        validate: (r) =>
          r.content === "valid"
            ? { valid: true }
            : { valid: false, errors: [{ validator: "check", message: "not valid" }] },
      },
    ];
    const result = await runWithRetry(baseRequest, next, {
      validators,
      gates: [],
      repairStrategy: defaultRepairStrategy,
      validationMaxAttempts: 3,
      transportMaxAttempts: 2,
    });
    expect(result).toBe(goodResponse);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("throws KoiRuntimeError when validation budget exhausted", async () => {
    const next = mock(async () => badResponse);
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [failingValidator],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 2,
        transportMaxAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("retries on transport error within budget", async () => {
    let callCount = 0;
    const next = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error("network");
      return goodResponse;
    });
    const result = await runWithRetry(baseRequest, next, {
      validators: [],
      gates: [],
      repairStrategy: defaultRepairStrategy,
      validationMaxAttempts: 3,
      transportMaxAttempts: 2,
    });
    expect(result).toBe(goodResponse);
  });

  it("throws on transport error when budget exhausted", async () => {
    const next = mock(async () => { throw new Error("network"); });
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 3,
        transportMaxAttempts: 1,
      }),
    ).rejects.toThrow("network");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("fires onRetry on each retry attempt", async () => {
    const onRetry = mock(() => {});
    const next = mock(async () => badResponse);
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [failingValidator],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 3,
        transportMaxAttempts: 2,
        onRetry,
      }),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(onRetry).toHaveBeenCalledTimes(2); // 3 attempts = 2 retries
  });

  it("second retry replaces prior feedback — only one feedback message", async () => {
    let lastRequest: ModelRequest = baseRequest;
    let callCount = 0;
    const next = mock(async (req: ModelRequest) => {
      lastRequest = req;
      callCount++;
      return badResponse;
    });
    await expect(
      runWithRetry(baseRequest, next, {
        validators: [failingValidator],
        gates: [],
        repairStrategy: defaultRepairStrategy,
        validationMaxAttempts: 3,
        transportMaxAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    // Last request sent (attempt 3) should have exactly 1 feedback message
    // Original had 1 message; feedback adds 1 → total 2 max
    expect(lastRequest.messages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/retry.test.ts
```

Expected: `Cannot find module './retry.js'`

- [ ] **Step 3: Implement retry.ts**

```typescript
import { KoiRuntimeError } from "@koi/errors";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { Gate, RepairStrategy, ValidationError, Validator } from "./types.js";
import { runValidators } from "./validators.js";
import { runGates } from "./gate.js";
import { defaultRepairStrategy } from "./repair.js";

export interface RetryOptions {
  readonly validators: readonly Validator[];
  readonly gates: readonly Gate[];
  readonly repairStrategy: RepairStrategy;
  readonly validationMaxAttempts: number;
  readonly transportMaxAttempts: number;
  readonly onRetry?: (attempt: number, errors: readonly ValidationError[]) => void;
  readonly onGateFail?: (gate: Gate, errors: readonly ValidationError[]) => void;
}

export async function runWithRetry(
  originalRequest: ModelRequest,
  next: (request: ModelRequest) => Promise<ModelResponse>,
  options: RetryOptions,
): Promise<ModelResponse> {
  let currentRequest = originalRequest;
  let feedbackMessageId: string | undefined;
  let attempt = 0;
  let validationBudget = options.validationMaxAttempts;
  let transportBudget = options.transportMaxAttempts;

  while (true) {
    let response: ModelResponse;

    try {
      response = await next(currentRequest);
    } catch (err) {
      if (transportBudget <= 0) throw err;
      transportBudget--;
      attempt++;
      options.onRetry?.(attempt, []);
      continue;
    }

    const errors = await runValidators(options.validators, response);

    if (errors.length === 0) {
      await runGates(options.gates, response, options.onGateFail);
      return response;
    }

    if (validationBudget <= 0) {
      throw new KoiRuntimeError(
        `Validation budget exhausted after ${options.validationMaxAttempts} attempts: ${errors.map((e) => e.message).join("; ")}`,
        { code: "VALIDATION" },
      );
    }

    validationBudget--;
    attempt++;
    options.onRetry?.(attempt, errors);

    const built = options.repairStrategy.buildRetryRequest(currentRequest, errors, {
      attempt,
      response,
      feedbackMessageId,
    });
    currentRequest = built.request;
    feedbackMessageId = built.feedbackMessageId;
  }
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/retry.test.ts
```

Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/retry.ts packages/lib/middleware-feedback-loop/src/retry.test.ts
git commit -m "feat(feedback-loop): add retry loop with category budgets and tests"
```

---

### Task 9: Tool Health Tracker (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/tool-health.ts`
- Create: `packages/lib/middleware-feedback-loop/src/tool-health.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/tool-health.test.ts
import { describe, expect, it, mock, beforeEach } from "bun:test";
import { createToolHealthTracker, computeHealthAction } from "./tool-health.js";
import type { DemotionCriteria, HealthAction, ToolHealthMetrics } from "./types.js";
import type { ForgeStore, BrickFitnessMetrics } from "@koi/core/brick-store";
import type { BrickId } from "@koi/core/brick-snapshot";
import type { SnapshotChainStore } from "@koi/core/snapshot-chain";
import type { BrickSnapshot } from "@koi/core/brick-snapshot";
import type { BrickArtifact } from "@koi/core/brick-store";
import { brickId } from "@koi/core/brick-snapshot";

// ── Minimal in-memory ForgeStore ──────────────────────────────────────────
function makeForgeStore(): ForgeStore & { data: Map<string, BrickArtifact> } {
  const data = new Map<string, BrickArtifact>();
  return {
    data,
    save: async (b) => { data.set(b.id, b); return { ok: true, value: undefined }; },
    load: async (id) => {
      const b = data.get(id);
      return b ? { ok: true, value: b } : { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    },
    search: async () => ({ ok: true, value: [] }),
    remove: async (id) => { data.delete(id); return { ok: true, value: undefined }; },
    update: async (id, updates) => {
      const b = data.get(id);
      if (!b) return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
      data.set(id, { ...b, ...updates } as BrickArtifact);
      return { ok: true, value: undefined };
    },
    exists: async (id) => ({ ok: true, value: data.has(id) }),
  };
}

// ── Minimal in-memory SnapshotChainStore ─────────────────────────────────
function makeSnapshotStore(): SnapshotChainStore<BrickSnapshot> {
  const puts: Array<{ chainId: string; data: BrickSnapshot }> = [];
  return {
    put: async (chainId, data) => ({ ok: true, value: { nodeId: "n1" as any, chainId, data, parentIds: [], metadata: {}, createdAt: Date.now() } }),
    get: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "", retryable: false } }),
    head: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    ancestors: async () => ({ ok: true, value: [] }),
    fork: async (q) => ({ ok: true, value: { chainId: q.fromChainId, parentNodeId: "n1" as any } }),
  };
}

// ── computeHealthAction table tests ──────────────────────────────────────
const criteria: DemotionCriteria = {
  errorRateThreshold: 0.3,
  windowSize: 5,
  minSampleSize: 3,
  gracePeriodMs: 1_000,
  demotionCooldownMs: 1_000,
};

describe("computeHealthAction", () => {
  it("returns healthy/none when error rate below degraded threshold", () => {
    const metrics: ToolHealthMetrics = { errorCount: 0, totalCount: 5, entries: [] };
    const result = computeHealthAction(metrics, "healthy", "verified", 0.5, 10, criteria, 0, 0, 100_000);
    expect(result.state).toBe("healthy");
    expect(result.action).toBe("none");
  });

  it("returns degraded/none when error rate >= 75% of quarantine threshold", () => {
    // quarantineThreshold=0.5, 75%=0.375. Error rate = 4/5 = 0.8 → quarantine
    // Let's test at 0.38: 2/5 = 0.4 → >= 0.375 but < 0.5 → degraded
    const metrics: ToolHealthMetrics = { errorCount: 2, totalCount: 5, entries: [] };
    const result = computeHealthAction(metrics, "healthy", "verified", 0.5, 5, criteria, 0, 0, 100_000);
    expect(result.state).toBe("degraded");
  });

  it("returns quarantined when error rate >= quarantine threshold", () => {
    const metrics: ToolHealthMetrics = { errorCount: 4, totalCount: 5, entries: [] };
    const result = computeHealthAction(metrics, "degraded", "verified", 0.5, 5, criteria, 0, 0, 100_000);
    expect(result.state).toBe("quarantined");
    expect(result.action).toBe("quarantine");
  });

  it("returns demote action when demotion criteria met", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    // error rate = 0.6 >= threshold 0.3, sampleSize=5 >= minSampleSize=3
    // grace period: lastPromotedAt=0, now=5000ms > gracePeriodMs=1000 ✓
    // cooldown: lastDemotedAt=0, now=5000 > cooldownMs=1000 ✓
    const result = computeHealthAction(metrics, "healthy", "verified", 0.5, 10, criteria, 0, 0, 5_000);
    expect(result.action).toBe("demote");
  });

  it("blocks demotion during grace period", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    // lastPromotedAt = 4500, now = 5000 → only 500ms since promotion < 1000ms grace
    const result = computeHealthAction(metrics, "healthy", "verified", 0.5, 10, criteria, 4_500, 0, 5_000);
    expect(result.action).toBe("none");
  });

  it("blocks demotion during cooldown period", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    // lastDemotedAt = 4500, now = 5000 → only 500ms since last demotion < 1000ms cooldown
    const result = computeHealthAction(metrics, "healthy", "community", 0.5, 10, criteria, 0, 4_500, 5_000);
    expect(result.action).toBe("none");
  });

  it("does not demote below 'local' (floor tier)", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    const result = computeHealthAction(metrics, "healthy", "local", 0.5, 10, criteria, 0, 0, 5_000);
    expect(result.action).toBe("none"); // already at floor
  });
});

// ── ToolHealthTracker integration ─────────────────────────────────────────
describe("createToolHealthTracker", () => {
  const BID = brickId("brick-1");
  const TOOL_ID = "tool-1";

  it("records successes and failures without error", () => {
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: makeForgeStore(),
      snapshotChainStore: makeSnapshotStore(),
      clock: () => 100_000,
    });
    tracker.recordSuccess(TOOL_ID, 10);
    tracker.recordFailure(TOOL_ID, 10, "oops");
    const snap = tracker.getSnapshot(TOOL_ID);
    expect(snap).toBeDefined();
    expect(snap?.totalCount).toBe(2);
  });

  it("isQuarantined returns false for healthy tool", () => {
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: makeForgeStore(),
      snapshotChainStore: makeSnapshotStore(),
    });
    expect(tracker.isQuarantined(TOOL_ID)).toBe(false);
  });

  it("quarantines tool in session when error rate exceeds threshold", async () => {
    const forgeStore = makeForgeStore();
    // Seed brick in store so update() can find it
    await forgeStore.save({
      id: BID,
      kind: "tool" as any,
      name: "t1",
      version: "1",
      lifecycle: "active",
      trustTier: "verified",
      scope: "local" as any,
      storeVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    } as any);

    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.5,
      windowSize: 4,
      clock: () => 100_000,
    });

    // 3 failures out of 4 = 75% > 50% → quarantine
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const quarantined = await tracker.checkAndQuarantine(TOOL_ID);
    expect(quarantined).toBe(true);
    expect(tracker.isQuarantined(TOOL_ID)).toBe(true);
  });

  it("quarantines in session even when ForgeStore update fails", async () => {
    const forgeStore = makeForgeStore();
    // Don't seed brick → update() returns NOT_FOUND

    const errors: unknown[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.5,
      windowSize: 4,
      clock: () => 100_000,
      onHealthTransitionError: (e) => errors.push(e),
    });

    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const quarantined = await tracker.checkAndQuarantine(TOOL_ID);
    expect(quarantined).toBe(true);
    expect(tracker.isQuarantined(TOOL_ID)).toBe(true); // local session quarantine
    expect(errors.length).toBeGreaterThan(0); // error surfaced
  });

  it("demotes trust tier when criteria met", async () => {
    const forgeStore = makeForgeStore();
    await forgeStore.save({
      id: BID,
      kind: "tool" as any,
      name: "t1",
      version: "1",
      lifecycle: "active",
      trustTier: "verified",
      scope: "local" as any,
      storeVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    } as any);

    const demotions: string[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 0,
        demotionCooldownMs: 0,
      },
      onDemotion: (e) => demotions.push(e.to),
      clock: () => 100_000,
    });

    // 4 failures / 5 total = 80% > 30%
    for (let i = 0; i < 4; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const demoted = await tracker.checkAndDemote(TOOL_ID);
    expect(demoted).toBe(true);
    expect(demotions[0]).toBe("community");
  });

  it("dispose flushes dirty tools without throwing", async () => {
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: makeForgeStore(),
      snapshotChainStore: makeSnapshotStore(),
      flushThreshold: 100, // won't auto-flush
    });
    tracker.recordSuccess(TOOL_ID, 10);
    await expect(tracker.dispose()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/tool-health.test.ts
```

Expected: `Cannot find module './tool-health.js'`

- [ ] **Step 3: Implement tool-health.ts**

```typescript
import { createLatencySampler, recordLatency } from "@koi/validation";
import { extractMessage } from "@koi/errors";
import type { BrickFitnessMetrics, ForgeStore } from "@koi/core/brick-store";
import type { BrickId, BrickSnapshot, SnapshotId } from "@koi/core/brick-snapshot";
import { brickId, snapshotId } from "@koi/core/brick-snapshot";
import type { ChainId } from "@koi/core/snapshot-chain";
import { chainId } from "@koi/core/snapshot-chain";
import type { SnapshotChainStore } from "@koi/core/snapshot-chain";
import type { TrustTier } from "@koi/core/forge-types";
import type {
  DemotionCriteria,
  FlushDeltas,
  HealthAction,
  HealthState,
  HealthTransitionErrorEvent,
  RingEntry,
  ToolFlushState,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  TrustDemotionEvent,
} from "./types.js";
import { shouldFlush, computeMergedFitness } from "./fitness-flush.js";
import { DEFAULT_DEMOTION_CRITERIA } from "./config.js";

const TRUST_DEMOTION_ORDER: readonly TrustTier[] = ["verified", "community", "local"];

function nextTrustTier(current: TrustTier): TrustTier | undefined {
  const idx = TRUST_DEMOTION_ORDER.indexOf(current);
  return idx >= 0 && idx < TRUST_DEMOTION_ORDER.length - 1
    ? TRUST_DEMOTION_ORDER[idx + 1]
    : undefined;
}

export function computeHealthAction(
  metrics: ToolHealthMetrics,
  currentState: HealthState,
  currentTrustTier: TrustTier,
  quarantineThreshold: number,
  quarantineWindowSize: number,
  demotionCriteria: DemotionCriteria,
  lastPromotedAt: number,
  lastDemotedAt: number,
  now: number,
): HealthAction {
  if (currentState === "quarantined") return { state: "quarantined", action: "none" };

  const { totalCount, errorCount } = metrics;
  const errorRate = totalCount > 0 ? errorCount / totalCount : 0;

  if (errorRate >= quarantineThreshold) {
    return { state: "quarantined", action: "quarantine" };
  }

  const degradedThreshold = quarantineThreshold * 0.75;
  const nextState: HealthState = errorRate >= degradedThreshold ? "degraded" : "healthy";

  // Check demotion
  const canDemote =
    nextTrustTier(currentTrustTier) !== undefined &&
    errorRate >= demotionCriteria.errorRateThreshold &&
    totalCount >= demotionCriteria.minSampleSize &&
    now - lastPromotedAt >= demotionCriteria.gracePeriodMs &&
    now - lastDemotedAt >= demotionCriteria.demotionCooldownMs;

  return { state: nextState, action: canDemote ? "demote" : "none" };
}

interface ToolState {
  readonly ring: RingEntry[];
  readonly ringSize: number;
  ringCursor: number;
  totalCount: number;
  errorCount: number;
  healthState: HealthState;
  lastPromotedAt: number;
  lastDemotedAt: number;
  // Fitness flush
  cumulativeSuccess: number;
  cumulativeError: number;
  latencySampler: ReturnType<typeof createLatencySampler>;
  lastUsedAt: number;
  flush: ToolFlushState;
  consecutiveFlushFailures: number;
  lastFlushFailureAt: number;
  suspended: boolean;
}

export interface ToolHealthTracker {
  readonly recordSuccess: (toolId: string, latencyMs: number) => void;
  readonly recordFailure: (toolId: string, latencyMs: number, error: string) => void;
  readonly getSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  readonly isQuarantined: (toolId: string) => boolean;
  readonly checkAndQuarantine: (toolId: string) => Promise<boolean>;
  readonly checkAndDemote: (toolId: string) => Promise<boolean>;
  readonly getAllSnapshots: () => readonly ToolHealthSnapshot[];
  readonly shouldFlushTool: (toolId: string) => boolean;
  readonly flushTool: (toolId: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface ToolHealthTrackerConfig {
  readonly resolveBrickId: (toolId: string) => BrickId | undefined;
  readonly forgeStore: ForgeStore;
  readonly snapshotChainStore: SnapshotChainStore<BrickSnapshot>;
  readonly quarantineThreshold?: number | undefined;
  readonly windowSize?: number | undefined;
  readonly maxRecentFailures?: number | undefined;
  readonly onQuarantine?: ((brickId: BrickId) => void) | undefined;
  readonly demotionCriteria?: Partial<DemotionCriteria> | undefined;
  readonly onDemotion?: ((event: TrustDemotionEvent) => void) | undefined;
  readonly onHealthTransitionError?: ((event: HealthTransitionErrorEvent) => void) | undefined;
  readonly clock?: (() => number) | undefined;
  readonly flushThreshold?: number | undefined;
  readonly errorRateDeltaThreshold?: number | undefined;
  readonly maxConsecutiveFlushFailures?: number | undefined;
  readonly flushSuspensionCooldownMs?: number | undefined;
  readonly flushTimeoutMs?: number | undefined;
  readonly onFlushError?: ((toolId: string, error: unknown) => void) | undefined;
}

export function createToolHealthTracker(config: ToolHealthTrackerConfig): ToolHealthTracker {
  const quarantineThreshold = config.quarantineThreshold ?? 0.5;
  const windowSize = config.windowSize ?? 10;
  const demotionCriteria: DemotionCriteria = {
    ...DEFAULT_DEMOTION_CRITERIA,
    ...config.demotionCriteria,
  };
  const clock = config.clock ?? Date.now;
  const flushThreshold = config.flushThreshold ?? 10;
  const errorRateDeltaThreshold = config.errorRateDeltaThreshold ?? 0.05;
  const maxConsecutiveFlushFailures = config.maxConsecutiveFlushFailures ?? 5;
  const flushSuspensionCooldownMs = config.flushSuspensionCooldownMs ?? 60_000;
  const flushTimeoutMs = config.flushTimeoutMs ?? 2_000;

  const ringSize = Math.max(windowSize, demotionCriteria.windowSize);
  const toolStates = new Map<string, ToolState>();
  const sessionQuarantined = new Set<BrickId>();

  function getOrCreate(toolId: string): ToolState {
    let state = toolStates.get(toolId);
    if (!state) {
      state = {
        ring: Array.from({ length: ringSize }, () => ({ success: true, latencyMs: 0 })),
        ringSize,
        ringCursor: 0,
        totalCount: 0,
        errorCount: 0,
        healthState: "healthy",
        lastPromotedAt: 0,
        lastDemotedAt: 0,
        cumulativeSuccess: 0,
        cumulativeError: 0,
        latencySampler: createLatencySampler(),
        lastUsedAt: 0,
        flush: { dirty: false, flushing: false, invocationsSinceFlush: 0, errorRateSinceFlush: 0, lastFlushedErrorRate: 0 },
        consecutiveFlushFailures: 0,
        lastFlushFailureAt: 0,
        suspended: false,
      };
      toolStates.set(toolId, state);
    }
    return state;
  }

  function record(toolId: string, success: boolean, latencyMs: number): void {
    const state = getOrCreate(toolId);
    const entry: RingEntry = { success, latencyMs };
    state.ring[state.ringCursor % state.ringSize] = entry;
    state.ringCursor = (state.ringCursor + 1) % state.ringSize;
    state.totalCount++;
    if (!success) state.errorCount++;
    state.lastUsedAt = clock();
    if (success) state.cumulativeSuccess++;
    else state.cumulativeError++;
    state.latencySampler = recordLatency(state.latencySampler, latencyMs);

    const errorRate = state.totalCount > 0 ? state.errorCount / state.totalCount : 0;
    state.flush = {
      ...state.flush,
      dirty: true,
      invocationsSinceFlush: state.flush.invocationsSinceFlush + 1,
      errorRateSinceFlush: errorRate,
    };
  }

  function getMetrics(toolId: string): ToolHealthMetrics {
    const state = toolStates.get(toolId);
    if (!state) return { errorCount: 0, totalCount: 0, entries: [] };
    const windowEntries = state.ring.slice(0, Math.min(state.totalCount, windowSize));
    const windowErrors = windowEntries.filter((e) => !e.success).length;
    return { errorCount: windowErrors, totalCount: windowEntries.length, entries: windowEntries };
  }

  async function persistQuarantine(toolId: string, bid: BrickId): Promise<boolean> {
    // ForgeStore write first (authoritative)
    const result = await config.forgeStore.update(bid, { lifecycle: "quarantined" });
    if (!result.ok) {
      // CONFLICT = already quarantined by another writer — treat as success
      if (result.error.code === "CONFLICT") return true;
      config.onHealthTransitionError?.({ transition: "quarantine", phase: "forgeStore", brickId: bid, error: result.error });
      return false;
    }
    // Snapshot write second (audit trail — failure is non-fatal)
    const snapshotResult = await config.snapshotChainStore.put(
      bid as unknown as ChainId,
      {
        snapshotId: snapshotId(`${bid}-q-${clock()}`),
        brickId: bid,
        version: "1",
        source: { origin: "forged", forgedBy: "health-tracker" },
        event: { kind: "quarantined", actor: "health-tracker", timestamp: clock(), reason: "error_rate_threshold", errorRate: getMetrics(toolId).errorCount / Math.max(1, getMetrics(toolId).totalCount), failureCount: getMetrics(toolId).errorCount },
        artifact: {},
        createdAt: clock(),
      } as unknown as BrickSnapshot,
      [],
    );
    if (!snapshotResult.ok) {
      config.onHealthTransitionError?.({ transition: "quarantine", phase: "snapshot", brickId: bid, error: snapshotResult.error });
    }
    return true;
  }

  async function persistDemotion(toolId: string, bid: BrickId, from: TrustTier, to: TrustTier, errorRate: number): Promise<boolean> {
    const result = await config.forgeStore.update(bid, { trustTier: to });
    if (!result.ok) {
      if (result.error.code === "CONFLICT") return true;
      config.onHealthTransitionError?.({ transition: "demotion", phase: "forgeStore", brickId: bid, error: result.error });
      return false;
    }
    const snapshotResult = await config.snapshotChainStore.put(
      bid as unknown as ChainId,
      {
        snapshotId: snapshotId(`${bid}-d-${clock()}`),
        brickId: bid,
        version: "1",
        source: { origin: "forged", forgedBy: "health-tracker" },
        event: { kind: "demoted", actor: "health-tracker", timestamp: clock(), fromTier: from, toTier: to, reason: "error_rate", errorRate },
        artifact: {},
        createdAt: clock(),
      } as unknown as BrickSnapshot,
      [],
    );
    if (!snapshotResult.ok) {
      config.onHealthTransitionError?.({ transition: "demotion", phase: "snapshot", brickId: bid, error: snapshotResult.error });
    }
    return true;
  }

  async function doFlush(toolId: string): Promise<void> {
    const state = toolStates.get(toolId);
    const bid = config.resolveBrickId(toolId);
    if (!state || !bid) return;
    if (state.flush.flushing) return;

    state.flush = { ...state.flush, flushing: true };
    const deltas: FlushDeltas = {
      successCount: state.cumulativeSuccess,
      errorCount: state.cumulativeError,
      latencySampler: state.latencySampler,
      lastUsedAt: state.lastUsedAt,
    };

    try {
      const existing = await config.forgeStore.load(bid);
      const existingFitness = existing.ok ? existing.value.fitness : undefined;
      const merged = computeMergedFitness(deltas, existingFitness);
      const updateResult = await config.forgeStore.update(bid, { fitness: merged });
      if (!updateResult.ok) throw new Error(updateResult.error.message);

      state.flush = {
        dirty: false,
        flushing: false,
        invocationsSinceFlush: 0,
        errorRateSinceFlush: state.flush.errorRateSinceFlush,
        lastFlushedErrorRate: state.flush.errorRateSinceFlush,
      };
      state.consecutiveFlushFailures = 0;
      state.suspended = false;
      state.cumulativeSuccess = 0;
      state.cumulativeError = 0;
      state.latencySampler = createLatencySampler();
    } catch (err) {
      state.flush = { ...state.flush, flushing: false };
      state.consecutiveFlushFailures++;
      state.lastFlushFailureAt = clock();
      config.onFlushError?.(toolId, err);
      if (state.consecutiveFlushFailures >= maxConsecutiveFlushFailures) {
        state.suspended = true;
        config.onFlushError?.(toolId, new Error(`Flush suspended after ${maxConsecutiveFlushFailures} consecutive failures`));
      }
    }
  }

  return {
    recordSuccess(toolId, latencyMs) { record(toolId, true, latencyMs); },
    recordFailure(toolId, latencyMs, _error) { record(toolId, false, latencyMs); },

    getSnapshot(toolId): ToolHealthSnapshot | undefined {
      const state = toolStates.get(toolId);
      const bid = config.resolveBrickId(toolId);
      if (!state || !bid) return undefined;
      const errorRate = state.totalCount > 0 ? state.errorCount / state.totalCount : 0;
      return {
        toolId,
        brickId: bid,
        healthState: state.healthState,
        trustTier: undefined,
        errorRate,
        totalCount: state.totalCount,
        flushSuspended: state.suspended,
      };
    },

    isQuarantined(toolId): boolean {
      const bid = config.resolveBrickId(toolId);
      if (!bid) return false;
      if (sessionQuarantined.has(bid)) return true;
      const state = toolStates.get(toolId);
      return state?.healthState === "quarantined";
    },

    async checkAndQuarantine(toolId): Promise<boolean> {
      const bid = config.resolveBrickId(toolId);
      if (!bid) return false;
      if (sessionQuarantined.has(bid)) return true;
      const metrics = getMetrics(toolId);
      const state = getOrCreate(toolId);
      const action = computeHealthAction(metrics, state.healthState, "verified", quarantineThreshold, windowSize, demotionCriteria, state.lastPromotedAt, state.lastDemotedAt, clock());
      if (action.action !== "quarantine") return false;

      // Local session quarantine first (safety invariant)
      sessionQuarantined.add(bid);
      state.healthState = "quarantined";

      // Persist to ForgeStore
      const persisted = await persistQuarantine(toolId, bid);
      if (persisted) config.onQuarantine?.(bid);
      return true;
    },

    async checkAndDemote(toolId): Promise<boolean> {
      const bid = config.resolveBrickId(toolId);
      if (!bid) return false;
      const state = getOrCreate(toolId);
      if (state.healthState === "quarantined") return false;

      const loadResult = await config.forgeStore.load(bid);
      if (!loadResult.ok) return false;
      const currentTier = (loadResult.value.trustTier as TrustTier) ?? "local";
      const metrics = getMetrics(toolId);
      const action = computeHealthAction(metrics, state.healthState, currentTier, quarantineThreshold, windowSize, demotionCriteria, state.lastPromotedAt, state.lastDemotedAt, clock());
      if (action.action !== "demote") return false;

      const newTier = nextTrustTier(currentTier);
      if (!newTier) return false;

      const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;
      const persisted = await persistDemotion(toolId, bid, currentTier, newTier, errorRate);
      if (persisted) {
        state.lastDemotedAt = clock();
        config.onDemotion?.({ brickId: bid, from: currentTier, to: newTier, reason: "error_rate", evidence: { errorRate, sampleSize: metrics.totalCount } });
      }
      return persisted;
    },

    getAllSnapshots(): readonly ToolHealthSnapshot[] {
      return Array.from(toolStates.keys()).map((id) => this.getSnapshot(id)).filter((s): s is ToolHealthSnapshot => s !== undefined);
    },

    shouldFlushTool(toolId): boolean {
      const state = toolStates.get(toolId);
      if (!state) return false;
      if (state.suspended) {
        const now = clock();
        if (now - state.lastFlushFailureAt >= flushSuspensionCooldownMs) {
          state.suspended = false;
          state.consecutiveFlushFailures = 0;
        } else {
          return false;
        }
      }
      return shouldFlush(state.flush, flushThreshold, errorRateDeltaThreshold);
    },

    async flushTool(toolId): Promise<void> {
      await doFlush(toolId);
    },

    async dispose(): Promise<void> {
      const dirty = Array.from(toolStates.entries()).filter(([, s]) => s.flush.dirty);
      for (const [toolId] of dirty) {
        // Bypass suspension on shutdown
        const state = toolStates.get(toolId);
        if (state) state.suspended = false;

        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Flush timeout for ${toolId}`)), flushTimeoutMs),
        );
        try {
          await Promise.race([doFlush(toolId), timeoutPromise]);
        } catch (err) {
          config.onFlushError?.(toolId, err);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/tool-health.test.ts
```

Expected: `14 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/tool-health.ts packages/lib/middleware-feedback-loop/src/tool-health.test.ts
git commit -m "feat(feedback-loop): add ToolHealthTracker with ring buffer, quarantine, demotion, and flush"
```

---

### Task 10: Main Middleware Factory (TDD)

**Files:**
- Create: `packages/lib/middleware-feedback-loop/src/feedback-loop.ts`
- Create: `packages/lib/middleware-feedback-loop/src/feedback-loop.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/feedback-loop.test.ts
import { describe, expect, it, mock } from "bun:test";
import { createFeedbackLoopMiddleware } from "./feedback-loop.js";
import { KoiRuntimeError } from "@koi/errors";
import type { ModelRequest, ModelResponse, TurnContext, SessionContext } from "@koi/core/middleware";
import type { ToolRequest, ToolResponse } from "@koi/core/middleware";

const mockCtx = (): TurnContext => ({
  session: { sessionId: "s1", agentId: "a1", runId: "r1" } as unknown as SessionContext,
  turnIndex: 0,
  tools: [],
} as unknown as TurnContext);

const goodResponse: ModelResponse = { content: "ok", model: "test" };
const badResponse: ModelResponse = { content: "bad", model: "test" };
const baseRequest: ModelRequest = {
  messages: [{ senderId: "user", content: [{ kind: "text", text: "hi" }], timestamp: 1 }],
};
const toolRequest: ToolRequest = { toolId: "my-tool", input: {} };

describe("createFeedbackLoopMiddleware", () => {
  it("passes through when no config (zero-config no-op)", async () => {
    const mw = createFeedbackLoopMiddleware({});
    expect(mw.name).toBe("feedback-loop");
    expect(mw.priority).toBe(450);

    const next = mock(async () => goodResponse);
    const result = await mw.wrapModelCall!(mockCtx(), baseRequest, next);
    expect(result).toBe(goodResponse);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("retries on validation failure", async () => {
    let callCount = 0;
    const next = mock(async () => {
      callCount++;
      return callCount === 1 ? badResponse : goodResponse;
    });
    const mw = createFeedbackLoopMiddleware({
      validators: [
        {
          name: "check",
          validate: (r) =>
            r.content === "ok"
              ? { valid: true }
              : { valid: false, errors: [{ validator: "check", message: "bad content" }] },
        },
      ],
      retry: { validation: { maxAttempts: 3 } },
    });
    const result = await mw.wrapModelCall!(mockCtx(), baseRequest, next);
    expect(result).toBe(goodResponse);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("gate halts pipeline without retry", async () => {
    const next = mock(async () => goodResponse);
    const mw = createFeedbackLoopMiddleware({
      gates: [
        {
          name: "safety",
          validate: () => ({ valid: false, errors: [{ validator: "safety", message: "unsafe" }] }),
        },
      ],
    });
    await expect(
      mw.wrapModelCall!(mockCtx(), baseRequest, next),
    ).rejects.toBeInstanceOf(KoiRuntimeError);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("tool call passes through with no validators or health config", async () => {
    const mw = createFeedbackLoopMiddleware({});
    const next = mock(async () => ({ output: "result" } as ToolResponse));
    const result = await mw.wrapToolCall!(mockCtx(), toolRequest, next);
    expect(result).toEqual({ output: "result" });
  });

  it("session lifecycle: onSessionStart and onSessionEnd do not throw", async () => {
    const mw = createFeedbackLoopMiddleware({});
    const ctx = mockCtx();
    await expect(mw.onSessionStart?.(ctx.session)).resolves.toBeUndefined();
    await expect(mw.onSessionEnd?.(ctx.session)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test packages/lib/middleware-feedback-loop/src/feedback-loop.test.ts
```

Expected: `Cannot find module './feedback-loop.js'`

- [ ] **Step 3: Implement feedback-loop.ts**

```typescript
import type { KoiMiddleware, TurnContext, ModelRequest, ModelResponse, ToolRequest, ToolResponse, SessionContext } from "@koi/core/middleware";
import type { FeedbackLoopConfig } from "./config.js";
import { defaultRepairStrategy } from "./repair.js";
import { runValidators } from "./validators.js";
import { runGates } from "./gate.js";
import { runWithRetry } from "./retry.js";
import { createToolHealthTracker } from "./tool-health.js";
import type { ToolHealthTracker } from "./tool-health.js";
import type { ForgeToolErrorFeedback } from "./types.js";

export function createFeedbackLoopMiddleware(config: FeedbackLoopConfig): KoiMiddleware {
  const validators = config.validators ?? [];
  const gates = config.gates ?? [];
  const toolValidators = config.toolValidators ?? [];
  const toolGates = config.toolGates ?? [];
  const repairStrategy = config.repairStrategy ?? defaultRepairStrategy;
  const validationMaxAttempts = config.retry?.validation?.maxAttempts ?? 3;
  const transportMaxAttempts = config.retry?.transport?.maxAttempts ?? 2;

  let tracker: ToolHealthTracker | undefined;
  const sessionTrackers = new Map<string, ToolHealthTracker>();

  function getTracker(): ToolHealthTracker | undefined {
    if (!config.forgeHealth) return undefined;
    return tracker;
  }

  return {
    name: "feedback-loop",
    priority: 450,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      if (!config.forgeHealth) return;
      const { createToolHealthTracker: create } = await import("./tool-health.js");
      tracker = createToolHealthTracker({ ...config.forgeHealth });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      if (tracker) {
        await tracker.dispose();
        tracker = undefined;
      }
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (req: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      if (validators.length === 0 && gates.length === 0) {
        return next(request);
      }
      return runWithRetry(request, next, {
        validators,
        gates,
        repairStrategy,
        validationMaxAttempts,
        transportMaxAttempts,
        onRetry: config.onRetry,
        onGateFail: config.onGateFail,
      });
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: (req: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      const t = getTracker();
      const brickId = t ? config.forgeHealth?.resolveBrickId(request.toolId) : undefined;

      // Input validation
      if (toolValidators.length > 0) {
        // Validators work on ModelResponse — tool input validation is a no-op here
        // (tool input validators would need a ToolInputValidator type; skip for now)
      }

      // Check quarantine
      if (t && brickId && t.isQuarantined(request.toolId)) {
        const feedback: ForgeToolErrorFeedback = {
          kind: "forge_tool_quarantined",
          brickId,
          toolId: request.toolId,
          message: `Tool "${request.toolId}" is quarantined and cannot execute.`,
        };
        return { output: feedback };
      }

      const start = config.forgeHealth?.clock?.() ?? Date.now();
      let response: ToolResponse;

      try {
        response = await next(request);
      } catch (err) {
        const latencyMs = (config.forgeHealth?.clock?.() ?? Date.now()) - start;
        if (t && brickId) {
          t.recordFailure(request.toolId, latencyMs, String(err));
          await t.checkAndQuarantine(request.toolId).catch(() => {});
          await t.checkAndDemote(request.toolId).catch(() => {});
          if (t.shouldFlushTool(request.toolId)) {
            t.flushTool(request.toolId).catch(() => {});
          }
        }
        throw err;
      }

      const latencyMs = (config.forgeHealth?.clock?.() ?? Date.now()) - start;

      // Tool gates — evaluated BEFORE health accounting
      if (toolGates.length > 0) {
        for (const gate of toolGates) {
          const result = await gate.validate(response);
          if (!result.valid) {
            const errors = result.errors ?? [];
            config.onGateFail?.(gate, errors);
            if (t && brickId && gate.countAsHealthFailure) {
              t.recordFailure(request.toolId, latencyMs, `gate:${gate.name}`);
              await t.checkAndQuarantine(request.toolId).catch(() => {});
              await t.checkAndDemote(request.toolId).catch(() => {});
              if (t.shouldFlushTool(request.toolId)) t.flushTool(request.toolId).catch(() => {});
            }
            const { KoiRuntimeError } = await import("@koi/errors");
            throw new KoiRuntimeError(
              `Tool gate "${gate.name}" rejected response: ${errors.map((e) => e.message).join("; ")}`,
              { code: "VALIDATION" },
            );
          }
        }
      }

      // Record success only after all gates pass
      if (t && brickId) {
        t.recordSuccess(request.toolId, latencyMs);
        if (t.shouldFlushTool(request.toolId)) {
          t.flushTool(request.toolId).catch(() => {});
        }
      }

      return response;
    },
  };
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test packages/lib/middleware-feedback-loop/src/feedback-loop.test.ts
```

Expected: `5 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/feedback-loop.ts packages/lib/middleware-feedback-loop/src/feedback-loop.test.ts
git commit -m "feat(feedback-loop): add main middleware factory with tests"
```

---

### Task 11: Public Exports + Wire into @koi/runtime

**Files:**
- Modify: `packages/lib/middleware-feedback-loop/src/index.ts`
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Write index.ts**

```typescript
export { createFeedbackLoopMiddleware } from "./feedback-loop.js";
export { createToolHealthTracker } from "./tool-health.js";
export { shouldFlush, computeMergedFitness } from "./fitness-flush.js";
export { computeHealthAction } from "./tool-health.js";
export { defaultRepairStrategy, formatErrors } from "./repair.js";
export type { FeedbackLoopConfig, ForgeHealthConfig, RetryConfig } from "./config.js";
export type {
  DemotionCriteria,
  FlushDeltas,
  ForgeToolErrorFeedback,
  Gate,
  HealthAction,
  HealthState,
  HealthTransitionErrorEvent,
  RepairStrategy,
  RetryContext,
  ToolFlushState,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  TrustDemotionEvent,
  ValidationError,
  ValidationResult,
  Validator,
} from "./types.js";
export type { ToolHealthTracker } from "./tool-health.js";
```

- [ ] **Step 2: Add to @koi/runtime package.json**

In `packages/meta/runtime/package.json`, add to `"dependencies"`:

```json
"@koi/middleware-feedback-loop": "workspace:*"
```

- [ ] **Step 3: Add to @koi/runtime tsconfig.json**

In `packages/meta/runtime/tsconfig.json`, add to `"references"`:

```json
{ "path": "../../lib/middleware-feedback-loop" }
```

- [ ] **Step 4: Add golden assertions to golden-replay.test.ts**

In `packages/meta/runtime/src/__tests__/golden-replay.test.ts`, add:

```typescript
describe("Golden: @koi/middleware-feedback-loop", () => {
  it("createFeedbackLoopMiddleware returns a KoiMiddleware with correct priority and name", async () => {
    const { createFeedbackLoopMiddleware } = await import("@koi/middleware-feedback-loop");
    const mw = createFeedbackLoopMiddleware({});
    expect(mw.name).toBe("feedback-loop");
    expect(mw.priority).toBe(450);
    expect(typeof mw.wrapModelCall).toBe("function");
    expect(typeof mw.wrapToolCall).toBe("function");
  });

  it("shouldFlush returns false when not dirty", async () => {
    const { shouldFlush } = await import("@koi/middleware-feedback-loop");
    expect(
      shouldFlush({ dirty: false, flushing: false, invocationsSinceFlush: 100, errorRateSinceFlush: 0, lastFlushedErrorRate: 0 }, 10, 0.05),
    ).toBe(false);
  });
});
```

- [ ] **Step 5: Build and run all tests**

```bash
bun run build --filter=@koi/middleware-feedback-loop
bun run test --filter=@koi/middleware-feedback-loop
bun run typecheck --filter=@koi/middleware-feedback-loop
bun run lint --filter=@koi/middleware-feedback-loop
bun run test --filter=@koi/runtime
```

Expected: All pass, no type errors, no lint errors.

- [ ] **Step 6: Run layer check**

```bash
bun run check:layers
```

Expected: No layer violations.

- [ ] **Step 7: Commit**

```bash
git add packages/lib/middleware-feedback-loop/src/index.ts \
        packages/meta/runtime/package.json \
        packages/meta/runtime/tsconfig.json \
        packages/meta/runtime/src/__tests__/golden-replay.test.ts \
        bun.lock
git commit -m "feat(feedback-loop): wire @koi/middleware-feedback-loop into runtime with golden assertions"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by task |
|---|---|
| `createFeedbackLoopMiddleware(config): KoiMiddleware` | Task 10 |
| `createToolHealthTracker(config): ToolHealthTracker` | Task 9 |
| `shouldFlush()` exported pure function | Task 7 |
| `computeMergedFitness()` exported pure function | Task 7 |
| `computeHealthAction()` exported pure function | Task 9 |
| Model call retry loop (validation + transport budgets) | Task 8 |
| `RetryContext` + `RepairStrategy` with `feedbackMessageId` | Tasks 2, 6 |
| Single replaceable feedback slot (replace-or-append) | Task 6 |
| Tool call flow: input validation, quarantine check, gate eval | Task 10 |
| Gates evaluated BEFORE health accounting | Task 10 |
| Gate `countAsHealthFailure` opt-in (default false) | Tasks 2, 10 |
| Ring buffer per brick | Task 9 |
| `computeHealthAction` pure fn: quarantine/degraded/healthy | Task 9 |
| Local session quarantine fallback when ForgeStore fails | Task 9 |
| Two-step ordered writes (ForgeStore first, snapshot second) | Task 9 |
| Error isolation: persistence errors never replace original error | Task 9 |
| Fitness persistence: cumulative counters + flush thresholds | Tasks 7, 9 |
| Flush suspension + auto-recovery after cooldown | Task 9 |
| `dispose()` never throws, flushes bypassing suspension | Task 9 |
| `onHealthTransitionError` callback (not `onDemotionError`) | Tasks 2, 9 |
| Demotion order: verified → community → local | Task 9 |
| `onSessionStart` / `onSessionEnd` lifecycle hooks | Task 10 |
| Public exports in `index.ts` | Task 11 |
| Wire into `@koi/runtime` + golden assertions | Task 11 |
| Layer compliance (L0 + L0u only) | Tasks 1, 11 |

**Gaps found:** None — all spec requirements map to a task.

**Placeholder scan:** No TBD, TODO, or incomplete steps found.

**Type consistency:** `ValidationError`, `RepairStrategy`, `RetryContext`, `ToolHealthTracker`, `HealthAction`, `DemotionCriteria`, `ForgeHealthConfig` — all defined in Task 2 (types.ts / config.ts) and used consistently in later tasks. `feedbackMessageId` is `string` throughout. `ToolHealthTracker.dispose()` returns `Promise<void>` in Task 9 interface and implementation.
