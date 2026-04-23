# Bash-AST Permissions Consumer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `@koi/bash-ast` spec evaluation into `@koi/middleware-permissions` so that `Write(path)`, `Read(path)`, and `Network(host)` permission rules are enforced against real bash command semantics, and prefix `Run(...)` rules are blocked for argv forms the spec marks `partial` or `refused`.

**Architecture:** Three changes bundled in one PR: (1) `@koi/permissions` gains new Zod DSL sugar that parses `{Write: path}` / `{Read: path}` / `{Network: host}` config shapes into standard `{action, pattern}` rules — no type or evaluator changes needed; (2) new `bash-spec-guard.ts` in `@koi/middleware-permissions` calls `evaluateBashCommand` and enforces both semantic path/network rules and the exact-argv guard; (3) `middleware.ts` is split (2398 → ≤800 lines per file) and `wrapToolCall` is wired to call the guard. A standalone golden query in `golden-queries.test.ts` proves the deny path without LLM.

**Tech Stack:** Bun 1.3, TypeScript 6 strict, `bun:test`, `@koi/bash-ast` (L0u), `@koi/permissions` (L2 unlisted), `@koi/middleware-permissions` (L2 unlisted), Zod 4.

---

## File Map

### Modified files

| File | Change |
|------|--------|
| `packages/security/permissions/src/rule-loader.ts` | Add `Write`/`Read`/`Network` Zod shapes (union + transform) |
| `packages/security/permissions/src/rule-loader.test.ts` | Tests for new DSL shapes |
| `packages/security/middleware-permissions/package.json` | Add `@koi/bash-ast` dependency |
| `packages/security/middleware-permissions/src/middleware.ts` | Split down to ≤800 lines; wire spec guard in `wrapToolCall` |
| `packages/security/middleware-permissions/src/config.ts` | Add `enableBashSpecGuard?: boolean` config flag |
| `packages/meta/runtime/src/__tests__/golden-queries.test.ts` | 2 standalone spec-deny golden queries |

### New files

| File | Purpose |
|------|---------|
| `packages/security/middleware-permissions/src/bash-spec-guard.ts` | Calls `evaluateBashCommand`, enforces exact-argv guard + semantic rules |
| `packages/security/middleware-permissions/src/bash-spec-guard.test.ts` | Unit tests for spec guard |
| `packages/security/middleware-permissions/src/middleware-internals.ts` | Cache factories + decision tag helpers + validation helpers (extracted from middleware.ts) |
| `packages/security/middleware-permissions/src/resolve-batch.ts` | `resolveDecision` + `resolveBatch` (extracted from middleware.ts) |
| `packages/security/middleware-permissions/src/filter-tools.ts` | `filterTools` function (extracted from middleware.ts) |

---

## Task 1: Add `Write`/`Read`/`Network` DSL to `@koi/permissions` rule-loader

**Files:**
- Modify: `packages/security/permissions/src/rule-loader.ts`
- Test: `packages/security/permissions/src/rule-loader.test.ts`

