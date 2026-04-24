# gov-12 Approval Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `@koi/governance-approval-tiers` L2 package so Koi can persist user approvals granted with `scope: "always"` to a JSON-lines file and replay them silently on future turns, with a pattern-key aliasing layer that survives permission renames, plus a delta-audit hook that emits a violation record for every persisted grant.

**Architecture:** gov-11 (`@koi/governance-core`) already owns the session cache and the `ApprovalDecision` routing. gov-12 is a strict L2 *extension* that (a) implements a JSON-lines `ApprovalStore` at `~/.koi/approvals.json`, (b) wraps a `GovernanceBackend` so `ok: "ask"` verdicts short-circuit to `ok: true` when the persisted allowlist already has a match, (c) provides an `onApprovalPersist` sink that appends new `always` grants to the store, and (d) provides an `onViolation` adapter that writes a delta-audit record for every append. Tracks Issue #1879. Sub-issue of #1208. Requires promoting `PersistentGrant` (L2 → L0 `@koi/core`) and `computeGrantKey` (L2 → L0u `@koi/hash`) so the new L2 package can consume them without a peer-L2 dependency.

**Tech Stack:** TypeScript 6 (strict, ESM-only, `.js` import extensions), Bun 1.3 runtime, `bun:test`, tsup builds, Biome lint, Turborepo. JSON-lines persistence via `Bun.file()` + `Bun.write()`. SHA-256 hashing via `Bun.CryptoHasher` (already in `@koi/hash`).

---

## File Structure

**Promotions (unblock L2 import):**

- `packages/kernel/core/src/governance-backend.ts` — add `PersistentGrant` + `PersistentGrantCallback` types (L0, types-only).
- `packages/lib/hash/src/grant-key.ts` (create) + `packages/lib/hash/src/index.ts` (re-export) — move `computeGrantKey` verbatim from governance-core.
- `packages/security/governance-core/src/config.ts` — remove local `PersistentGrant`/`PersistentGrantCallback` defs, import from `@koi/core`.
- `packages/security/governance-core/src/grant-key.ts` — replace body with `export { computeGrantKey } from "@koi/hash";` (keeps stable local import path).
- `packages/security/governance-core/package.json` — add `@koi/hash` dep.

**New L2 package `@koi/governance-approval-tiers` at `packages/security/governance-approval-tiers/`:**

```
packages/security/governance-approval-tiers/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    types.ts            — ApprovalScope, PersistedApproval, ApprovalStore, AliasSpec, ApprovalQuery
    aliases.ts          — applyAliases(payload, aliases): JsonObject
    jsonl-store.ts      — createJsonlApprovalStore({ path, aliases? })
    backend-wrapper.ts  — wrapBackendWithPersistedAllowlist(backend, store)
    persist-sink.ts     — createPersistSink(store) → PersistentGrantCallback
    violation-audit.ts  — createViolationAuditAdapter(store) → ViolationCallback wrapper
    index.ts            — barrel exports
  src/__tests__/
    api-surface.test.ts
  src/aliases.test.ts
  src/jsonl-store.test.ts
  src/backend-wrapper.test.ts
  src/persist-sink.test.ts
  src/violation-audit.test.ts
```

**Docs + wiring:**

- `docs/L2/governance-approval-tiers.md` — required (CI doc-gate).
- `scripts/layers.ts` — add `@koi/governance-approval-tiers` to `L2_PACKAGES`.
- `packages/meta/runtime/package.json` + `tsconfig.json` — add `@koi/governance-approval-tiers` dep (Golden Query Rule).
- `packages/meta/runtime/scripts/record-cassettes.ts` — add `ask-tier-always` query config.
- `packages/meta/runtime/src/__tests__/golden-replay.test.ts` — add 2 standalone + 1 replay assertion.

Est. total LOC: ~430 (promotions ~40, package src ~230, tests ~110, doc ~50).

---

## Task 1: Promote `PersistentGrant` to `@koi/core`