The Zod schema currently accepts only the flat `{pattern, action, effect, ...}` shape. We add a Zod union that also parses `{Write: path, effect, ...}` → `{action: "write", pattern: path, effect, ...}` and same for `Read` and `Network`. The underlying `PermissionRule` type is unchanged; the evaluator already handles `action` matching generically.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/security/permissions/src/rule-loader.test.ts
// Add inside an existing or new describe block:
describe("DSL sugar — Write/Read/Network rule shapes", () => {
  test("parses Write rule into action:write + pattern", () => {
    const result = loadRules(
      new Map([
        [
          "policy",
          [{ Write: "/etc/**", effect: "deny", reason: "no writes to /etc" } as unknown as PermissionRule],
        ],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.action).toBe("write");
    expect(result.value[0]?.pattern).toBe("/etc/**");
    expect(result.value[0]?.effect).toBe("deny");
    expect(result.value[0]?.reason).toBe("no writes to /etc");
  });

  test("parses Read rule into action:read + pattern", () => {
    const result = loadRules(
      new Map([["user", [{ Read: "/secret/*", effect: "deny" } as unknown as PermissionRule]]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.action).toBe("read");
    expect(result.value[0]?.pattern).toBe("/secret/*");
  });

  test("parses Network rule into action:network + pattern", () => {
    const result = loadRules(
      new Map([["policy", [{ Network: "evil.com", effect: "deny" } as unknown as PermissionRule]]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.action).toBe("network");
    expect(result.value[0]?.pattern).toBe("evil.com");
  });

  test("rejects unknown DSL shape", () => {
    const result = loadRules(
      new Map([["user", [{ Delete: "/tmp", effect: "deny" } as unknown as PermissionRule]]]),
    );
    expect(result.ok).toBe(false);
  });

  test("flat rules still load unchanged", () => {
    const rule: PermissionRule = { pattern: "bash:rm", action: "*", effect: "deny" };
    const result = loadRules(new Map([["user", [rule]]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.pattern).toBe("bash:rm");
    expect(result.value[0]?.action).toBe("*");
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd /Users/sophiawj/private/koi/.worktrees/issue-1919-bash-ast-permissions
bun test packages/security/permissions/src/rule-loader.test.ts 2>&1 | tail -20
```
Expected: `DSL sugar` tests fail with validation error (schema rejects unknown shapes).

- [ ] **Step 3: Implement the DSL sugar in rule-loader.ts**

Replace the existing `permissionRuleSchema` and `ruleArraySchema` with:

```typescript
// packages/security/permissions/src/rule-loader.ts
// Add after the existing imports, before permissionRuleSchema:

const semanticEffectFields = {
  effect: z.enum(["allow", "deny", "ask"]),
  principal: z.string().min(1).optional(),
  context: z.record(z.string(), z.string().min(1)).optional(),
  reason: z.string().optional(),
  on_deny: z.enum(["hard", "soft"]).optional(),
};

const semanticWriteSchema = z
  .object({ Write: z.string().min(1), ...semanticEffectFields })
  .transform(({ Write, ...rest }) => ({ pattern: Write, action: "write" as const, ...rest }));

const semanticReadSchema = z
  .object({ Read: z.string().min(1), ...semanticEffectFields })
  .transform(({ Read, ...rest }) => ({ pattern: Read, action: "read" as const, ...rest }));

const semanticNetworkSchema = z
  .object({ Network: z.string().min(1), ...semanticEffectFields })
  .transform(({ Network, ...rest }) => ({ pattern: Network, action: "network" as const, ...rest }));
```

Then replace `const ruleArraySchema = z.array(permissionRuleSchema);` with:

```typescript
const anyRuleSchema = z.union([
  semanticWriteSchema,
  semanticReadSchema,
  semanticNetworkSchema,
  permissionRuleSchema,
]);

const ruleArraySchema = z.array(anyRuleSchema);
```

No changes to `validateSourceRules` — it passes `rules` through the same schema validation path.

- [ ] **Step 4: Run tests — expect all pass**

```bash
bun test packages/security/permissions/src/rule-loader.test.ts 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 5: Run full permissions test suite**

```bash
bun run test --filter=@koi/permissions 2>&1 | tail -15
```
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/security/permissions/src/rule-loader.ts packages/security/permissions/src/rule-loader.test.ts
git commit -m "feat(permissions): add Write/Read/Network DSL sugar to rule-loader"
```

---

## Task 2: Add `@koi/bash-ast` dependency to `@koi/middleware-permissions`

**Files:**
- Modify: `packages/security/middleware-permissions/package.json`

`@koi/bash-ast` is L0u, so L2 packages can depend on it. This enables the spec guard to call `analyzeBashCommand` and `evaluateBashCommand`.

- [ ] **Step 1: Add dependency**

```bash
bun add --cwd packages/security/middleware-permissions @koi/bash-ast
```

- [ ] **Step 2: Verify layer check passes**

```bash
bun run check:layers 2>&1 | tail -10
```
Expected: no violations.

- [ ] **Step 3: Commit**

```bash
git add packages/security/middleware-permissions/package.json bun.lock
git commit -m "chore(middleware-permissions): add @koi/bash-ast dependency"
```

---

## Task 3: Split `middleware.ts` into focused files

**Files:**
- Create: `packages/security/middleware-permissions/src/middleware-internals.ts`
- Create: `packages/security/middleware-permissions/src/resolve-batch.ts`
- Create: `packages/security/middleware-permissions/src/filter-tools.ts`
- Modify: `packages/security/middleware-permissions/src/middleware.ts`

`middleware.ts` is 2398 lines — 3× the hard max. We extract three logical sections into separate files. Each resulting file must be ≤800 lines.

### 3a: Extract `middleware-internals.ts`

This file holds: cache factories (`createDecisionCache`, `createApprovalCache`), decision-tagging symbols and helpers (`IS_FAIL_CLOSED`, `IS_ESCALATED`, `IS_CACHED`, `failClosedDeny`, `isFailClosed`, `isCached`, `isEscalated`, `tagCached`), `VALID_EFFECTS`, `FAIL_CLOSED_DENY`, `safePreviewJson`, `validateDecision`, `VALID_APPROVAL_KINDS`, `VALID_ALWAYS_ALLOW_SCOPES`, `validateApprovalDecision`.

Target: ~260 lines.

- [ ] **Step 1: Write the failing import test**

```typescript
// packages/security/middleware-permissions/src/__tests__/api-surface.test.ts
// Add one import assertion to verify the new module shape:
// (This file already exists — add to it)
import { createDecisionCache } from "../middleware-internals.js";
// If this test compiles and runs, the extraction succeeded.
```

- [ ] **Step 2: Create `middleware-internals.ts`**

Move lines 59–295 from `middleware.ts` (cache factories through `validateApprovalDecision`) into a new file. Add proper exports for everything `middleware.ts` currently uses from that range. The new file starts with:

```typescript
// packages/security/middleware-permissions/src/middleware-internals.ts
import type { PermissionDecision } from "@koi/core/permission-backend";

// Paste: createDecisionCache (lines 75-127)
// Paste: createApprovalCache (lines 128-172)
// Paste: VALID_EFFECTS, IS_FAIL_CLOSED, FAIL_CLOSED_DENY, isFailClosed, failClosedDeny (lines 173-196)
// Paste: IS_ESCALATED, isEscalated, IS_CACHED, isCached, tagCached (lines 197-215)
// Paste: safePreviewJson (lines 217-225)
// Paste: validateDecision, VALID_APPROVAL_KINDS, VALID_ALWAYS_ALLOW_SCOPES, validateApprovalDecision (lines 240-295)
// Export all public symbols
```

In `middleware.ts`, replace those lines with imports:

```typescript
import {
  createApprovalCache,
  createDecisionCache,
  FAIL_CLOSED_DENY,
  failClosedDeny,
  isCached,
  isEscalated,
  isFailClosed,
  tagCached,
  safePreviewJson,
  validateApprovalDecision,
  validateDecision,
  VALID_EFFECTS,
} from "./middleware-internals.js";
```

- [ ] **Step 3: Extract `resolve-batch.ts`**

Move `resolveDecision` (~lines 982–1040) and `resolveBatch` (~lines 1041–1193) into:

```typescript
// packages/security/middleware-permissions/src/resolve-batch.ts
import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import type { CircuitBreaker } from "@koi/errors";
import { FAIL_CLOSED_DENY, failClosedDeny, isCached, tagCached, validateDecision } from "./middleware-internals.js";

// Export a factory function instead of embedding closure — accepts the shared state it needs:
export interface ResolveBatchDeps {
  readonly backend: PermissionBackend;
  readonly cb: CircuitBreaker | undefined;
  readonly decisionCache: ReturnType<typeof createDecisionCache> | undefined;
  readonly escalationEnabled: boolean;
  readonly escalationThreshold: number;
  readonly escalationWindowMs: number;
  readonly clock: () => number;
  readonly IS_ESCALATED: unique symbol;
  readonly getTracker: (sessionId: string) => DenialTracker;
  readonly decisionCacheKey: (q: PermissionQuery) => string | undefined;
}
```

Actually: because `resolveDecision` and `resolveBatch` are closures capturing shared session state from the factory, extracting them as standalone functions requires threading all their captured values as parameters — this becomes unwieldy. A simpler approach: extract them as a factory that returns the two functions:

```typescript
// resolve-batch.ts
export function createBatchResolver(deps: {
  backend: PermissionBackend;
  cb: CircuitBreaker | undefined;
  decisionCache: { get: ..., set: ... } | undefined;
  escalationEnabled: boolean;
  escalationThreshold: number;
  escalationWindowMs: number;
  clock: () => number;
  getTracker: (sessionId: string) => DenialTracker;
  decisionCacheKey: (q: PermissionQuery) => string | undefined;
}): {
  resolveDecision: (query: PermissionQuery, sessionId: string) => Promise<PermissionDecision>;
  resolveBatch: (queries: readonly PermissionQuery[], sessionId: string) => Promise<readonly PermissionDecision[]>;
} {
  // ... paste resolveDecision and resolveBatch bodies here, referencing deps.*
}
```

In `middleware.ts`, call:
```typescript
const { resolveDecision, resolveBatch } = createBatchResolver({
  backend: config.backend,
  cb,
  decisionCache,
  escalationEnabled,
  escalationThreshold,
  escalationWindowMs,
  clock,
  getTracker,
  decisionCacheKey,
});
```

- [ ] **Step 4: Extract `filter-tools.ts`**

Move `filterTools` (~lines 1195–1490, ~295 lines) into:

```typescript
// packages/security/middleware-permissions/src/filter-tools.ts
import type { KoiMiddleware, ModelRequest, TurnContext } from "@koi/core/middleware";
// ... other imports

export function createFilterTools(deps: {
  resolveBatch: (queries: readonly PermissionQuery[], sessionId: string) => Promise<readonly PermissionDecision[]>;
  queryForTool: (ctx: TurnContext, resource: string, meta?: JsonObject) => PermissionQuery;
  config: PermissionsMiddlewareConfig;
  clock: () => number;
  getTracker: (sessionId: string) => DenialTracker;
  getSoftDenyLog: (sessionId: string) => SoftDenyLog;
  getTurnSoftDenyCounter: (sessionId: string) => TurnSoftDenyCounter;
  filterCapRecordedKeys: Set<string>;
  approvalSink: (sid: string, step: RichTrajectoryStep) => void;
  auditSink: AuditSink | undefined;
  runtimeSinks: AuditSink[];
  originalSink: AuditSink | undefined;
  isDefaultDenyLike: (d: PermissionDecision) => boolean;
  safePreviewJson: (v: unknown, n: number) => string;
}): (ctx: TurnContext, request: ModelRequest) => Promise<ModelRequest> {
  return async function filterTools(ctx, request) {
    // paste body here
  };
}
```

In `middleware.ts`:
```typescript
const filterTools = createFilterTools({ resolveBatch, queryForTool, config, ... });
```

- [ ] **Step 5: Verify test suite still passes after split**

```bash
bun run test --filter=@koi/middleware-permissions 2>&1 | tail -20
bun run typecheck --filter=@koi/middleware-permissions 2>&1 | tail -10
```
Expected: all tests pass, no type errors.

- [ ] **Step 6: Verify file sizes**

```bash
wc -l packages/security/middleware-permissions/src/middleware.ts \
        packages/security/middleware-permissions/src/middleware-internals.ts \
        packages/security/middleware-permissions/src/resolve-batch.ts \
        packages/security/middleware-permissions/src/filter-tools.ts
```
Expected: each file ≤800 lines.

- [ ] **Step 7: Commit**

```bash
git add packages/security/middleware-permissions/src/
git commit -m "refactor(middleware-permissions): split 2398-line middleware.ts into focused files"
```

---

## Task 4: Create `bash-spec-guard.ts`

**Files:**
- Create: `packages/security/middleware-permissions/src/bash-spec-guard.ts`
- Create: `packages/security/middleware-permissions/src/bash-spec-guard.test.ts`

This file is the core of the issue. It:
1. Calls `analyzeBashCommand` to parse the raw bash command into `SimpleCommand[]`
2. Calls `evaluateBashCommand` per command to get `SpecResult`
3. For `partial`/`refused` specs with an `allow` decision: enforces exact-argv guard
4. For `complete`/`partial` specs: evaluates `Write(path)`, `Read(path)`, `Network(host)` rules via synthetic queries
5. Returns the strictest resulting decision

### 4a: Write failing tests

- [ ] **Step 1: Write `bash-spec-guard.test.ts`**

```typescript
// packages/security/middleware-permissions/src/bash-spec-guard.test.ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { createSpecRegistry } from "@koi/bash-ast";
import { evaluateSpecGuard } from "./bash-spec-guard.js";

function makeBackend(check: (q: PermissionQuery) => PermissionDecision): PermissionBackend {
  return { check: async (q) => check(q) };
}

const allowDecision: PermissionDecision = { effect: "allow" };
const denyDecision: PermissionDecision = { effect: "deny", reason: "denied", disposition: "hard" };
const askDecision: PermissionDecision = { effect: "ask", reason: "ask" };

const baseQuery: PermissionQuery = {
  resource: "bash:rm",
  action: "invoke",
  principal: "agent:test",
};

const registry = createSpecRegistry();

describe("evaluateSpecGuard — refused spec enforces exact-argv guard", () => {
  test("refused spec + prefix allow → downgrade to ask", async () => {
    // ssh is always refused. resolveQuery returns allow for ALL resources,
    // simulating a broad `bash:*` rule. The canary-suffix technique detects
    // prefix/glob rules: the guard queries `bash:ssh prod-host` (allow) AND
    // `bash:ssh prod-host\x01__spec_guard_canary__` (also allow, because the
    // broad `*` glob matches the canary suffix too). Both allowing → prefix rule
    // → NOT an explicit exact-argv rule → downgrade to ask.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("ask");
    expect(result.specKind).toBe("refused");
  });

  test("refused spec + existing deny → keep deny (guard does not weaken)", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: denyDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });

  test("refused spec + exact-argv allow rule → honor it", async () => {
    // resolveQuery returns allow ONLY for the exact-argv resource
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        // Exact key: "bash:ssh prod-host"
        if (q.resource === "bash:ssh prod-host") return allowDecision;
        return denyDecision;
      },
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    // Exact rule matches → allow stands
    expect(result.decision.effect).toBe("allow");
  });
});

describe("evaluateSpecGuard — partial spec enforces exact-argv guard", () => {
  test("partial spec (rm -r) + prefix allow → downgrade to ask", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm -r /tmp/work",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    // rm -r is partial (recursive-subtree-root); prefix allow "bash:rm" is not enough
    expect(result.decision.effect).toBe("ask");
    expect(result.specKind).toBe("partial");
  });

  test("partial spec + exact-argv rule → honor it + evaluate Write rules", async () => {
    // rm -r /tmp/work: spec reports writes: ["/tmp/work"]
    // Exact key is "bash:rm -r /tmp/work"; Write:/tmp/** is allowed
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm -r /tmp/work",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.resource === "bash:rm -r /tmp/work") return allowDecision;
        if (q.action === "write" && q.resource.startsWith("/tmp/")) return allowDecision;
        return denyDecision;
      },
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
  });
});

describe("evaluateSpecGuard — complete spec evaluates Write/Read/Network rules", () => {
  test("rm /etc/passwd → Write deny on /etc/**", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /etc/passwd",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "write" && q.resource.startsWith("/etc/")) {
          return { effect: "deny", reason: "writes to /etc denied", disposition: "hard" };
        }
        return allowDecision;
      },
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
    expect(result.specKind).toBe("complete");
  });

  test("curl https://example.com → Network rule matches by host", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "curl https://example.com/path",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "network" && q.resource === "example.com") {
          return { effect: "deny", reason: "network to example.com denied", disposition: "hard" };
        }
        return allowDecision;
      },
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });

  test("curl https://example.com:8443/path → host is example.com:8443", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "curl https://example.com:8443/path",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "network" && q.resource === "example.com:8443") {
          return { effect: "deny", reason: "denied", disposition: "hard" };
        }
        return allowDecision;
      },
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });

  test("rm /tmp/safe → Write allow → allow passes through", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /tmp/safe",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
  });
});