**Files:**
- Modify: `packages/kernel/core/src/governance-backend.ts` (append after AskId section near line 125)
- Modify: `packages/kernel/core/src/index.ts` (export surface)
- Test: `packages/kernel/core/src/__tests__/governance-backend.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/core/src/__tests__/governance-backend.test.ts` (if it doesn't exist, otherwise append):

```typescript
import { describe, expect, it } from "bun:test";
import type {
  JsonObject,
  PersistentGrant,
  PersistentGrantCallback,
} from "@koi/core";

describe("PersistentGrant (L0)", () => {
  it("accepts a structurally valid grant", () => {
    const g: PersistentGrant = {
      kind: "tool_call",
      agentId: "a1" as never,
      sessionId: "s1" as never,
      payload: { tool: "bash" } as JsonObject,
      grantKey: "deadbeef",
      grantedAt: 1_713_974_400_000,
    };
    expect(g.kind).toBe("tool_call");
  });

  it("PersistentGrantCallback is a (grant) => void function type", () => {
    const cb: PersistentGrantCallback = (grant) => {
      expect(typeof grant.grantKey).toBe("string");
    };
    cb({
      kind: "tool_call",
      agentId: "a1" as never,
      sessionId: "s1" as never,
      payload: {} as JsonObject,
      grantKey: "x",
      grantedAt: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/kernel/core/src/__tests__/governance-backend.test.ts
```

Expected: FAIL — "PersistentGrant is not exported from @koi/core".

- [ ] **Step 3: Add types to `@koi/core`**

Insert into `packages/kernel/core/src/governance-backend.ts` immediately after the `isAskVerdict` block (around line 174):

```typescript
// ---------------------------------------------------------------------------
// PersistentGrant — record of an always-scoped approval (gov-11/12 bridge)
// ---------------------------------------------------------------------------

/**
 * An always-scoped approval grant recorded by governance middleware.
 *
 * Emitted by governance-core when a user chooses scope "always" on an
 * ok:"ask" verdict, and consumed by gov-12 persistence layers to replay
 * the grant on future sessions. `grantKey` is a stable SHA-256 hex digest
 * of (kind, payload) — see `@koi/hash`.`computeGrantKey`.
 */
export interface PersistentGrant {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly payload: JsonObject;
  readonly grantKey: string;
  readonly grantedAt: number;
}

/** Callback invoked exactly once per always-scoped approval. */
export type PersistentGrantCallback = (grant: PersistentGrant) => void | Promise<void>;
```

Add the re-export to `packages/kernel/core/src/index.ts`. Open that file; find the line that re-exports from `./governance-backend.js`; append `PersistentGrant` and `PersistentGrantCallback` to the `export type { ... }` list.

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/kernel/core/src/__tests__/governance-backend.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck core**

```
bun run --cwd packages/kernel/core typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/core/src/governance-backend.ts packages/kernel/core/src/index.ts packages/kernel/core/src/__tests__/governance-backend.test.ts
git commit -m "feat(core): promote PersistentGrant + PersistentGrantCallback to L0

Lets gov-12 (@koi/governance-approval-tiers, L2) consume the grant type
emitted by @koi/governance-core without a peer-L2 import. Pure type
addition — no runtime code."
```

---

## Task 2: Move `computeGrantKey` to `@koi/hash`

**Files:**
- Create: `packages/lib/hash/src/grant-key.ts`
- Modify: `packages/lib/hash/src/index.ts`
- Create: `packages/lib/hash/src/grant-key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lib/hash/src/grant-key.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { computeGrantKey } from "./grant-key.js";

describe("computeGrantKey", () => {
  it("returns a stable 64-char hex digest", () => {
    const key = computeGrantKey("tool_call", { tool: "bash", cmd: "ls" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent on object keys", () => {
    const a = computeGrantKey("tool_call", { tool: "bash", cmd: "ls" });
    const b = computeGrantKey("tool_call", { cmd: "ls", tool: "bash" });
    expect(a).toBe(b);
  });

  it("is order-sensitive on arrays", () => {
    const a = computeGrantKey("tool_call", { args: ["a", "b"] });
    const b = computeGrantKey("tool_call", { args: ["b", "a"] });
    expect(a).not.toBe(b);
  });

  it("distinguishes kind", () => {
    const payload = { tool: "bash" };
    expect(computeGrantKey("tool_call", payload)).not.toBe(
      computeGrantKey("model_call", payload),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/lib/hash/src/grant-key.test.ts
```

Expected: FAIL — "Cannot find module './grant-key.js'".

- [ ] **Step 3: Copy the implementation into `@koi/hash`**

Create `packages/lib/hash/src/grant-key.ts`:

```typescript
import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";

/**
 * Compute a stable SHA-256 hex digest for a (kind, payload) pair.
 *
 * Canonicalization rules:
 *   - Object keys are sorted recursively.
 *   - Arrays preserve order (semantically meaningful).
 *   - `undefined` values are dropped (JSON semantics).
 *   - Values with a `toJSON()` method (e.g., `Date`) are serialized via
 *     that method before canonicalization (standard JSON.stringify behavior).
 */
export function computeGrantKey(kind: PolicyRequestKind, payload: JsonObject): string {
  const canonical = canonicalJsonStringify({ kind, payload });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
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

Append to `packages/lib/hash/src/index.ts`:

```typescript
export { computeGrantKey } from "./grant-key.js";
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/lib/hash/src/grant-key.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/hash/src/grant-key.ts packages/lib/hash/src/index.ts packages/lib/hash/src/grant-key.test.ts
git commit -m "feat(hash): move computeGrantKey to @koi/hash

Gov-12 (L2) needs this helper. Relocating from @koi/governance-core
(L2) to @koi/hash (L0u) so both governance-core and the new
governance-approval-tiers package can share one implementation."
```

---

## Task 3: Re-export `computeGrantKey` from governance-core (no code break)

**Files:**
- Modify: `packages/security/governance-core/src/grant-key.ts`
- Modify: `packages/security/governance-core/src/config.ts`
- Modify: `packages/security/governance-core/package.json`

- [ ] **Step 1: Update `grant-key.ts` to re-export**

Replace the entire contents of `packages/security/governance-core/src/grant-key.ts` with:

```typescript
export { computeGrantKey } from "@koi/hash";
```

- [ ] **Step 2: Delete the duplicate test in governance-core (its assertions now live in @koi/hash)**

```
rm packages/security/governance-core/src/grant-key.test.ts
```

- [ ] **Step 3: Point governance-core's `PersistentGrant` at @koi/core**

Edit `packages/security/governance-core/src/config.ts`:

1. Update the top imports block to include `PersistentGrant, PersistentGrantCallback` from `@koi/core`:

```typescript
import type {
  AgentId,
  JsonObject,
  KoiError,
  PersistentGrant,
  PersistentGrantCallback,
  Result,
  SessionId,
} from "@koi/core";
```

2. Delete the local `PersistentGrant` interface and the `PersistentGrantCallback` type alias (the block starting `export interface PersistentGrant {` through the `PersistentGrantCallback` line). Do NOT delete their consumers below (`onApprovalPersist`); those still reference the now-imported types.

3. Re-export both from config.ts so downstream callers that did `import { PersistentGrant } from "@koi/governance-core"` still work:

```typescript
export type { PersistentGrant, PersistentGrantCallback } from "@koi/core";
```

- [ ] **Step 4: Add `@koi/hash` dep to governance-core**

Edit `packages/security/governance-core/package.json`. In the `dependencies` block, add:

```json
"@koi/hash": "workspace:*",
```

So the final block reads:

```json
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*",
    "@koi/hash": "workspace:*"
  }
```

- [ ] **Step 5: Install + test governance-core**

```
bun install
bun run test --filter=@koi/governance-core
```

Expected: all existing tests pass, no regressions.

- [ ] **Step 6: Layer check**

```
bun run check:layers
```

Expected: PASS (L2 → L0 + L0u only).

- [ ] **Step 7: Commit**

```bash
git add packages/security/governance-core/src/grant-key.ts packages/security/governance-core/src/config.ts packages/security/governance-core/package.json bun.lock
git rm packages/security/governance-core/src/grant-key.test.ts
git commit -m "refactor(governance-core): delegate grant-key + PersistentGrant to L0/L0u

Imports computeGrantKey from @koi/hash and PersistentGrant types from
@koi/core. Re-exports both so downstream consumers are unaffected."
```

---

## Task 4: Scaffold the `@koi/governance-approval-tiers` package

**Files:**
- Create: `packages/security/governance-approval-tiers/package.json`
- Create: `packages/security/governance-approval-tiers/tsconfig.json`
- Create: `packages/security/governance-approval-tiers/tsup.config.ts`
- Create: `packages/security/governance-approval-tiers/src/index.ts`
- Create: `packages/security/governance-approval-tiers/src/__tests__/api-surface.test.ts`
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Write the failing API-surface test**

Create `packages/security/governance-approval-tiers/src/__tests__/api-surface.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import * as api from "../index.js";

describe("@koi/governance-approval-tiers API surface", () => {
  it("exports the documented factory functions", () => {
    expect(typeof api.createJsonlApprovalStore).toBe("function");
    expect(typeof api.createPersistSink).toBe("function");
    expect(typeof api.wrapBackendWithPersistedAllowlist).toBe("function");
    expect(typeof api.createViolationAuditAdapter).toBe("function");
    expect(typeof api.applyAliases).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/__tests__/api-surface.test.ts
```

Expected: FAIL — package does not exist.

- [ ] **Step 3: Create `package.json`**

Create `packages/security/governance-approval-tiers/package.json`:

```json
{
  "name": "@koi/governance-approval-tiers",
  "description": "Persistent approval allowlist (JSON-lines) with scope tiers, aliasing, and delta audit",
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
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*",
    "@koi/hash": "workspace:*"
  }
}
```

- [ ] **Step 4: Create `tsconfig.json`**

Create `packages/security/governance-approval-tiers/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: Create `tsup.config.ts`**

Copy the tsup config pattern from a sibling package. Create `packages/security/governance-approval-tiers/tsup.config.ts`:

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
});
```

- [ ] **Step 6: Create the index barrel**

Create `packages/security/governance-approval-tiers/src/index.ts`:

```typescript
export {
  type ApprovalScope,
  type PersistedApproval,
  type ApprovalStore,
  type ApprovalQuery,
  type AliasSpec,
} from "./types.js";
export { applyAliases } from "./aliases.js";
export { createJsonlApprovalStore } from "./jsonl-store.js";
export { wrapBackendWithPersistedAllowlist } from "./backend-wrapper.js";
export { createPersistSink } from "./persist-sink.js";
export { createViolationAuditAdapter } from "./violation-audit.js";
```

- [ ] **Step 7: Register the package in the layer canon**

Open `scripts/layers.ts`. Locate the `L2_PACKAGES` set (it's a sorted list of `@koi/*` entries). Insert `"@koi/governance-approval-tiers",` in alphabetical order (it goes after `@koi/governance-core` entry if present, otherwise sorted into its alphabetical slot).

- [ ] **Step 8: Install so the workspace sees the new package**

```
bun install
```

- [ ] **Step 9: Run test to confirm it still fails on the specific missing modules**

```
bun test packages/security/governance-approval-tiers/src/__tests__/api-surface.test.ts
```

Expected: FAIL — module `./types.js` not found (because we haven't implemented the sub-modules yet — that's Tasks 5–9). This is the intended state.

- [ ] **Step 10: Commit the scaffold**

```bash
git add packages/security/governance-approval-tiers scripts/layers.ts bun.lock
git commit -m "scaffold(governance-approval-tiers): create empty L2 package

Placeholder package.json, tsconfig, tsup config, and layer
registration. No implementation yet — that lands module by module in
the following commits."
```

---

## Task 5: Implement `types.ts` (domain types)

**Files:**
- Create: `packages/security/governance-approval-tiers/src/types.ts`

- [ ] **Step 1: Write the failing test (type-only compile check)**

Create `packages/security/governance-approval-tiers/src/types.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type {
  AliasSpec,
  ApprovalQuery,
  ApprovalScope,
  ApprovalStore,
  PersistedApproval,
} from "./types.js";
import type { JsonObject } from "@koi/core";

describe("types.ts", () => {
  it("ApprovalScope is the narrow string union", () => {
    const values: readonly ApprovalScope[] = ["once", "session", "always"];
    expect(values).toEqual(["once", "session", "always"]);
  });

  it("PersistedApproval has all required fields", () => {
    const g: PersistedApproval = {
      kind: "tool_call",
      payload: {} as JsonObject,
      grantKey: "x",
      grantedAt: 0,
    };
    expect(g.kind).toBe("tool_call");
  });

  it("ApprovalQuery matches the (kind, payload) shape", () => {
    const q: ApprovalQuery = { kind: "tool_call", payload: {} as JsonObject };
    expect(q.kind).toBe("tool_call");
  });

  it("AliasSpec carries kind/field/from/to", () => {
    const a: AliasSpec = { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" };
    expect(a.from).toBe("bash_exec");
  });

  it("ApprovalStore surface is append + match + load", () => {
    const stub: ApprovalStore = {
      append: async () => undefined,
      match: async () => undefined,
      load: async () => [],
    };
    expect(typeof stub.append).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/types.test.ts
```

Expected: FAIL — `./types.js` not found.

- [ ] **Step 3: Implement `types.ts`**

Create `packages/security/governance-approval-tiers/src/types.ts`:

```typescript
import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";

/** Narrow union of the three user-facing approval tiers. */
export type ApprovalScope = "once" | "session" | "always";

/** A single persisted approval record. Append-only. */
export interface PersistedApproval {
  readonly kind: PolicyRequestKind;
  readonly payload: JsonObject;
  /** Stable SHA-256 hex of (kind, payload) via @koi/hash.computeGrantKey. */
  readonly grantKey: string;
  /** Unix timestamp (ms) when the grant was recorded. */
  readonly grantedAt: number;
  /**
   * Optional: the grantKey this record supersedes when the grant was
   * migrated via an AliasSpec. Preserves a history trail without
   * mutating previously-written lines.
   */
  readonly aliasOf?: string;
}

/** Query shape for ApprovalStore.match(). */
export interface ApprovalQuery {
  readonly kind: PolicyRequestKind;
  readonly payload: JsonObject;
}

/**
 * Renames a single payload field so that approvals granted under an
 * old value still match new queries carrying the new value. Applied
 * identically on append (canonicalises new grants to the target value)
 * and on match (rewrites the query before computing grantKey).
 */
export interface AliasSpec {
  readonly kind: PolicyRequestKind;
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/** Persistent approval allowlist. All methods are async. */
export interface ApprovalStore {
  readonly append: (g: PersistedApproval) => Promise<void>;
  readonly match: (q: ApprovalQuery) => Promise<PersistedApproval | undefined>;
  readonly load: () => Promise<readonly PersistedApproval[]>;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/security/governance-approval-tiers/src/types.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-approval-tiers/src/types.ts packages/security/governance-approval-tiers/src/types.test.ts
git commit -m "feat(governance-approval-tiers): domain types

ApprovalScope, PersistedApproval, ApprovalQuery, AliasSpec,
ApprovalStore. All readonly, L0-compatible imports only."
```

---

## Task 6: Implement `aliases.ts` (pattern-key rewriting)

**Files:**
- Create: `packages/security/governance-approval-tiers/src/aliases.ts`
- Create: `packages/security/governance-approval-tiers/src/aliases.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/security/governance-approval-tiers/src/aliases.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { JsonObject } from "@koi/core";
import { applyAliases } from "./aliases.js";
import type { AliasSpec } from "./types.js";

const aliases: readonly AliasSpec[] = [
  { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
  { kind: "tool_call", field: "tool", from: "shell_exec", to: "bash" },
];

describe("applyAliases", () => {
  it("rewrites a matching field", () => {
    const p = applyAliases("tool_call", { tool: "bash_exec", cmd: "ls" } as JsonObject, aliases);
    expect(p).toEqual({ tool: "bash", cmd: "ls" });
  });

  it("passes through when kind does not match", () => {
    const p = applyAliases("model_call", { tool: "bash_exec" } as JsonObject, aliases);
    expect(p).toEqual({ tool: "bash_exec" });
  });

  it("passes through when field value does not match", () => {
    const p = applyAliases("tool_call", { tool: "python" } as JsonObject, aliases);
    expect(p).toEqual({ tool: "python" });
  });

  it("passes through when the field is absent", () => {
    const p = applyAliases("tool_call", { cmd: "ls" } as JsonObject, aliases);
    expect(p).toEqual({ cmd: "ls" });
  });

  it("applies multiple specs in order (first match wins)", () => {
    const p = applyAliases("tool_call", { tool: "shell_exec" } as JsonObject, aliases);
    expect(p).toEqual({ tool: "bash" });
  });

  it("returns a fresh object — does not mutate input", () => {
    const input = { tool: "bash_exec", cmd: "ls" } as JsonObject;
    applyAliases("tool_call", input, aliases);
    expect(input).toEqual({ tool: "bash_exec", cmd: "ls" });
  });

  it("returns input reference when no aliases are provided", () => {
    const input = { tool: "bash" } as JsonObject;
    expect(applyAliases("tool_call", input, [])).toBe(input);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/aliases.test.ts
```

Expected: FAIL — `./aliases.js` not found.

- [ ] **Step 3: Implement `aliases.ts`**

Create `packages/security/governance-approval-tiers/src/aliases.ts`:

```typescript
import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";
import type { AliasSpec } from "./types.js";

/**
 * Rewrite payload fields according to the alias specs. Fresh object
 * on rewrite; input reference on no-op. First matching spec wins per
 * field. Non-string field values are left untouched.
 */
export function applyAliases(
  kind: PolicyRequestKind,
  payload: JsonObject,
  aliases: readonly AliasSpec[],
): JsonObject {
  if (aliases.length === 0) return payload;
  let next: Record<string, unknown> | undefined;
  for (const alias of aliases) {
    if (alias.kind !== kind) continue;
    const current = (next ?? payload)[alias.field];
    if (current !== alias.from) continue;
    if (next === undefined) next = { ...payload };
    next[alias.field] = alias.to;
  }
  return (next ?? payload) as JsonObject;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/security/governance-approval-tiers/src/aliases.test.ts
```

Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-approval-tiers/src/aliases.ts packages/security/governance-approval-tiers/src/aliases.test.ts
git commit -m "feat(governance-approval-tiers): applyAliases field rewriter

First-match-wins, immutable, kind-scoped. Returns input reference
when no aliases apply for zero-cost passthrough."
```

---

## Task 7: Implement `jsonl-store.ts` (persistent allowlist)

**Files:**
- Create: `packages/security/governance-approval-tiers/src/jsonl-store.ts`
- Create: `packages/security/governance-approval-tiers/src/jsonl-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/security/governance-approval-tiers/src/jsonl-store.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@koi/core";
import { computeGrantKey } from "@koi/hash";
import { createJsonlApprovalStore } from "./jsonl-store.js";
import type { AliasSpec, PersistedApproval } from "./types.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "approval-tiers-"));
  path = join(dir, "approvals.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createJsonlApprovalStore", () => {
  it("returns undefined when the file does not exist", async () => {
    const store = createJsonlApprovalStore({ path });
    expect(await store.match({ kind: "tool_call", payload: {} as JsonObject })).toBeUndefined();
    expect(await store.load()).toEqual([]);
  });

  it("appends one grant per line", async () => {
    const store = createJsonlApprovalStore({ path });
    const g1: PersistedApproval = {
      kind: "tool_call",
      payload: { tool: "bash", cmd: "ls" } as JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash", cmd: "ls" }),
      grantedAt: 1,
    };
    const g2: PersistedApproval = {
      kind: "tool_call",
      payload: { tool: "bash", cmd: "rm" } as JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash", cmd: "rm" }),
      grantedAt: 2,
    };
    await store.append(g1);
    await store.append(g2);
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0).length).toBe(2);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("matches a stored grant by canonical (kind, payload)", async () => {
    const store = createJsonlApprovalStore({ path });
    const payload = { tool: "bash", cmd: "ls" } as JsonObject;
    await store.append({
      kind: "tool_call",
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const hit = await store.match({ kind: "tool_call", payload });
    expect(hit?.grantKey).toBe(computeGrantKey("tool_call", payload));
  });

  it("persists across store instances (read-path)", async () => {
    const a = createJsonlApprovalStore({ path });
    const payload = { tool: "bash" } as JsonObject;
    await a.append({
      kind: "tool_call",
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const b = createJsonlApprovalStore({ path });
    const hit = await b.match({ kind: "tool_call", payload });
    expect(hit).toBeDefined();
  });

  it("skips malformed lines and loads the rest", async () => {
    const good: PersistedApproval = {
      kind: "tool_call",
      payload: { tool: "bash" } as JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash" }),
      grantedAt: 1,
    };
    await writeFile(path, `${JSON.stringify(good)}\nnot-json\n\n`);
    const store = createJsonlApprovalStore({ path });
    const loaded = await store.load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.grantKey).toBe(good.grantKey);
  });

  it("rewrites query via aliases before matching", async () => {
    const aliases: readonly AliasSpec[] = [
      { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
    ];
    const store = createJsonlApprovalStore({ path, aliases });
    // Grant was recorded under the new key "bash"
    const newPayload = { tool: "bash" } as JsonObject;
    await store.append({
      kind: "tool_call",
      payload: newPayload,
      grantKey: computeGrantKey("tool_call", newPayload),
      grantedAt: 1,
    });
    // Incoming query still uses the legacy name "bash_exec"
    const hit = await store.match({
      kind: "tool_call",
      payload: { tool: "bash_exec" } as JsonObject,
    });
    expect(hit).toBeDefined();
  });

  it("serialises concurrent appends without losing writes", async () => {
    const store = createJsonlApprovalStore({ path });
    const grants = Array.from({ length: 20 }, (_, i) => {
      const payload = { tool: "bash", n: i } as JsonObject;
      return {
        kind: "tool_call" as const,
        payload,
        grantKey: computeGrantKey("tool_call", payload),
        grantedAt: i,
      };
    });
    await Promise.all(grants.map((g) => store.append(g)));
    const loaded = await store.load();
    expect(loaded.length).toBe(20);
  });

  it("creates the parent directory if missing", async () => {
    const deep = join(dir, "nested", "path", "approvals.json");
    const store = createJsonlApprovalStore({ path: deep });
    const payload = { tool: "bash" } as JsonObject;
    await store.append({
      kind: "tool_call",
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const loaded = await store.load();
    expect(loaded.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/jsonl-store.test.ts
```

Expected: FAIL — `./jsonl-store.js` not found.

- [ ] **Step 3: Implement `jsonl-store.ts`**

Create `packages/security/governance-approval-tiers/src/jsonl-store.ts`:

```typescript
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { computeGrantKey } from "@koi/hash";
import { applyAliases } from "./aliases.js";
import type { AliasSpec, ApprovalQuery, ApprovalStore, PersistedApproval } from "./types.js";

export interface JsonlApprovalStoreConfig {
  readonly path: string;
  readonly aliases?: readonly AliasSpec[];
}

export function createJsonlApprovalStore(config: JsonlApprovalStoreConfig): ApprovalStore {
  const aliases = config.aliases ?? [];
  let writeQueue: Promise<void> = Promise.resolve();

  async function readAll(): Promise<readonly PersistedApproval[]> {
    const file = Bun.file(config.path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const out: PersistedApproval[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as PersistedApproval);
      } catch {
        // Malformed line — skip.
      }
    }
    return out;
  }

  async function writeLine(line: string): Promise<void> {
    await mkdir(dirname(config.path), { recursive: true });
    const existing = (await Bun.file(config.path).exists())
      ? await Bun.file(config.path).text()
      : "";
    await Bun.write(config.path, `${existing}${line}\n`);
  }

  return {
    async append(grant) {
      writeQueue = writeQueue.then(() => writeLine(JSON.stringify(grant)));
      await writeQueue;
    },

    async match(query: ApprovalQuery) {
      const canonical = applyAliases(query.kind, query.payload, aliases);
      const targetKey = computeGrantKey(query.kind, canonical);
      const entries = await readAll();
      for (const entry of entries) {
        if (entry.grantKey === targetKey) return entry;
      }
      return undefined;
    },

    async load() {
      return readAll();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/security/governance-approval-tiers/src/jsonl-store.test.ts
```

Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-approval-tiers/src/jsonl-store.ts packages/security/governance-approval-tiers/src/jsonl-store.test.ts
git commit -m "feat(governance-approval-tiers): JSON-lines append-only store

Persists approvals to ~/.koi/approvals.json (or configured path).
Missing file → empty allowlist, malformed lines → skipped, concurrent
appends serialised via promise chain, parent dir auto-created, alias
rewriting applied on match."
```

---

## Task 8: Implement `backend-wrapper.ts` (short-circuit ask verdicts)

**Files:**
- Create: `packages/security/governance-approval-tiers/src/backend-wrapper.ts`
- Create: `packages/security/governance-approval-tiers/src/backend-wrapper.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/security/governance-approval-tiers/src/backend-wrapper.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { JsonObject } from "@koi/core";
import {
  type GovernanceBackend,
  type GovernanceVerdict,
  type PolicyRequest,
  askId,
} from "@koi/core/governance-backend";
import { computeGrantKey } from "@koi/hash";
import { wrapBackendWithPersistedAllowlist } from "./backend-wrapper.js";
import type { ApprovalStore, PersistedApproval } from "./types.js";

function makeStore(entries: readonly PersistedApproval[]): ApprovalStore {
  return {
    append: async () => undefined,
    load: async () => entries,
    async match(q) {
      const target = computeGrantKey(q.kind, q.payload);
      return entries.find((e) => e.grantKey === target);
    },
  };
}

const allowRequest: PolicyRequest = {
  kind: "tool_call",
  agentId: "a" as never,
  payload: { tool: "bash" } as JsonObject,
  timestamp: 0,
};

describe("wrapBackendWithPersistedAllowlist", () => {
  it("passes through ok:true verdicts unchanged", async () => {
    const inner: GovernanceBackend = {
      evaluator: { evaluate: () => ({ ok: true }) as GovernanceVerdict },
    };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(true);
  });

  it("passes through ok:false verdicts unchanged", async () => {
    const deny: GovernanceVerdict = {
      ok: false,
      violations: [{ rule: "r", severity: "critical", message: "nope" }],
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => deny } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(false);
  });

  it("converts ok:ask to ok:true when the store has a match", async () => {
    const payload = { tool: "bash" } as JsonObject;
    const grantKey = computeGrantKey("tool_call", payload);
    const store = makeStore([{ kind: "tool_call", payload, grantKey, grantedAt: 1 }]);
    const ask: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("x"),
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => ask } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, store);
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(true);
  });

  it("leaves ok:ask unchanged when the store has no match", async () => {
    const ask: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("x"),
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => ask } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe("ask");
  });

  it("preserves optional sub-interfaces of the wrapped backend", async () => {
    const inner: GovernanceBackend = {
      evaluator: { evaluate: () => ({ ok: true }) as GovernanceVerdict },
      compliance: { recordCompliance: (r) => r },
      describeRules: () => [],
    };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    expect(wrapped.compliance).toBe(inner.compliance);
    expect(wrapped.describeRules).toBe(inner.describeRules);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/backend-wrapper.test.ts
```

Expected: FAIL — `./backend-wrapper.js` not found.

- [ ] **Step 3: Implement `backend-wrapper.ts`**

Create `packages/security/governance-approval-tiers/src/backend-wrapper.ts`:

```typescript
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import type { GovernanceBackend, PolicyEvaluator } from "@koi/core/governance-backend";
import type { ApprovalStore } from "./types.js";

/**
 * Wrap a GovernanceBackend so that ok:"ask" verdicts are short-circuited
 * to GOVERNANCE_ALLOW when the persistent allowlist already contains a
 * matching grant. All other verdicts pass through unchanged.
 */
export function wrapBackendWithPersistedAllowlist(
  inner: GovernanceBackend,
  store: ApprovalStore,
): GovernanceBackend {
  const evaluator: PolicyEvaluator = {
    async evaluate(request) {
      const verdict = await inner.evaluator.evaluate(request);
      if (verdict.ok !== "ask") return verdict;
      const hit = await store.match({ kind: request.kind, payload: request.payload });
      return hit === undefined ? verdict : GOVERNANCE_ALLOW;
    },
    ...(inner.evaluator.scope !== undefined ? { scope: inner.evaluator.scope } : {}),
  };

  return {
    evaluator,
    ...(inner.constraints !== undefined ? { constraints: inner.constraints } : {}),
    ...(inner.compliance !== undefined ? { compliance: inner.compliance } : {}),
    ...(inner.violations !== undefined ? { violations: inner.violations } : {}),
    ...(inner.dispose !== undefined ? { dispose: inner.dispose } : {}),
    ...(inner.describeRules !== undefined ? { describeRules: inner.describeRules } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/security/governance-approval-tiers/src/backend-wrapper.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-approval-tiers/src/backend-wrapper.ts packages/security/governance-approval-tiers/src/backend-wrapper.test.ts
git commit -m "feat(governance-approval-tiers): backend wrapper

Converts ok:ask to ok:true when the persistent allowlist matches.
All other verdicts and all optional sub-interfaces pass through."
```

---

## Task 9: Implement `persist-sink.ts` (onApprovalPersist handler)

**Files:**
- Create: `packages/security/governance-approval-tiers/src/persist-sink.ts`
- Create: `packages/security/governance-approval-tiers/src/persist-sink.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/security/governance-approval-tiers/src/persist-sink.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { JsonObject, PersistentGrant } from "@koi/core";
import { createPersistSink } from "./persist-sink.js";
import type { ApprovalStore, PersistedApproval } from "./types.js";

function makeStore(): { readonly store: ApprovalStore; readonly appended: PersistedApproval[] } {
  const appended: PersistedApproval[] = [];
  return {
    appended,
    store: {
      append: async (g) => {
        appended.push(g);
      },
      match: async () => undefined,
      load: async () => appended,
    },
  };
}

const grant: PersistentGrant = {
  kind: "tool_call",
  agentId: "a1" as never,
  sessionId: "s1" as never,
  payload: { tool: "bash" } as JsonObject,
  grantKey: "deadbeef",
  grantedAt: 1_713_974_400_000,
};

describe("createPersistSink", () => {
  it("appends a PersistedApproval on each call", async () => {
    const { store, appended } = makeStore();
    const sink = createPersistSink(store);
    await sink(grant);
    expect(appended.length).toBe(1);
    expect(appended[0]).toEqual({
      kind: grant.kind,
      payload: grant.payload,
      grantKey: grant.grantKey,
      grantedAt: grant.grantedAt,
    });
  });

  it("drops agentId and sessionId — they are session-scoped, not content-scoped", async () => {
    const { store, appended } = makeStore();
    const sink = createPersistSink(store);
    await sink(grant);
    expect(appended[0]).not.toHaveProperty("agentId");
    expect(appended[0]).not.toHaveProperty("sessionId");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/persist-sink.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `persist-sink.ts`**

Create `packages/security/governance-approval-tiers/src/persist-sink.ts`:

```typescript
import type { PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type { ApprovalStore } from "./types.js";

/**
 * Adapter: convert PersistentGrant (session-scoped envelope from
 * gov-11) into a PersistedApproval (content-scoped record) and append
 * it to the durable store. agentId/sessionId are stripped because the
 * grant applies to the canonical (kind, payload), not to the actor.
 */
export function createPersistSink(store: ApprovalStore): PersistentGrantCallback {
  return async (grant: PersistentGrant) => {
    await store.append({
      kind: grant.kind,
      payload: grant.payload,
      grantKey: grant.grantKey,
      grantedAt: grant.grantedAt,
    });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/security/governance-approval-tiers/src/persist-sink.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-approval-tiers/src/persist-sink.ts packages/security/governance-approval-tiers/src/persist-sink.test.ts
git commit -m "feat(governance-approval-tiers): onApprovalPersist sink

Adapts PersistentGrant (session-scoped) to PersistedApproval
(content-scoped) and appends to the store."
```

---

## Task 10: Implement `violation-audit.ts` (delta audit via onViolation)

**Files:**
- Create: `packages/security/governance-approval-tiers/src/violation-audit.ts`
- Create: `packages/security/governance-approval-tiers/src/violation-audit.test.ts`

Goal: when a grant is appended, emit a synthetic `Violation` with severity `info` through the host's existing `onViolation` callback so gov-2 audit sinks record an immutable delta-audit trail of who approved what when.

- [ ] **Step 1: Write the failing test**

Create `packages/security/governance-approval-tiers/src/violation-audit.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import type { JsonObject, PersistentGrant } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest, Violation } from "@koi/core/governance-backend";
import { createViolationAuditAdapter } from "./violation-audit.js";

type Recorded = { readonly verdict: GovernanceVerdict; readonly request: PolicyRequest };

const grant: PersistentGrant = {
  kind: "tool_call",
  agentId: "a1" as never,
  sessionId: "s1" as never,
  payload: { tool: "bash", cmd: "ls" } as JsonObject,
  grantKey: "deadbeef",
  grantedAt: 1_713_974_400_000,
};

describe("createViolationAuditAdapter", () => {
  it("wraps a persist-sink so each grant emits an info violation", async () => {
    const recorded: Recorded[] = [];
    const onViolation = (verdict: GovernanceVerdict, request: PolicyRequest): void => {
      recorded.push({ verdict, request });
    };
    const innerSink = async (_g: PersistentGrant): Promise<void> => undefined;
    const auditedSink = createViolationAuditAdapter({ sink: innerSink, onViolation });
    await auditedSink(grant);

    expect(recorded.length).toBe(1);
    const rec = recorded[0];
    if (rec === undefined) throw new Error("no record");
    expect(rec.request.kind).toBe("tool_call");
    expect(rec.request.agentId).toBe(grant.agentId);
    expect(rec.request.payload).toEqual(grant.payload);

    if (rec.verdict.ok !== true) throw new Error("verdict must be allow");
    const diag = rec.verdict.diagnostics ?? [];
    const v = diag[0];
    if (v === undefined) throw new Error("no diagnostic");
    const audit: Violation = v;
    expect(audit.rule).toBe("approval.persisted");
    expect(audit.severity).toBe("info");
    expect(audit.context).toMatchObject({ grantKey: grant.grantKey });
  });

  it("still calls the inner sink", async () => {
    let innerCalled = 0;
    const innerSink = async (_g: PersistentGrant): Promise<void> => {
      innerCalled += 1;
    };
    const auditedSink = createViolationAuditAdapter({
      sink: innerSink,
      onViolation: () => undefined,
    });
    await auditedSink(grant);
    expect(innerCalled).toBe(1);
  });

  it("runs onViolation after the inner sink resolves", async () => {
    const order: string[] = [];
    const innerSink = async (): Promise<void> => {
      order.push("inner");
    };
    const onViolation = (): void => {
      order.push("audit");
    };
    const auditedSink = createViolationAuditAdapter({ sink: innerSink, onViolation });
    await auditedSink(grant);
    expect(order).toEqual(["inner", "audit"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test packages/security/governance-approval-tiers/src/violation-audit.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `violation-audit.ts`**

Create `packages/security/governance-approval-tiers/src/violation-audit.ts`:

```typescript
import type { PersistentGrant, PersistentGrantCallback } from "@koi/core";
import type {
  GovernanceVerdict,
  PolicyRequest,
  Violation,
} from "@koi/core/governance-backend";

export interface ViolationAuditConfig {
  readonly sink: PersistentGrantCallback;
  readonly onViolation: (verdict: GovernanceVerdict, request: PolicyRequest) => void;
}

/**
 * Wrap a PersistentGrantCallback so that every appended grant also
 * emits a synthetic info-severity Violation through the host's
 * existing onViolation channel. gov-2 audit sinks (ndjson, sqlite)
 * pick it up automatically — no direct coupling to the audit layer.
 */
export function createViolationAuditAdapter(
  config: ViolationAuditConfig,
): PersistentGrantCallback {
  return async (grant: PersistentGrant) => {
    await config.sink(grant);

    const audit: Violation = {
      rule: "approval.persisted",
      severity: "info",
      message: "Persistent approval recorded",
      context: {
        grantKey: grant.grantKey,
        grantedAt: grant.grantedAt,
      },
    };
    const verdict: GovernanceVerdict = { ok: true, diagnostics: [audit] };
    const request: PolicyRequest = {
      kind: grant.kind,
      agentId: grant.agentId,
      payload: grant.payload,
      timestamp: grant.grantedAt,
    };
    config.onViolation(verdict, request);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
bun test packages/security/governance-approval-tiers/src/violation-audit.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-approval-tiers/src/violation-audit.ts packages/security/governance-approval-tiers/src/violation-audit.test.ts
git commit -m "feat(governance-approval-tiers): onViolation delta-audit adapter

Wraps a persist-sink so every appended grant emits an info-severity
Violation through the host's onViolation callback. gov-2 audit sinks
record the delta automatically — no direct coupling."
```

---

## Task 11: Confirm API surface test passes end-to-end

**Files:**
- Verify: `packages/security/governance-approval-tiers/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Run the full package test suite**

```
bun run test --filter=@koi/governance-approval-tiers
```

Expected: all tests pass (types, aliases, jsonl-store, backend-wrapper, persist-sink, violation-audit, api-surface).

- [ ] **Step 2: Typecheck + lint + layer check**

```
bun run --cwd packages/security/governance-approval-tiers typecheck
bun run --cwd packages/security/governance-approval-tiers lint
bun run check:layers
```

Expected: all exit 0.

- [ ] **Step 3: If any step fails, fix and commit (do NOT skip)**

No expected commit for this task if everything already passes.

---

## Task 12: Write `docs/L2/governance-approval-tiers.md`

**Files:**
- Create: `docs/L2/governance-approval-tiers.md`

- [ ] **Step 1: Write the doc**

Create `docs/L2/governance-approval-tiers.md`:

```markdown
# @koi/governance-approval-tiers — Persistent approval allowlist with tier support

Pairs with `@koi/governance-core` gov-11 ask-verdict plumbing to give users durable approvals across sessions. Every `ask` verdict the user answers with scope "always" is appended to `~/.koi/approvals.json` as a JSON-lines record; on future turns the wrapper short-circuits the `ask` to `ok: true` when a stored grant matches, so the user is not prompted twice.

## Why It Exists

`@koi/governance-core` already owns the session cache and the timeout, but on process restart every `always` decision is lost. Gov-12 closes the loop: append on grant, load on match, never prompt again for content the user has already signed off on. An alias layer lets downstream permission renames (e.g., `bash_exec` → `bash`) migrate without invalidating existing grants, and an optional delta-audit adapter emits a synthetic info-severity violation through the host's existing `onViolation` callback so gov-2 audit sinks record the decision trail immutably.

## Architecture

```
user turn
   │
   ▼
governance middleware (gov-11)
   │   evaluator.evaluate(request)
   ▼
wrapBackendWithPersistedAllowlist  ◄── gov-12
   │   if ok:"ask" and store.match hit → return ok:true
   │   else → passthrough
   ▼
ApprovalHandler (TUI / channel)
   │   user picks once / session / always
   ▼
if always → onApprovalPersist(grant)
   │
   ▼
createPersistSink(store)  ◄── gov-12
   │   store.append(...)
   │
   ├── wrapped by createViolationAuditAdapter  ◄── gov-12 (optional)
   │         └── onViolation(info:approval.persisted)
   │               └── @koi/audit-sink-* (gov-2)
   ▼
~/.koi/approvals.json  (JSON-lines, append-only)
```

### Layer position

- L0: `@koi/core` (PersistentGrant, PolicyRequest, GovernanceVerdict types)
- L0u: `@koi/hash` (computeGrantKey), `@koi/errors`
- L2 peer: `@koi/governance-core` (emits the `onApprovalPersist` callback that this package handles)

### Internal module map

- `types.ts` — ApprovalScope, PersistedApproval, ApprovalStore, AliasSpec, ApprovalQuery
- `aliases.ts` — applyAliases(kind, payload, specs)
- `jsonl-store.ts` — createJsonlApprovalStore({ path, aliases? })
- `backend-wrapper.ts` — wrapBackendWithPersistedAllowlist(backend, store)
- `persist-sink.ts` — createPersistSink(store)
- `violation-audit.ts` — createViolationAuditAdapter({ sink, onViolation })

## API

### `createJsonlApprovalStore({ path, aliases? })`

```typescript
const store = createJsonlApprovalStore({
  path: `${process.env.HOME}/.koi/approvals.json`,
  aliases: [{ kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" }],
});
```

- Missing file → empty allowlist (not an error).
- Malformed JSONL lines → skipped, remaining entries still load.
- Concurrent `append` calls serialise via an internal promise chain.
- Parent directory is created on first write.

### `wrapBackendWithPersistedAllowlist(backend, store)`

Produces a new `GovernanceBackend` where `evaluator.evaluate()` returns `GOVERNANCE_ALLOW` in place of an `ok:"ask"` verdict when the store has a matching grant. All other sub-interfaces (`constraints`, `compliance`, `violations`, `dispose`, `describeRules`) pass through untouched.

### `createPersistSink(store)`

Returns a `PersistentGrantCallback` to wire into `GovernanceMiddlewareConfig.onApprovalPersist`. Converts the session-scoped `PersistentGrant` into a content-scoped `PersistedApproval` by dropping `agentId` and `sessionId`.

### `createViolationAuditAdapter({ sink, onViolation })`

Wraps any `PersistentGrantCallback` so every append also emits a synthetic `Violation { rule: "approval.persisted", severity: "info" }` through the host's existing `onViolation` channel. Gov-2 audit sinks pick it up automatically.

## Fail-Closed Contract

- Store read errors → return `undefined` from `match`; caller falls through to `ask`. The user gets prompted rather than silently allowed.
- Store write errors → bubble up as typed `KoiError`; caller decides whether to retry.
- The wrapper NEVER upgrades a denial (`ok: false`) to an allow. It only strips `ok: "ask"` when a durable grant exists.

## Persistence

File: `~/.koi/approvals.json` (override via `path`). One JSON object per line.

```
{"kind":"tool_call","payload":{"tool":"bash","cmd":"ls"},"grantKey":"a3f2…","grantedAt":1713974400000}
{"kind":"tool_call","payload":{"tool":"bash","cmd":"rm"},"grantKey":"b8c1…","grantedAt":1713974500000}
```

Append-only. Existing lines are never mutated. Migrations happen via `AliasSpec` at read time, not by rewriting history.

## See Also

- `@koi/governance-core` — emits the `ok:"ask"` verdict and the `onApprovalPersist` callback that this package handles.
- `@koi/audit-sink-ndjson`, `@koi/audit-sink-sqlite` — gov-2 audit destinations that receive the delta-audit record.
- Tracking issue: #1879 (parent #1208).
```

- [ ] **Step 2: Verify doc-gate passes**

```
bun run check:doc-gate
```

(If the script has a different name, grep: `grep -r "doc-gate\|doc:check" scripts/ package.json`.)

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/L2/governance-approval-tiers.md
git commit -m "docs(governance-approval-tiers): L2 package documentation

Architecture, API, fail-closed contract, persistence format, and
See Also pointers. Satisfies doc-gate."
```

---

## Task 13: Wire the package into `@koi/runtime`

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`

Goal: satisfy `check:orphans` — every L2 must be a `@koi/runtime` dep.

- [ ] **Step 1: Add dependency**

Edit `packages/meta/runtime/package.json`. In `dependencies`, insert `"@koi/governance-approval-tiers": "workspace:*",` in alphabetical order.

- [ ] **Step 2: Add tsconfig reference (if the project uses project refs)**

Open `packages/meta/runtime/tsconfig.json`. If it contains a `references` array, append:

```json
{ "path": "../../security/governance-approval-tiers" }
```

If there is no `references` array, skip this step.

- [ ] **Step 3: Install**

```
bun install
```

- [ ] **Step 4: Check orphans**

```
bun run check:orphans
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json bun.lock
git commit -m "chore(runtime): add @koi/governance-approval-tiers dep

Satisfies check:orphans and enables the golden-query wiring that
lands next."
```

---

## Task 14: Add standalone golden queries

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Append standalone test cases**

Open `packages/meta/runtime/src/__tests__/golden-replay.test.ts`. Append:

```typescript
describe("Golden: @koi/governance-approval-tiers", () => {
  it("short-circuits ask to allow on persisted match", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const {
      createJsonlApprovalStore,
      wrapBackendWithPersistedAllowlist,
    } = await import("@koi/governance-approval-tiers");
    const { askId } = await import("@koi/core/governance-backend");
    const { computeGrantKey } = await import("@koi/hash");

    const dir = await mkdtemp(join(tmpdir(), "golden-appt-"));
    try {
      const path = join(dir, "approvals.json");
      const payload = { tool: "bash" };
      const store = createJsonlApprovalStore({ path });
      await store.append({
        kind: "tool_call",
        payload,
        grantKey: computeGrantKey("tool_call", payload),
        grantedAt: 1,
      });
      const wrapped = wrapBackendWithPersistedAllowlist(
        {
          evaluator: {
            evaluate: () => ({ ok: "ask", prompt: "?", askId: askId("g1") }),
          },
        },
        store,
      );
      const v = await wrapped.evaluator.evaluate({
        kind: "tool_call",
        agentId: "a" as never,
        payload,
        timestamp: 0,
      });
      expect(v.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves ask unchanged with no persisted match", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const {
      createJsonlApprovalStore,
      wrapBackendWithPersistedAllowlist,
    } = await import("@koi/governance-approval-tiers");
    const { askId } = await import("@koi/core/governance-backend");

    const dir = await mkdtemp(join(tmpdir(), "golden-appt-"));
    try {
      const path = join(dir, "approvals.json");
      const store = createJsonlApprovalStore({ path });
      const wrapped = wrapBackendWithPersistedAllowlist(
        {
          evaluator: {
            evaluate: () => ({ ok: "ask", prompt: "?", askId: askId("g2") }),
          },
        },
        store,
      );
      const v = await wrapped.evaluator.evaluate({
        kind: "tool_call",
        agentId: "a" as never,
        payload: { tool: "bash" },
        timestamp: 0,
      });
      expect(v.ok).toBe("ask");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the golden-replay suite**

```
bun run test --filter=@koi/runtime
```

Expected: PASS (both new cases plus all existing ones).

- [ ] **Step 3: Check golden queries**

```
bun run check:golden-queries
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/meta/runtime/src/__tests__/golden-replay.test.ts
git commit -m "test(runtime): golden queries for governance-approval-tiers

Two standalone replay tests covering persisted-match short-circuit
and passthrough. Satisfies check:golden-queries gate."
```

---

## Task 15: Full CI gate + PR prep

**Files:** none

- [ ] **Step 1: Run the full gate suite**

```
bun run test
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
bun run check:orphans
bun run check:golden-queries
```

Expected: every step exits 0.

- [ ] **Step 2: If any gate fails, fix and commit. Never merge a failing gate.**

- [ ] **Step 3: Review diff size**

```
git log main..HEAD --stat
```

Expected: < 1,500 LOC of logic changes (per CLAUDE.md PR rule). Current target ~430 LOC of src + ~110 LOC of tests + ~50 LOC of doc — well under.

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat(governance-approval-tiers): persistent approval allowlist (gov-12)" --body "$(cat <<'EOF'
## Summary
- Adds `@koi/governance-approval-tiers` L2 package: JSON-lines store, backend wrapper, onApprovalPersist sink, onViolation delta-audit adapter, pattern-key aliasing.
- Promotes `PersistentGrant` to `@koi/core` (L0) and `computeGrantKey` to `@koi/hash` (L0u) so gov-12 can consume them without a peer-L2 dep.
- Wires the package into `@koi/runtime` with two standalone golden queries.

Closes #1879. Sub-issue of #1208.

## Test plan
- [x] `bun run test` — all packages
- [x] `bun run typecheck`
- [x] `bun run lint`
- [x] `bun run check:layers`
- [x] `bun run check:orphans`
- [x] `bun run check:golden-queries`
- [x] `bun run check:unused`
- [x] `bun run check:duplicates`
EOF
)"
```

---

## Self-Review

**1. Spec coverage.** Issue #1879 asks for:
- `ApprovalScope = "once" | "session" | "always"` — Task 5 (types.ts) ✓
- `createTieredApprovalStore(persistence)` → renamed to `createJsonlApprovalStore` since gov-11 already owns the session cache. Task 7 ✓
- 3-level lookup chain. Level 1 (session cache) is already in gov-11; Level 2 (persistent allowlist) in Task 8 (wrapper); Level 3 (fall-through to ask) happens automatically when wrapper finds no match ✓
- `recordApproval`: `"once"` no-op (gov-11 already handles), `"session"` cached (gov-11), `"always"` persisted (Task 9 `createPersistSink`) ✓
- `matchApproval(query)` — Task 7 (store.match) ✓
- Pattern-key aliasing — Tasks 5 + 6 (AliasSpec + applyAliases) + Task 7 (store uses aliases on match) ✓
- Persistence at `~/.koi/approvals.json` — Task 7 default path + doc ✓
- JSON-lines append-only, never overwrites — Task 7 ✓
- Delta audit via `onViolation` — Task 10 ✓
- Tests required: tier precedence ✓ (Task 8), session cleared (already gov-11), `always` persists across process ✓ (Task 7 "persists across store instances"), pattern aliasing ✓ (Task 7), append-only ✓ (Task 7 "appends one grant per line" + concurrent append preserves count).

**2. Placeholder scan.** No TBDs, no "implement later", no "similar to Task N". Every code block is complete.

**3. Type consistency.** `ApprovalStore` surface (`append`, `match`, `load`) used identically across Tasks 5, 7, 8, 9, 10. `PersistedApproval` shape consistent. `PersistentGrant` imported from `@koi/core` everywhere (Tasks 9, 10) after the Task 1 promotion.

Ready for execution.