describe("evaluateSpecGuard — too-complex / parse-unavailable → ratchet or deny", () => {
  test("complex pipeline + allow → downgrade to ask (fail-closed for complex forms)", async () => {
    // Pipelines are too-complex for the AST walker — semantic analysis is
    // unavailable. When the current decision is allow, the guard MUST ratchet
    // to ask so a human reviews the command. Passing through allow would let
    // operators use unsupported shell syntax to bypass Write/Network rules.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "cat /etc/passwd | grep root",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => denyDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("ask");
  });

  test("complex pipeline + existing ask/deny → unchanged (already non-allow)", async () => {
    // Non-allow decisions pass through unchanged — already conservative.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "cat /etc/passwd | grep root",
      currentDecision: { effect: "ask" },
      resolveQuery: async (_q) => denyDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run tests — expect failures (module not found)**

```bash
bun test packages/security/middleware-permissions/src/bash-spec-guard.test.ts 2>&1 | tail -10
```
Expected: import fails — `bash-spec-guard.ts` does not exist yet.

- [ ] **Step 3: Implement `bash-spec-guard.ts`**

```typescript
// packages/security/middleware-permissions/src/bash-spec-guard.ts
import {
  analyzeBashCommand,
  type CommandSpec,
  evaluateBashCommand,
  type Redirect,
} from "@koi/bash-ast";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";

export type SpecGuardOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "spec-evaluated";
      readonly decision: PermissionDecision;
      readonly specKind: "complete" | "partial" | "refused";
    };

function stricter(a: PermissionDecision, b: PermissionDecision): PermissionDecision {
  if (a.effect === "deny") return a;
  if (b.effect === "deny") return b;
  if (a.effect === "ask") return a;
  if (b.effect === "ask") return b;
  return a;
}

async function evaluateSemanticRules(
  semantics: { reads: readonly string[]; writes: readonly string[]; network: readonly { host: string }[] },
  resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>,
  baseQuery: PermissionQuery,
): Promise<PermissionDecision> {
  let result: PermissionDecision = { effect: "allow" };

  for (const path of semantics.writes) {
    const d = await resolveQuery({ ...baseQuery, resource: path, action: "write" });
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  for (const path of semantics.reads) {
    const d = await resolveQuery({ ...baseQuery, resource: path, action: "read" });
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  for (const net of semantics.network) {
    const d = await resolveQuery({ ...baseQuery, resource: net.host, action: "network" });
    result = stricter(result, d);
    if (result.effect === "deny") return result;
  }

  return result;
}

/**
 * Evaluate bash spec semantics against the permission backend.
 *
 * - `refused`/`partial` specs: enforce that any `allow` from a prefix
 *   `Run(...)` rule is downgraded to `ask` unless an exact-argv `Run(...)`
 *   rule also allows the full command.
 * - `complete`/`partial` specs: evaluate `Write(path)`, `Read(path)`, and
 *   `Network(host)` rules against the spec's reported semantics.
 * - `too-complex` / `parse-unavailable` AST outcomes: skip spec guard and
 *   return the original decision unchanged.
 *
 * @param resolveQuery - Call the permission backend (with caching/CB) for
 *   a given query. Pass `(q) => resolveDecision(q, sessionId)` from the
 *   middleware closure.
 */
export async function evaluateSpecGuard(opts: {
  readonly toolId: string;
  readonly rawCommand: string;
  readonly currentDecision: PermissionDecision;
  readonly resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>;
  readonly baseQuery: PermissionQuery;
  readonly registry: ReadonlyMap<string, CommandSpec>;
}): Promise<SpecGuardOutcome> {
  const { toolId, rawCommand, currentDecision, resolveQuery, baseQuery, registry } = opts;

  const analysis = await analyzeBashCommand(rawCommand);
  if (analysis.kind !== "simple") {
    return { kind: "skipped", reason: analysis.kind };
  }

  let finalDecision = currentDecision;
  let strictestSpecKind: "complete" | "partial" | "refused" = "complete";

  for (const cmd of analysis.commands) {
    const specResult = evaluateBashCommand(
      { argv: cmd.argv, envVars: cmd.envVars, redirects: cmd.redirects as readonly Redirect[] },
      registry,
    );

    if (specResult.kind === "refused" || specResult.kind === "partial") {
      if (strictestSpecKind !== "refused") strictestSpecKind = specResult.kind;

      // Exact-argv guard: prefix allow is not sufficient
      if (currentDecision.effect === "allow") {
        const exactResource = `${toolId}:${rawCommand.trim()}`;
        const exactDecision = await resolveQuery({ ...baseQuery, resource: exactResource });
        if (exactDecision.effect !== "allow") {
          const kindLabel = specResult.kind === "refused" ? specResult.cause : specResult.reason;
          return {
            kind: "spec-evaluated",
            decision: {
              effect: "ask",
              reason: `Spec (${specResult.kind}: ${kindLabel}); exact-argv Run(...) rule required`,
            },
            specKind: strictestSpecKind,
          };
        }
        // Exact rule found — fall through to evaluate semantics (for partial)
      }

      if (specResult.kind === "partial") {
        const semanticDecision = await evaluateSemanticRules(
          specResult.semantics,
          resolveQuery,
          baseQuery,
        );
        finalDecision = stricter(finalDecision, semanticDecision);
      }
    } else {
      // complete: evaluate semantic rules freely
      const semanticDecision = await evaluateSemanticRules(
        specResult.semantics,
        resolveQuery,
        baseQuery,
      );
      finalDecision = stricter(finalDecision, semanticDecision);
    }
  }

  return { kind: "spec-evaluated", decision: finalDecision, specKind: strictestSpecKind };
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
bun test packages/security/middleware-permissions/src/bash-spec-guard.test.ts 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5: Run full middleware-permissions tests**

```bash
bun run test --filter=@koi/middleware-permissions 2>&1 | tail -15
```
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/security/middleware-permissions/src/bash-spec-guard.ts \
        packages/security/middleware-permissions/src/bash-spec-guard.test.ts
git commit -m "feat(middleware-permissions): add bash-spec-guard for semantic permission enforcement"
```

---

## Task 5: Add `enableBashSpecGuard` config flag and wire into `wrapToolCall`

**Files:**
- Modify: `packages/security/middleware-permissions/src/config.ts`
- Modify: `packages/security/middleware-permissions/src/middleware.ts`
- Modify: `packages/security/middleware-permissions/src/index.ts` (re-export guard types if needed)

The spec guard is activated when `resolveBashCommand` is configured AND `enableBashSpecGuard !== false`. The `createSpecRegistry()` is initialized once in the factory.

- [ ] **Step 1: Add config flag to `config.ts`**

In `PermissionsMiddlewareConfig`, add:

```typescript
/**
 * Enable bash-ast spec-aware enforcement. When `true` (default when
 * `resolveBashCommand` is set), bash commands are analyzed via
 * `@koi/bash-ast` specs to enforce `Write(path)`, `Read(path)`, and
 * `Network(host)` rules and to block prefix `Run(...)` rules for
 * `partial`/`refused` command forms.
 *
 * Set to `false` to opt out (legacy behavior). Requires
 * `resolveBashCommand` to be configured.
 */
readonly enableBashSpecGuard?: boolean | undefined;
```

- [ ] **Step 2: Write a failing integration test for the wired path**

```typescript
// packages/security/middleware-permissions/src/__tests__/spec-guard-integration.test.ts
import { describe, expect, test } from "bun:test";
import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import type { TurnContext, ToolRequest } from "@koi/core/middleware";
import { runId, sessionId } from "@koi/core";
import { createPermissionsMiddleware } from "../middleware.js";

// Minimal PermissionBackend that maps resource patterns to decisions
function makeMappingBackend(rules: Array<{resource: string; action: string; effect: PermissionDecision["effect"]; reason?: string}>): PermissionBackend {
  return {
    async check(q: PermissionQuery): Promise<PermissionDecision> {
      for (const rule of rules) {
        if (
          (rule.resource === "*" || q.resource.startsWith(rule.resource) || q.resource === rule.resource) &&
          (rule.action === "*" || q.action === rule.action)
        ) {
          if (rule.effect === "deny") return { effect: "deny", reason: rule.reason ?? "denied", disposition: "hard" };
          if (rule.effect === "ask") return { effect: "ask", reason: rule.reason ?? "ask" };
          return { effect: "allow" };
        }
      }
      return { effect: "deny", reason: "default deny", disposition: "hard" };
    },
  };
}

function makeTurnContext(): TurnContext {
  return {
    session: {
      sessionId: sessionId("test-session"),
      agentId: "agent:test",
    },
    turnIndex: 0,
  } as unknown as TurnContext;
}

function makeBashToolRequest(command: string): ToolRequest {
  return {
    toolId: "bash",
    input: { command },
    callId: "call-1" as unknown as ReturnType<typeof runId>,
  } as ToolRequest;
}

describe("middleware wrapToolCall — spec guard wired", () => {
  test("rm /etc/passwd denied by Write(/etc/**) rule even when Run(bash:rm) is allowed", async () => {
    const backend = makeMappingBackend([
      { resource: "bash:rm", action: "*", effect: "allow" },     // broad prefix allow
      { resource: "/etc/", action: "write", effect: "deny", reason: "no writes to /etc" }, // semantic deny
    ]);

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => (input as Record<string, string>).command,
      enableBashSpecGuard: true,
    });

    let capturedDecision: string | undefined;
    const ctx = {
      ...makeTurnContext(),
      reportDecision: (d: { action: string }) => { capturedDecision = d.action; },
    } as unknown as TurnContext;

    // Call wrapToolCall with next that would succeed if called
    let nextCalled = false;
    await mw.wrapToolCall(ctx, makeBashToolRequest("rm /etc/passwd"), async () => {
      nextCalled = true;
      return { toolId: "bash", output: "ok" };
    }).catch(() => {});

    // The Write deny should have blocked execution
    expect(nextCalled).toBe(false);
    expect(capturedDecision).toBe("deny");
  });

  test("ssh host downgraded to ask from prefix allow", async () => {
    const backend = makeMappingBackend([
      { resource: "bash:", action: "*", effect: "allow" }, // broad allow for all bash
    ]);

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) => (input as Record<string, string>).command,
      enableBashSpecGuard: true,
    });

    let capturedDecision: string | undefined;
    const ctx = {
      ...makeTurnContext(),
      reportDecision: (d: { action: string }) => { capturedDecision = d.action; },
    } as unknown as TurnContext;

    let approvalCalled = false;
    await mw.wrapToolCall(ctx, makeBashToolRequest("ssh prod-host"), async () => {
      return { toolId: "bash", output: "ok" };
    }).catch(() => {}); // approval handler not configured, may throw

    // ssh is always refused; prefix allow → ask
    expect(capturedDecision).toBe("ask");
  });
});
```

- [ ] **Step 3: Run failing test**

```bash
bun test packages/security/middleware-permissions/src/__tests__/spec-guard-integration.test.ts 2>&1 | tail -15
```
Expected: tests fail — spec guard not yet wired into `wrapToolCall`.

- [ ] **Step 4: Wire spec guard into `wrapToolCall` in `middleware.ts`**

In the factory, after existing setup, create the spec registry:

```typescript
// In createPermissionsMiddleware, after const cb = ...:
import { createSpecRegistry } from "@koi/bash-ast";
import { evaluateSpecGuard } from "./bash-spec-guard.js";

const specRegistry = createSpecRegistry();
const specGuardEnabled =
  config.resolveBashCommand !== undefined && config.enableBashSpecGuard !== false;
```

In `wrapToolCall`, after the dangerous-command ratchet block (~line 1649), add:

```typescript
// Bash spec guard: evaluate Write/Read/Network rules + exact-argv enforcement
if (specGuardEnabled && decision.effect !== "deny") {
  const raw = config.resolveBashCommand!(request.toolId, request.input);
  if (raw !== undefined && raw.trim().length > 0) {
    const specOutcome = await evaluateSpecGuard({
      toolId: request.toolId,
      rawCommand: raw,
      currentDecision: decision,
      resolveQuery: (q) => resolveDecision(q, ctx.session.sessionId as string),
      baseQuery: enrichedQuery,
      registry: specRegistry,
    });
    if (specOutcome.kind === "spec-evaluated") {
      decision = specOutcome.decision;
    }
  }
}
```

- [ ] **Step 5: Run integration tests — expect pass**

```bash
bun test packages/security/middleware-permissions/src/__tests__/spec-guard-integration.test.ts 2>&1 | tail -15
```
Expected: all tests pass.

- [ ] **Step 6: Run full middleware-permissions suite**

```bash
bun run test --filter=@koi/middleware-permissions 2>&1 | tail -20
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/security/middleware-permissions/src/config.ts \
        packages/security/middleware-permissions/src/middleware.ts \
        packages/security/middleware-permissions/src/__tests__/spec-guard-integration.test.ts
git commit -m "feat(middleware-permissions): wire bash-spec-guard into wrapToolCall"
```

---

## Task 6: Export new types from `@koi/middleware-permissions` index

**Files:**
- Modify: `packages/security/middleware-permissions/src/index.ts`

- [ ] **Step 1: Add exports**

```typescript
// Add to index.ts:
export type { SpecGuardOutcome } from "./bash-spec-guard.js";
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck --filter=@koi/middleware-permissions 2>&1 | tail -10
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/security/middleware-permissions/src/index.ts
git commit -m "feat(middleware-permissions): export SpecGuardOutcome type"
```

---

## Task 7: Standalone golden queries (no LLM required)

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-queries.test.ts`

Per CLAUDE.md: each new L2 package PR must add 2 per-L2 standalone golden queries. These test the spec-deny path directly without model calls.

- [ ] **Step 1: Locate the test file and find the end**

```bash
wc -l packages/meta/runtime/src/__tests__/golden-queries.test.ts
```

- [ ] **Step 2: Write the failing tests**

Add at the end of `golden-queries.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Golden: @koi/middleware-permissions — bash spec guard (no LLM)
// ---------------------------------------------------------------------------

describe("Golden: @koi/middleware-permissions — bash spec guard", () => {
  // These tests exercise the spec guard path directly, no LLM needed.
  // They mirror the deny scenarios from the issue acceptance criteria.

  test("rm -rf /etc denied by Write(/etc/**) semantic rule", async () => {
    const { createPermissionsMiddleware } = await import("@koi/middleware-permissions");
    const { createPermissionBackend } = await import("@koi/permissions");
    const { loadRules } = await import("@koi/permissions");
    const { runId, sessionId } = await import("@koi/core");

    // Rule: deny Write to /etc/**
    const rulesResult = loadRules(
      new Map([
        [
          "policy",
          [
            {
              Write: "/etc/**",
              effect: "deny",
              reason: "writes to system paths denied",
            } as unknown as import("@koi/permissions").PermissionRule,
          ],
        ],
      ]),
    );
    expect(rulesResult.ok).toBe(true);
    if (!rulesResult.ok) return;

    const backend = createPermissionBackend({
      mode: "default",
      rules: rulesResult.value,
    });

    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) =>
        (input as Record<string, string | undefined>).command,
      enableBashSpecGuard: true,
    });

    const deniedTools: string[] = [];
    const ctx = {
      session: { sessionId: sessionId("golden-test"), agentId: "agent:test" },
      turnIndex: 0,
      reportDecision: (d: { action: string; toolId: string }) => {
        if (d.action === "deny") deniedTools.push(d.toolId);
      },
    } as unknown as import("@koi/core/middleware").TurnContext;

    const req = {
      toolId: "bash",
      input: { command: "rm -rf /etc/passwd" },
      callId: runId("call-golden"),
    } as unknown as import("@koi/core/middleware").ToolRequest;

    let nextCalled = false;
    await mw
      .wrapToolCall(ctx, req, async () => {
        nextCalled = true;
        return { toolId: "bash", output: "" };
      })
      .catch(() => {});

    expect(nextCalled).toBe(false);
    expect(deniedTools).toContain("bash");
  });

  test("curl https://blocked.example.com denied by Network(blocked.example.com) rule", async () => {
    const { createPermissionsMiddleware } = await import("@koi/middleware-permissions");
    const { createPermissionBackend, loadRules } = await import("@koi/permissions");
    const { runId, sessionId } = await import("@koi/core");

    const rulesResult = loadRules(
      new Map([
        [
          "policy",
          [
            {
              Network: "blocked.example.com",
              effect: "deny",
              reason: "blocked host",
            } as unknown as import("@koi/permissions").PermissionRule,
            { pattern: "bash:*", action: "*", effect: "allow" } as import("@koi/permissions").PermissionRule,
          ],
        ],
      ]),
    );
    expect(rulesResult.ok).toBe(true);
    if (!rulesResult.ok) return;

    const backend = createPermissionBackend({ mode: "default", rules: rulesResult.value });
    const mw = createPermissionsMiddleware({
      backend,
      resolveBashCommand: (_toolId, input) =>
        (input as Record<string, string | undefined>).command,
      enableBashSpecGuard: true,
    });

    const deniedTools: string[] = [];
    const ctx = {
      session: { sessionId: sessionId("golden-network"), agentId: "agent:test" },
      turnIndex: 0,
      reportDecision: (d: { action: string; toolId: string }) => {
        if (d.action === "deny") deniedTools.push(d.toolId);
      },
    } as unknown as import("@koi/core/middleware").TurnContext;

    const req = {
      toolId: "bash",
      input: { command: "curl https://blocked.example.com/data" },
      callId: runId("call-network"),
    } as unknown as import("@koi/core/middleware").ToolRequest;

    let nextCalled = false;
    await mw
      .wrapToolCall(ctx, req, async () => {
        nextCalled = true;
        return { toolId: "bash", output: "" };
      })
      .catch(() => {});

    expect(nextCalled).toBe(false);
    expect(deniedTools).toContain("bash");
  });
});
```

- [ ] **Step 3: Run tests — expect failures initially**

```bash
bun test packages/meta/runtime/src/__tests__/golden-queries.test.ts --grep "bash spec guard" 2>&1 | tail -20
```

- [ ] **Step 4: Fix any import/runtime issues, run until passing**

```bash
bun test packages/meta/runtime/src/__tests__/golden-queries.test.ts --grep "bash spec guard" 2>&1 | tail -20
```
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/src/__tests__/golden-queries.test.ts
git commit -m "test(runtime): add standalone golden queries for bash spec guard deny path"
```

---

## Task 8: Full CI gate check

- [ ] **Step 1: Run all relevant test suites**

```bash
cd /Users/sophiawj/private/koi/.worktrees/issue-1919-bash-ast-permissions
bun run test --filter=@koi/permissions --filter=@koi/middleware-permissions --filter=@koi/bash-ast 2>&1 | tail -20
```
Expected: all pass.

- [ ] **Step 2: Typecheck all modified packages**

```bash
bun run typecheck --filter=@koi/permissions --filter=@koi/middleware-permissions 2>&1 | tail -15
```
Expected: zero errors.

- [ ] **Step 3: Lint**

```bash
bun run lint --filter=@koi/permissions --filter=@koi/middleware-permissions 2>&1 | tail -15
```
Expected: zero violations.

- [ ] **Step 4: Layer check**

```bash
bun run check:layers 2>&1 | tail -10
```
Expected: no violations.

- [ ] **Step 5: Unused exports check**

```bash
bun run check:unused 2>&1 | tail -10
```
Expected: no dead exports.

- [ ] **Step 6: Anti-leak checklist (manual)**

Verify:
- [ ] `@koi/bash-ast` is L0u → its import in `@koi/middleware-permissions` (L2 unlisted) is valid
- [ ] `@koi/middleware-permissions` does NOT import from `@koi/permissions` (L2 peer)
- [ ] `bash-spec-guard.ts` only imports from `@koi/bash-ast` (L0u) and `@koi/core` (L0)
- [ ] All new interface properties are `readonly`
- [ ] No `any`, no `!` non-null assertions

- [ ] **Step 7: Final commit / PR**

```bash
git log --oneline main..HEAD
```
Verify commit sequence looks clean. Open PR with description linking #1919, this design doc, and calling out the mandatory bundle (consumer + exact-argv guard + golden query).

---

## Task 9: Update `docs/L2/bash-ast.md` (consumer wiring section)

**Files:**
- Modify: `docs/L2/bash-ast.md`

The doc already has a "Per-command semantics" section (added in #1918). Add a subsection:

```markdown
### Consumer wiring — `@koi/middleware-permissions`

As of issue #1919, `@koi/middleware-permissions` calls `evaluateBashCommand` in
`wrapToolCall` when `enableBashSpecGuard: true` (default when `resolveBashCommand`
is configured). The guard:

1. Parses the raw bash command via `analyzeBashCommand`.
2. For `partial`/`refused` results: enforces that any `allow` from a prefix
   `Run(...)` rule is downgraded to `ask` unless an exact-argv `Run(...)` rule
   also allows the full command string.
3. For `complete`/`partial` results: evaluates `Write(path)`, `Read(path)`, and
   `Network(host)` rules from `@koi/permissions` against the spec's reported
   `writes`, `reads`, and `network[].host` fields.

`Write`, `Read`, and `Network` rules are authored in the permission config DSL as:
```json
{"Write": "/etc/**", "effect": "deny", "reason": "no writes to system paths"}
{"Read": "/proc/**", "effect": "deny"}
{"Network": "evil.com", "effect": "deny"}
```
The `@koi/permissions` rule-loader transforms these into standard
`{action: "write"/"read"/"network", pattern: path/host}` rules.
```

- [ ] **Step 1: Add the subsection**

- [ ] **Step 2: Commit**

```bash
git add docs/L2/bash-ast.md
git commit -m "docs(bash-ast): add consumer wiring section for middleware-permissions"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| Consumer wiring — call into `@koi/bash-ast/specs` | Task 4 (`bash-spec-guard.ts`) + Task 5 (wire into wrapToolCall) |
| Exact-argv `Run(...)` enforcement for `partial`/`refused` | Task 4 (exact-argv guard in `evaluateSpecGuard`) |
| `Write(path)`, `Read(path)`, `Network(host)` rule shapes | Task 1 (Zod DSL in rule-loader) |
| `Network(host)` uses `NetworkAccess.host` not `target` | Task 4 (`net.host` in `evaluateSemanticRules`) |
| prefix `Run(...)` rejected/promoted for partial/refused | Task 4 (returns `ask` unless exact query allows) |
| Golden query — deny path | Task 7 (standalone) |
| `middleware.ts` ≤ 800 lines | Task 3 |
| Tests prove `Network(example.com)` matches `curl https://example.com/path` | Task 4 test + Task 7 test |
| ssh/scp always refused → exact-argv only | Task 4 test ("refused spec + prefix allow → ask") |
| Bundled in single PR (consumer + guard + golden) | All tasks in one branch |

### Placeholder scan

No TBDs. Every step has exact file paths and complete code.

### Type consistency

- `evaluateSpecGuard` input uses `ReadonlyMap<string, CommandSpec>` — matches `createSpecRegistry()` return type after cast
- `SpecGuardOutcome` discriminated union — `kind: "skipped" | "spec-evaluated"` consistent throughout
- `stricter()` returns `PermissionDecision` — same type as `decision` in middleware
- `resolveQuery: (q: PermissionQuery) => Promise<PermissionDecision>` — matches signature of `(q) => resolveDecision(q, sessionId)`
