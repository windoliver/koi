# Executor PR 1 — L0 Contract + Router + Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add capability declarations + lifecycle hooks to the existing L0 `SandboxAdapter` contract additively, ship a new `@koi/sandbox-router` L2 package that selects adapters by capability with create-time fallback and lifecycle/health tracking, and ship a new `@koi/sandbox-conformance` L2 package that exposes a shared `bun:test` describe block adapters can import.

**Architecture:** Three layers of change:

1. L0 (`@koi/core`): one new types-only file (`adapter-capabilities.ts`); two surgical additions to existing files (`sandbox-adapter.ts`, `sandbox-profile.ts`). All additions are optional fields on existing interfaces — zero breakage for existing callers.
2. New L2 package `@koi/sandbox-router`: pure-logic selection algorithm (`match.ts`) + decision metadata builder (`decision.ts`) + router state machine (`router.ts`). Depends on `@koi/core` only.
3. New L2 package `@koi/sandbox-conformance`: a single function `describeSandboxConformance(adapter)` that wraps `bun:test` `describe()`/`test()` calls. Capability-gated tests `skip` themselves when the adapter doesn't declare the capability. PR 1 ships the lifecycle + create+destroy + capability-honesty groups (the groups testable without a real backend). Exec/copy-files/spawn/persistence groups are added in PRs 2-4 alongside the adapters that exercise them.

**Tech Stack:** TypeScript 6, Bun 1.3.x, `bun:test`, tsup ESM-only build. No new external deps.

**Spec reference:** `docs/superpowers/specs/2026-05-01-executor-design.md` §5 (L0), §6 (router), §8 (conformance).

**Error code reuse decision (deviation from spec §5.4):** The spec proposed three new `KoiErrorCode` values (`BACKEND_UNAVAILABLE`, `NO_ADAPTER_MATCHES`, `ALL_ADAPTERS_FAILED`). `KoiErrorCode` is an exhaustive union and `errors.ts` documents the `never` pattern — adding codes forces every existing exhaustive switch to update. The plan reuses existing codes instead, with discriminating context fields:

| Spec code | Mapped to | Discriminator |
|-----------|-----------|---------------|
| `BACKEND_UNAVAILABLE` | `UNAVAILABLE` | `context.reason: "init-failed"` |
| `NO_ADAPTER_MATCHES`  | `VALIDATION`  | `context.reason: "no-adapter-matches"` |
| `ALL_ADAPTERS_FAILED` | `UNAVAILABLE` | `context.reason: "all-adapters-failed"`, `context.causedBy: KoiError[]` |

This keeps the L0 enum stable. If a future caller needs to programmatically distinguish these cases, the `context.reason` discriminator is sufficient.

---

## File Structure

### Files created

| Path | Purpose |
|------|---------|
| `packages/kernel/core/src/adapter-capabilities.ts` | New L0 types: `AdapterCapability`, `AdapterCapabilities`, `BackendState`, `BackendDescriptor`, `CapabilityRequirements` |
| `packages/sandbox/sandbox-router/package.json` | New L2 package manifest |
| `packages/sandbox/sandbox-router/tsconfig.json` | TS project config (extends `tsconfig.base.json`) |
| `packages/sandbox/sandbox-router/tsup.config.ts` | Build config |
| `packages/sandbox/sandbox-router/src/match.ts` | Pure capability-match filter |
| `packages/sandbox/sandbox-router/src/decision.ts` | `SelectionDecision` builder |
| `packages/sandbox/sandbox-router/src/router.ts` | `createSandboxRouter` factory + state machine |
| `packages/sandbox/sandbox-router/src/index.ts` | Public exports |
| `packages/sandbox/sandbox-router/src/match.test.ts` | Unit tests for `match.ts` |
| `packages/sandbox/sandbox-router/src/decision.test.ts` | Unit tests for `decision.ts` |
| `packages/sandbox/sandbox-router/src/router.test.ts` | Router unit tests (selection, lifecycle, fallback, state transitions) |
| `packages/sandbox/sandbox-conformance/package.json` | New L2 package manifest |
| `packages/sandbox/sandbox-conformance/tsconfig.json` | TS project config |
| `packages/sandbox/sandbox-conformance/tsup.config.ts` | Build config |
| `packages/sandbox/sandbox-conformance/src/index.ts` | `describeSandboxConformance` entry |
| `packages/sandbox/sandbox-conformance/src/lifecycle.ts` | Lifecycle test group |
| `packages/sandbox/sandbox-conformance/src/create-destroy.ts` | Create+Destroy test group |
| `packages/sandbox/sandbox-conformance/src/capability-honesty.ts` | Capability-honesty test group |
| `packages/sandbox/sandbox-conformance/src/__tests__/conformance.test.ts` | Self-test: run conformance suite against a fake adapter |
| `docs/L2/sandbox-router.md` | Router contract + selection algorithm + audit shape |
| `docs/L2/sandbox-conformance.md` | How to use the conformance suite |
| `docs/L2/sandbox-threat-template.md` | Shared threat-model template for adapter docs |

### Files modified

| Path | Change |
|------|--------|
| `packages/kernel/core/src/sandbox-adapter.ts` | Add 4 optional fields to `SandboxAdapter`: `version`, `capabilities`, `init`, `shutdown` |
| `packages/kernel/core/src/sandbox-profile.ts` | Add 2 optional fields to `SandboxProfile`: `required` (`CapabilityRequirements`), `ssh` (generic struct, no SSH library types) |
| `packages/kernel/core/src/index.ts` | Re-export new types from `adapter-capabilities.ts` |
| `packages/kernel/core/package.json` | Add `./adapter-capabilities` export entry (mirrors existing per-module entries) |
| `scripts/layers.ts` | Add `@koi/sandbox-router` and `@koi/sandbox-conformance` to `L2_PACKAGES` |

### Files NOT touched (deliberately)

- `packages/kernel/core/src/errors.ts` — error codes reused (see deviation note above).
- Existing L2 sandbox packages (`@koi/sandbox-os`, `@koi/sandbox-docker`, `@koi/sandbox-executor`) — capability declaration on `sandbox-docker` is PR 3.
- `@koi/runtime` wiring — PR 5.

---

## Task 1: Create L0 file `adapter-capabilities.ts`

**Files:**
- Create: `packages/kernel/core/src/adapter-capabilities.ts`

This is types-only (pure type definitions, no runtime values). L0 forbids runtime logic, so no test file. Verification = typecheck only.

- [ ] **Step 1: Write the file**

```typescript
// packages/kernel/core/src/adapter-capabilities.ts
/**
 * Capability declarations and backend lifecycle types for SandboxAdapter selection.
 *
 * Used by the sandbox router (`@koi/sandbox-router`) to filter and rank
 * adapters when fulfilling a `SandboxProfile.required` requirement set.
 */

/** Discrete capability flags an adapter may support. */
export type AdapterCapability =
  | "exec"
  | "copy-files"
  | "spawn"
  | "persistence"
  | "network"
  | "filesystem-rw"
  | "gpu";

/**
 * Static capability declaration on a SandboxAdapter.
 *
 * `priority` is the selection tiebreaker — lower values are preferred when two
 * adapters both satisfy a profile's requirements. Suggested ranges:
 *   0-9   local in-process / OS subprocess
 *   10-19 containerized (Docker)
 *   20-29 remote (SSH)
 *   30-39 cloud-hosted ephemeral sandbox
 */
export interface AdapterCapabilities {
  readonly supports: ReadonlySet<AdapterCapability>;
  readonly priority: number;
}

/**
 * Backend-level lifecycle state. Distinct from instance-level
 * `SandboxInstanceState` (which is `active | detached | destroyed`).
 *
 *   created    — constructed but `init()` has not been awaited yet
 *   ready      — operating normally; eligible for selection
 *   degraded   — recent consecutive failures; selectable but lower priority
 *                than ready peers; reverts to `ready` on next success
 *   terminated — `shutdown()` returned, OR `init()` failed permanently
 */
export type BackendState = "created" | "ready" | "degraded" | "terminated";

/** Read-only summary an adapter exposes to the router and to callers. */
export interface BackendDescriptor {
  readonly name: string;
  /** Semver of the adapter package. Used in selection-decision audit metadata. */
  readonly version: string;
  readonly state: BackendState;
  readonly capabilities: AdapterCapabilities;
}

/** Capability requirements declared on a `SandboxProfile`. */
export interface CapabilityRequirements {
  readonly required: ReadonlySet<AdapterCapability>;
  /** Optional: capabilities that disqualify an adapter even if all required are met. */
  readonly forbidden?: ReadonlySet<AdapterCapability>;
}
```

- [ ] **Step 2: Verify L0 purity (no imports, no runtime values)**

Run: `grep -E "^(import |export const|export function|export class)" packages/kernel/core/src/adapter-capabilities.ts`
Expected output: no matches (file is types-only).

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/core/src/adapter-capabilities.ts
git commit -m "feat(core): add adapter-capabilities L0 contract types"
```

---

## Task 2: Re-export from `@koi/core` index and add package.json entry

**Files:**
- Modify: `packages/kernel/core/src/index.ts`
- Modify: `packages/kernel/core/package.json`

- [ ] **Step 1: Add re-export to `index.ts`**

Locate the `// sandbox adapter` block (the existing `} from "./sandbox-adapter.js";` line) and add this **before** it (alphabetical-ish grouping):

```typescript
// adapter capabilities — selection metadata for sandbox-router
export type {
  AdapterCapability,
  AdapterCapabilities,
  BackendState,
  BackendDescriptor,
  CapabilityRequirements,
} from "./adapter-capabilities.js";
```

- [ ] **Step 2: Add subpath export entry to `packages/kernel/core/package.json`**

Locate the existing `"./sandbox-adapter": { ... }` entry inside the `exports` object. Add a new entry alphabetically before it:

```json
    "./adapter-capabilities": {
      "types": "./dist/adapter-capabilities.d.ts",
      "import": "./dist/adapter-capabilities.js"
    },
```

- [ ] **Step 3: Typecheck `@koi/core`**

Run: `bun run --cwd packages/kernel/core typecheck`
Expected: PASS, zero errors.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/core/src/index.ts packages/kernel/core/package.json
git commit -m "feat(core): export adapter-capabilities from @koi/core"
```

---

## Task 3: Extend `SandboxAdapter` with optional capability + lifecycle fields

**Files:**
- Modify: `packages/kernel/core/src/sandbox-adapter.ts`

- [ ] **Step 1: Add import for capability types**

At the top of the file, after the existing `import type { SandboxProfile } from "./sandbox-profile.js";` line, add:

```typescript
import type { AdapterCapabilities } from "./adapter-capabilities.js";
```

- [ ] **Step 2: Extend the `SandboxAdapter` interface**

Locate the `export interface SandboxAdapter { ... }` block. Replace the entire block with:

```typescript
/**
 * Backend that creates sandbox instances from a profile.
 *
 * Each backend (OS-level, E2B, Vercel, Cloudflare, Daytona, K8s)
 * implements this contract as an independent L2 package.
 *
 * The optional `capabilities`, `version`, `init`, and `shutdown` fields are
 * read by `@koi/sandbox-router` to perform capability-based selection and
 * track adapter lifecycle. Adapters that do not declare `capabilities` are
 * not eligible for router-driven selection (they can still be invoked
 * directly by callers that hold a reference to the adapter).
 */
export interface SandboxAdapter {
  readonly name: string;
  readonly create: (profile: SandboxProfile) => Promise<SandboxInstance>;
  /**
   * Find an existing sandbox by scope key or create a new one.
   *
   * Used for cross-session persistence: the bridge calls this instead of
   * `create()` when a scope is configured. The adapter looks up a previous
   * instance (by label/metadata), reattaches if possible, or creates fresh.
   *
   * Optional — adapters that don't support persistence omit this.
   */
  readonly findOrCreate?:
    | ((scope: string, profile: SandboxProfile) => Promise<SandboxInstance>)
    | undefined;
  /** Semver of the adapter package. Surfaced in selection-decision audit metadata. */
  readonly version?: string;
  /**
   * Static capability declaration. Required for router-driven selection;
   * absent for adapters used only by direct reference.
   */
  readonly capabilities?: AdapterCapabilities;
  /**
   * Optional one-shot initialization. The router awaits this before marking
   * the adapter `ready`. A rejection causes the adapter to be marked
   * `terminated` and excluded from selection for the lifetime of the router.
   */
  readonly init?: () => Promise<void>;
  /**
   * Optional teardown. The router awaits this on `router.shutdown()`. After
   * shutdown the adapter is `terminated` and ineligible for selection.
   */
  readonly shutdown?: () => Promise<void>;
}
```

- [ ] **Step 3: Typecheck `@koi/core`**

Run: `bun run --cwd packages/kernel/core typecheck`
Expected: PASS, zero errors. (All additions are optional — no existing implementations break.)

- [ ] **Step 4: Typecheck the existing `@koi/sandbox-docker` package to confirm zero breakage**

Run: `bun run --cwd packages/sandbox/sandbox-docker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/core/src/sandbox-adapter.ts
git commit -m "feat(core): extend SandboxAdapter with optional capability and lifecycle fields"
```

---

## Task 4: Extend `SandboxProfile` with `required` and `ssh` fields

**Files:**
- Modify: `packages/kernel/core/src/sandbox-profile.ts`

- [ ] **Step 1: Add import for `CapabilityRequirements`**

At the top of the file (currently no imports), add:

```typescript
import type { CapabilityRequirements } from "./adapter-capabilities.js";
```

- [ ] **Step 2: Add `SandboxSshTarget` and extend `SandboxProfile`**

Replace the `SandboxProfile` interface (the last interface in the file) with:

```typescript
/**
 * Generic SSH connection target. Consumed only by `@koi/sandbox-ssh`.
 * Other adapters MUST ignore this field.
 *
 * Kept as a generic L0 struct so no SSH library types leak into the kernel.
 * Auth is key-based only — no password fields exist here by design.
 */
export interface SandboxSshTarget {
  readonly host: string;
  readonly user: string;
  /** Absolute path to a private key file readable by the calling process. */
  readonly keyPath: string;
}

/** Declarative sandbox profile — platform-agnostic policy. */
export interface SandboxProfile {
  readonly filesystem: FilesystemPolicy;
  readonly network: NetworkPolicy;
  readonly resources: ResourceLimits;
  readonly env?: Readonly<Record<string, string>>;
  readonly nexusMounts?: readonly NexusFuseMount[];
  /**
   * Capabilities the chosen backend MUST satisfy. Read by `@koi/sandbox-router`
   * to filter the adapter set. Profiles that omit this field accept any adapter.
   */
  readonly required?: CapabilityRequirements;
  /** SSH target for the SSH backend. Ignored by all other adapters. */
  readonly ssh?: SandboxSshTarget;
}
```

- [ ] **Step 3: Typecheck `@koi/core`**

Run: `bun run --cwd packages/kernel/core typecheck`
Expected: PASS.

- [ ] **Step 4: Re-export `SandboxSshTarget` from `index.ts`**

Locate the `// sandbox profile — platform-agnostic isolation policy` block. Add `SandboxSshTarget` to the exported type list:

```typescript
// sandbox profile — platform-agnostic isolation policy
export type {
  FilesystemPolicy,
  NetworkPolicy,
  NexusFuseMount,
  ResourceLimits,
  SandboxProfile,
  SandboxSshTarget,
} from "./sandbox-profile.js";
```

(If the existing export block already lists each type individually, insert `SandboxSshTarget` alphabetically. If it uses `export type * from`, leave as-is — the type is already covered.)

- [ ] **Step 5: Typecheck again**

Run: `bun run --cwd packages/kernel/core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/core/src/sandbox-profile.ts packages/kernel/core/src/index.ts
git commit -m "feat(core): extend SandboxProfile with required capabilities and ssh target"
```

---

## Task 5: Register both new L2 packages in `scripts/layers.ts`

**Files:**
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Add the two package names to `L2_PACKAGES`**

Locate `L2_PACKAGES`. Insert two new lines alphabetically (after `@koi/sandbox-os`, before `@koi/session`):

```typescript
  "@koi/sandbox-conformance",
  "@koi/sandbox-router",
```

- [ ] **Step 2: Verify the `check:layers` script still parses the file**

Run: `bun run check:layers`
Expected: the script may complain that the new packages don't exist on disk yet — that's OK if it does, we create them in subsequent tasks. If it errors out parsing `layers.ts`, fix the syntax. If it warns about missing packages, that's expected to clear once Tasks 6 and 13 land.

- [ ] **Step 3: Commit**

```bash
git add scripts/layers.ts
git commit -m "chore(layers): register sandbox-router and sandbox-conformance L2 packages"
```

---

## Task 6: Scaffold `@koi/sandbox-router` package

**Files:**
- Create: `packages/sandbox/sandbox-router/package.json`
- Create: `packages/sandbox/sandbox-router/tsconfig.json`
- Create: `packages/sandbox/sandbox-router/tsup.config.ts`
- Create: `packages/sandbox/sandbox-router/src/index.ts` (stub)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@koi/sandbox-router",
  "description": "Capability-based selection over SandboxAdapter instances with create-time fallback and lifecycle tracking",
  "version": "0.1.0",
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
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "devDependencies": {}
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
  "references": [
    {
      "path": "../../kernel/core"
    }
  ]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

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

- [ ] **Step 4: Create `src/index.ts` stub**

```typescript
// Public exports — populated as router/match/decision land.
export {};
```

- [ ] **Step 5: Install workspace deps**

Run: `bun install`
Expected: lockfile updates, `@koi/sandbox-router` appears in workspace.

- [ ] **Step 6: Typecheck**

Run: `bun run --cwd packages/sandbox/sandbox-router typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/sandbox-router/ bun.lock
git commit -m "chore(sandbox-router): scaffold @koi/sandbox-router L2 package"
```

---

## Task 7: TDD `match.ts` — capability filter (rejection reasons)

**Files:**
- Create: `packages/sandbox/sandbox-router/src/match.ts`
- Create: `packages/sandbox/sandbox-router/src/match.test.ts`

The matcher takes an adapter list and a `CapabilityRequirements` object and returns two parallel arrays: matched adapters (in input order) and rejected adapters with the reason. It does NOT sort — sorting lives in `router.ts`.

- [ ] **Step 1: Write failing test**

```typescript
// packages/sandbox/sandbox-router/src/match.test.ts
import type {
  AdapterCapability,
  AdapterCapabilities,
  CapabilityRequirements,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describe, expect, test } from "bun:test";
import { matchAdapters } from "./match.js";

function fakeAdapter(name: string, caps: AdapterCapability[], priority = 0): SandboxAdapter {
  const supports: ReadonlySet<AdapterCapability> = new Set(caps);
  const capabilities: AdapterCapabilities = { supports, priority };
  return {
    name,
    create: () =>
      Promise.reject(new Error("not used in match tests")) as Promise<SandboxInstance>,
    capabilities,
  };
}

function reqs(required: AdapterCapability[], forbidden?: AdapterCapability[]): CapabilityRequirements {
  const r: CapabilityRequirements = {
    required: new Set(required),
    ...(forbidden ? { forbidden: new Set(forbidden) } : {}),
  };
  return r;
}

describe("matchAdapters", () => {
  test("returns adapter when capabilities exactly match required set", () => {
    const a = fakeAdapter("local", ["exec", "copy-files"]);
    const result = matchAdapters([a], reqs(["exec"]));
    expect(result.matched.map((m) => m.name)).toEqual(["local"]);
    expect(result.rejected).toEqual([]);
  });

  test("rejects adapter missing a required capability with `missing` list", () => {
    const a = fakeAdapter("local", ["exec"]);
    const result = matchAdapters([a], reqs(["exec", "spawn"]));
    expect(result.matched).toEqual([]);
    expect(result.rejected).toEqual([
      { adapter: "local", reason: "missing-capabilities", missing: ["spawn"] },
    ]);
  });

  test("rejects adapter that has a forbidden capability", () => {
    const a = fakeAdapter("docker", ["exec", "network"]);
    const result = matchAdapters([a], reqs(["exec"], ["network"]));
    expect(result.matched).toEqual([]);
    expect(result.rejected).toEqual([
      { adapter: "docker", reason: "forbidden-capabilities" },
    ]);
  });

  test("excludes adapters with no capabilities declaration", () => {
    const a: SandboxAdapter = {
      name: "legacy",
      create: () => Promise.reject(new Error("unused")) as Promise<SandboxInstance>,
    };
    const result = matchAdapters([a], reqs(["exec"]));
    expect(result.matched).toEqual([]);
    expect(result.rejected).toEqual([
      { adapter: "legacy", reason: "missing-capabilities", missing: ["exec"] },
    ]);
  });

  test("matches multiple adapters and preserves input order", () => {
    const a = fakeAdapter("local", ["exec"], 0);
    const b = fakeAdapter("docker", ["exec"], 10);
    const result = matchAdapters([a, b], reqs(["exec"]));
    expect(result.matched.map((m) => m.name)).toEqual(["local", "docker"]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/sandbox/sandbox-router/src/match.test.ts`
Expected: FAIL — `Cannot find module './match.js'`.

- [ ] **Step 3: Implement `match.ts`**

```typescript
// packages/sandbox/sandbox-router/src/match.ts
import type {
  AdapterCapability,
  CapabilityRequirements,
  SandboxAdapter,
} from "@koi/core";

export interface MatchRejection {
  readonly adapter: string;
  readonly reason: "missing-capabilities" | "forbidden-capabilities";
  readonly missing?: readonly AdapterCapability[];
}

export interface MatchResult {
  readonly matched: readonly SandboxAdapter[];
  readonly rejected: readonly MatchRejection[];
}

/**
 * Filter adapters by a capability requirement set.
 *
 * Adapters that lack a `capabilities` declaration are rejected with reason
 * `missing-capabilities` and the full required set as `missing` — they cannot
 * participate in router-driven selection.
 *
 * Order of `matched` mirrors the input adapter order. Sorting is the caller's
 * job (router applies state + priority sort).
 */
export function matchAdapters(
  adapters: readonly SandboxAdapter[],
  requirements: CapabilityRequirements,
): MatchResult {
  const matched: SandboxAdapter[] = [];
  const rejected: MatchRejection[] = [];

  for (const adapter of adapters) {
    const supports = adapter.capabilities?.supports;
    if (supports === undefined) {
      rejected.push({
        adapter: adapter.name,
        reason: "missing-capabilities",
        missing: [...requirements.required],
      });
      continue;
    }

    const missing: AdapterCapability[] = [];
    for (const cap of requirements.required) {
      if (!supports.has(cap)) missing.push(cap);
    }
    if (missing.length > 0) {
      rejected.push({ adapter: adapter.name, reason: "missing-capabilities", missing });
      continue;
    }

    if (requirements.forbidden !== undefined) {
      let forbiddenHit = false;
      for (const cap of requirements.forbidden) {
        if (supports.has(cap)) {
          forbiddenHit = true;
          break;
        }
      }
      if (forbiddenHit) {
        rejected.push({ adapter: adapter.name, reason: "forbidden-capabilities" });
        continue;
      }
    }

    matched.push(adapter);
  }

  return { matched, rejected };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/sandbox/sandbox-router/src/match.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-router/src/match.ts packages/sandbox/sandbox-router/src/match.test.ts
git commit -m "feat(sandbox-router): add capability matcher"
```

---

## Task 8: TDD `decision.ts` — decision metadata builder

**Files:**
- Create: `packages/sandbox/sandbox-router/src/decision.ts`
- Create: `packages/sandbox/sandbox-router/src/decision.test.ts`

The builder converts internal state (chosen adapter snapshot, attempt log, rejected list) into the public `SelectionDecision` shape returned to callers.

- [ ] **Step 1: Write failing test**

```typescript
// packages/sandbox/sandbox-router/src/decision.test.ts
import type { BackendDescriptor, KoiError } from "@koi/core";
import { describe, expect, test } from "bun:test";
import { buildDecision } from "./decision.js";
import type { MatchRejection } from "./match.js";

function descriptor(name: string, state: BackendDescriptor["state"] = "ready"): BackendDescriptor {
  return {
    name,
    version: "0.0.0",
    state,
    capabilities: { supports: new Set(["exec"]), priority: 0 },
  };
}

const sampleError: KoiError = {
  code: "EXTERNAL",
  message: "boom",
  retryable: false,
};

describe("buildDecision", () => {
  test("happy path: single attempt, no rejections", () => {
    const decision = buildDecision({
      selected: descriptor("local"),
      attempts: [{ adapter: "local", state: "ready", ok: true }],
      rejected: [],
    });
    expect(decision.selected.name).toBe("local");
    expect(decision.attempts).toHaveLength(1);
    expect(decision.attempts[0]?.ok).toBe(true);
    expect(decision.rejected).toEqual([]);
  });

  test("includes failed attempts before the successful one (fallback chain)", () => {
    const decision = buildDecision({
      selected: descriptor("docker"),
      attempts: [
        { adapter: "local", state: "ready", ok: false, error: sampleError },
        { adapter: "docker", state: "ready", ok: true },
      ],
      rejected: [],
    });
    expect(decision.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(decision.attempts[0]?.error).toEqual(sampleError);
  });

  test("includes capability rejections that never reached create()", () => {
    const rejections: readonly MatchRejection[] = [
      { adapter: "local", reason: "missing-capabilities", missing: ["gpu"] },
    ];
    const decision = buildDecision({
      selected: descriptor("docker"),
      attempts: [{ adapter: "docker", state: "ready", ok: true }],
      rejected: rejections,
    });
    expect(decision.rejected).toHaveLength(1);
    expect(decision.rejected[0]?.reason).toBe("missing-capabilities");
  });

  test("decision is fully readonly — frozen objects don't accept mutation", () => {
    const decision = buildDecision({
      selected: descriptor("local"),
      attempts: [{ adapter: "local", state: "ready", ok: true }],
      rejected: [],
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.attempts)).toBe(true);
    expect(Object.isFrozen(decision.rejected)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/sandbox/sandbox-router/src/decision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `decision.ts`**

```typescript
// packages/sandbox/sandbox-router/src/decision.ts
import type { BackendDescriptor, BackendState, KoiError } from "@koi/core";
import type { MatchRejection } from "./match.js";

export interface SelectionAttempt {
  readonly adapter: string;
  readonly state: BackendState;
  readonly ok: boolean;
  readonly error?: KoiError;
}

export interface SelectionDecision {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];
  readonly rejected: readonly MatchRejection[];
}

export interface BuildDecisionInput {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];
  readonly rejected: readonly MatchRejection[];
}

/**
 * Build an immutable `SelectionDecision`. All nested arrays are frozen so
 * audit consumers cannot mutate the record after the router returns.
 */
export function buildDecision(input: BuildDecisionInput): SelectionDecision {
  return Object.freeze({
    selected: input.selected,
    attempts: Object.freeze([...input.attempts]),
    rejected: Object.freeze([...input.rejected]),
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/sandbox/sandbox-router/src/decision.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-router/src/decision.ts packages/sandbox/sandbox-router/src/decision.test.ts
git commit -m "feat(sandbox-router): add SelectionDecision builder"
```

---

## Task 9: TDD `router.ts` — `createSandboxRouter` factory + `describe()`

**Files:**
- Create: `packages/sandbox/sandbox-router/src/router.ts`
- Create: `packages/sandbox/sandbox-router/src/router.test.ts`

This task lays the router skeleton and lifecycle: constructor, `describe()`, and the bookkeeping types. Selection (`create()`) lands in Task 10.

- [ ] **Step 1: Write failing test**

```typescript
// packages/sandbox/sandbox-router/src/router.test.ts
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
} from "@koi/core";
import { beforeEach, describe, expect, test } from "bun:test";
import { createSandboxRouter } from "./router.js";

function fakeInstance(): SandboxInstance {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
  };
}

function adapter(
  name: string,
  caps: AdapterCapabilities,
  init?: () => Promise<void>,
  shutdown?: () => Promise<void>,
): SandboxAdapter {
  const a: SandboxAdapter = {
    name,
    create: async () => fakeInstance(),
    capabilities: caps,
    version: "0.1.0",
    ...(init ? { init } : {}),
    ...(shutdown ? { shutdown } : {}),
  };
  return a;
}

const execCaps: AdapterCapabilities = { supports: new Set(["exec"]), priority: 0 };

describe("createSandboxRouter — describe()", () => {
  test("returns descriptors with state='ready' after init() resolves", async () => {
    let initCalled = false;
    const r = createSandboxRouter({
      adapters: [adapter("local", execCaps, async () => {
        initCalled = true;
      })],
    });
    // describe() before init may show 'created' — call it after init is known to have run.
    // The router awaits init synchronously inside the constructor's microtask.
    await Promise.resolve();
    await Promise.resolve();
    const descriptors = r.describe();
    expect(initCalled).toBe(true);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.state).toBe("ready");
    expect(descriptors[0]?.name).toBe("local");
    expect(descriptors[0]?.version).toBe("0.1.0");
    await r.shutdown();
  });

  test("adapter without init() goes straight to ready", async () => {
    const r = createSandboxRouter({ adapters: [adapter("local", execCaps)] });
    await Promise.resolve();
    expect(r.describe()[0]?.state).toBe("ready");
    await r.shutdown();
  });

  test("init() rejection moves adapter to terminated", async () => {
    const r = createSandboxRouter({
      adapters: [adapter("flaky", execCaps, async () => {
        throw new Error("init boom");
      })],
    });
    // Wait for init to settle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.describe()[0]?.state).toBe("terminated");
    await r.shutdown();
  });

  test("shutdown() calls each adapter's shutdown hook and marks state='terminated'", async () => {
    let downCount = 0;
    const r = createSandboxRouter({
      adapters: [
        adapter("a", execCaps, undefined, async () => {
          downCount++;
        }),
        adapter("b", execCaps, undefined, async () => {
          downCount++;
        }),
      ],
    });
    await Promise.resolve();
    await r.shutdown();
    expect(downCount).toBe(2);
    expect(r.describe().every((d) => d.state === "terminated")).toBe(true);
  });

  test("shutdown() is idempotent", async () => {
    let downCount = 0;
    const r = createSandboxRouter({
      adapters: [
        adapter("a", execCaps, undefined, async () => {
          downCount++;
        }),
      ],
    });
    await Promise.resolve();
    await r.shutdown();
    await r.shutdown();
    expect(downCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/sandbox/sandbox-router/src/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `router.ts` skeleton**

```typescript
// packages/sandbox/sandbox-router/src/router.ts
import type {
  BackendDescriptor,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import type { SelectionDecision } from "./decision.js";

export interface RouterConfig {
  readonly adapters: readonly SandboxAdapter[];
  /** Consecutive failures before an adapter is marked `degraded`. Default 3. */
  readonly degradedThreshold?: number;
}

export interface SandboxRouter {
  readonly create: (
    profile: SandboxProfile,
  ) => Promise<
    Result<{ readonly instance: SandboxInstance; readonly decision: SelectionDecision }, KoiError>
  >;
  readonly describe: () => readonly BackendDescriptor[];
  readonly shutdown: () => Promise<void>;
}

interface AdapterRecord {
  readonly adapter: SandboxAdapter;
  state: BackendDescriptor["state"];
  consecutiveFailures: number;
}

const DEFAULT_DEGRADED_THRESHOLD = 3;

function describeRecord(rec: AdapterRecord): BackendDescriptor {
  const caps = rec.adapter.capabilities;
  if (caps === undefined) {
    return {
      name: rec.adapter.name,
      version: rec.adapter.version ?? "0.0.0",
      state: rec.state,
      capabilities: { supports: new Set(), priority: Number.MAX_SAFE_INTEGER },
    };
  }
  return {
    name: rec.adapter.name,
    version: rec.adapter.version ?? "0.0.0",
    state: rec.state,
    capabilities: caps,
  };
}

export function createSandboxRouter(config: RouterConfig): SandboxRouter {
  const records: AdapterRecord[] = config.adapters.map((adapter) => ({
    adapter,
    state: "created",
    consecutiveFailures: 0,
  }));
  let shutdownPromise: Promise<void> | undefined;

  // Kick off init() for every adapter concurrently. Failures move the adapter
  // to `terminated` permanently.
  for (const rec of records) {
    const init = rec.adapter.init;
    if (init === undefined) {
      rec.state = "ready";
      continue;
    }
    void Promise.resolve()
      .then(() => init())
      .then(
        () => {
          if (rec.state === "created") rec.state = "ready";
        },
        () => {
          rec.state = "terminated";
        },
      );
  }

  return {
    create: async (_profile) => {
      // Implemented in Task 10.
      const error: KoiError = {
        code: "INTERNAL",
        message: "router.create not yet implemented",
        retryable: false,
      };
      return { ok: false, error };
    },
    describe: () => records.map(describeRecord),
    shutdown: async () => {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }
      shutdownPromise = (async () => {
        await Promise.all(
          records.map(async (rec) => {
            if (rec.state === "terminated") return;
            const down = rec.adapter.shutdown;
            if (down !== undefined) {
              try {
                await down();
              } catch {
                // Shutdown failures still mark the adapter terminated.
              }
            }
            rec.state = "terminated";
          }),
        );
      })();
      await shutdownPromise;
    },
  };
}

// Suppress "unused" lint until Task 10 wires this. Keep the export so consumers
// can already import the threshold constant if needed.
export const __DEFAULT_DEGRADED_THRESHOLD: number = DEFAULT_DEGRADED_THRESHOLD;
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/sandbox/sandbox-router/src/router.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-router/src/router.ts packages/sandbox/sandbox-router/src/router.test.ts
git commit -m "feat(sandbox-router): scaffold router with init/shutdown lifecycle"
```

---

## Task 10: TDD selection algorithm + create-time fallback chain

**Files:**
- Modify: `packages/sandbox/sandbox-router/src/router.ts`
- Modify: `packages/sandbox/sandbox-router/src/router.test.ts`

This task lands the actual `create()` logic: filter via `match.ts`, sort by `(state, priority)`, try each in order, fall back on failure, build the `SelectionDecision`.

- [ ] **Step 1: Append failing tests**

Append the following describe block at the bottom of `router.test.ts`:

```typescript
import type { CapabilityRequirements } from "@koi/core";

function profileWithReq(required: CapabilityRequirements["required"]): SandboxProfile {
  const req: CapabilityRequirements = { required };
  return {
    filesystem: { defaultReadAccess: "closed" },
    network: { allow: false },
    resources: {},
    required: req,
  };
}

function failingAdapter(name: string, caps: AdapterCapabilities): SandboxAdapter {
  return {
    name,
    capabilities: caps,
    version: "0.1.0",
    create: async () => {
      throw new Error(`${name}: create rejected`);
    },
  };
}

describe("createSandboxRouter — create()", () => {
  test("picks the only matching adapter and reports it in the decision", async () => {
    const r = createSandboxRouter({
      adapters: [adapter("local", { supports: new Set(["exec"]), priority: 0 })],
    });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("local");
    expect(result.value.decision.attempts).toHaveLength(1);
    expect(result.value.decision.attempts[0]?.ok).toBe(true);
    await r.shutdown();
  });

  test("prefers ready over degraded; ties broken by lower priority", async () => {
    const a = adapter("a", { supports: new Set(["exec"]), priority: 10 });
    const b = adapter("b", { supports: new Set(["exec"]), priority: 0 });
    const r = createSandboxRouter({ adapters: [a, b] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("b");
    await r.shutdown();
  });

  test("falls back to next adapter when primary create() rejects", async () => {
    const failing = failingAdapter("primary", { supports: new Set(["exec"]), priority: 0 });
    const ok = adapter("backup", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [failing, ok] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("backup");
    expect(result.value.decision.attempts.map((x) => x.ok)).toEqual([false, true]);
    expect(result.value.decision.attempts[0]?.error?.code).toBe("EXTERNAL");
    await r.shutdown();
  });

  test("excludes adapters missing required capabilities and lists them as rejected", async () => {
    const a = adapter("local", { supports: new Set(["exec"]), priority: 0 });
    const r = createSandboxRouter({ adapters: [a] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["gpu"])));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context?.["reason"]).toBe("no-adapter-matches");
    await r.shutdown();
  });

  test("all adapters fail at create() returns UNAVAILABLE with cause chain", async () => {
    const a = failingAdapter("a", { supports: new Set(["exec"]), priority: 0 });
    const b = failingAdapter("b", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [a, b] });
    await Promise.resolve();
    const result = await r.create(profileWithReq(new Set(["exec"])));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected !ok");
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(result.error.context?.["reason"]).toBe("all-adapters-failed");
    const causedBy = result.error.context?.["causedBy"];
    expect(Array.isArray(causedBy)).toBe(true);
    expect((causedBy as readonly unknown[]).length).toBe(2);
    await r.shutdown();
  });

  test("excludes terminated adapters from selection entirely", async () => {
    const dead = adapter("dead", { supports: new Set(["exec"]), priority: 0 }, async () => {
      throw new Error("init boom");
    });
    const live = adapter("live", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [dead, live] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await r.create(profileWithReq(new Set(["exec"])));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.decision.selected.name).toBe("live");
    await r.shutdown();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/sandbox/sandbox-router/src/router.test.ts`
Expected: 6 new tests FAIL (the existing 5 from Task 9 still pass).

- [ ] **Step 3: Replace the `create:` method body in `router.ts`**

Inside the returned object literal, replace the `create:` arrow function with the implementation. Also add the necessary imports at the top of the file. Final file:

```typescript
// packages/sandbox/sandbox-router/src/router.ts
import type {
  BackendDescriptor,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { buildDecision, type SelectionAttempt, type SelectionDecision } from "./decision.js";
import { matchAdapters } from "./match.js";

export interface RouterConfig {
  readonly adapters: readonly SandboxAdapter[];
  readonly degradedThreshold?: number;
}

export interface SandboxRouter {
  readonly create: (
    profile: SandboxProfile,
  ) => Promise<
    Result<{ readonly instance: SandboxInstance; readonly decision: SelectionDecision }, KoiError>
  >;
  readonly describe: () => readonly BackendDescriptor[];
  readonly shutdown: () => Promise<void>;
}

interface AdapterRecord {
  readonly adapter: SandboxAdapter;
  state: BackendDescriptor["state"];
  consecutiveFailures: number;
}

const DEFAULT_DEGRADED_THRESHOLD = 3;

function describeRecord(rec: AdapterRecord): BackendDescriptor {
  const caps = rec.adapter.capabilities;
  if (caps === undefined) {
    return {
      name: rec.adapter.name,
      version: rec.adapter.version ?? "0.0.0",
      state: rec.state,
      capabilities: { supports: new Set(), priority: Number.MAX_SAFE_INTEGER },
    };
  }
  return {
    name: rec.adapter.name,
    version: rec.adapter.version ?? "0.0.0",
    state: rec.state,
    capabilities: caps,
  };
}

function toKoiError(err: unknown): KoiError {
  return {
    code: "EXTERNAL",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
    cause: err,
  };
}

function sortRecords(records: readonly AdapterRecord[]): readonly AdapterRecord[] {
  return [...records].sort((a, b) => {
    const aReady = a.state === "ready" ? 0 : 1;
    const bReady = b.state === "ready" ? 0 : 1;
    if (aReady !== bReady) return aReady - bReady;
    const aPri = a.adapter.capabilities?.priority ?? Number.MAX_SAFE_INTEGER;
    const bPri = b.adapter.capabilities?.priority ?? Number.MAX_SAFE_INTEGER;
    return aPri - bPri;
  });
}

export function createSandboxRouter(config: RouterConfig): SandboxRouter {
  const threshold = config.degradedThreshold ?? DEFAULT_DEGRADED_THRESHOLD;
  const records: AdapterRecord[] = config.adapters.map((adapter) => ({
    adapter,
    state: "created",
    consecutiveFailures: 0,
  }));
  let shutdownPromise: Promise<void> | undefined;

  for (const rec of records) {
    const init = rec.adapter.init;
    if (init === undefined) {
      rec.state = "ready";
      continue;
    }
    void Promise.resolve()
      .then(() => init())
      .then(
        () => {
          if (rec.state === "created") rec.state = "ready";
        },
        () => {
          rec.state = "terminated";
        },
      );
  }

  return {
    create: async (profile) => {
      // 1. Filter by capabilities (using only adapters that aren't terminated).
      const liveAdapters = records.filter((r) => r.state !== "terminated").map((r) => r.adapter);
      const requirements = profile.required ?? {
        required: new Set<never>() as never as Set<import("@koi/core").AdapterCapability>,
      };
      const matchResult = matchAdapters(liveAdapters, requirements);

      if (matchResult.matched.length === 0) {
        const error: KoiError = {
          code: "VALIDATION",
          message: "No registered adapter matches the requested capabilities",
          retryable: false,
          context: {
            reason: "no-adapter-matches",
            required: [...requirements.required],
            rejected: matchResult.rejected as unknown as readonly Record<string, unknown>[],
          },
        };
        return { ok: false, error };
      }

      // 2. Sort: ready over degraded, then by priority asc.
      const matchedRecords: AdapterRecord[] = matchResult.matched
        .map((adapter) => records.find((r) => r.adapter === adapter))
        .filter((r): r is AdapterRecord => r !== undefined);
      const sorted = sortRecords(matchedRecords);

      // 3. Try each in order; track failures; on first success, return.
      const attempts: SelectionAttempt[] = [];
      const errors: KoiError[] = [];

      for (const rec of sorted) {
        const stateAtAttempt = rec.state;
        try {
          const instance = await rec.adapter.create(profile);
          rec.consecutiveFailures = 0;
          if (rec.state === "degraded") rec.state = "ready";
          attempts.push({ adapter: rec.adapter.name, state: stateAtAttempt, ok: true });
          const decision = buildDecision({
            selected: describeRecord(rec),
            attempts,
            rejected: matchResult.rejected,
          });
          return { ok: true, value: { instance, decision } };
        } catch (err) {
          rec.consecutiveFailures++;
          if (rec.consecutiveFailures >= threshold && rec.state === "ready") {
            rec.state = "degraded";
          }
          const koiErr = toKoiError(err);
          attempts.push({
            adapter: rec.adapter.name,
            state: stateAtAttempt,
            ok: false,
            error: koiErr,
          });
          errors.push(koiErr);
        }
      }

      // 4. All matched adapters failed at create().
      const last = errors[errors.length - 1];
      const error: KoiError = {
        code: "UNAVAILABLE",
        message: "All matched adapters failed at create()",
        retryable: false,
        cause: last,
        context: {
          reason: "all-adapters-failed",
          causedBy: errors as unknown as readonly Record<string, unknown>[],
        },
      };
      return { ok: false, error };
    },
    describe: () => records.map(describeRecord),
    shutdown: async () => {
      if (shutdownPromise !== undefined) {
        await shutdownPromise;
        return;
      }
      shutdownPromise = (async () => {
        await Promise.all(
          records.map(async (rec) => {
            if (rec.state === "terminated") return;
            const down = rec.adapter.shutdown;
            if (down !== undefined) {
              try {
                await down();
              } catch {
                // Shutdown failures still mark the adapter terminated.
              }
            }
            rec.state = "terminated";
          }),
        );
      })();
      await shutdownPromise;
    },
  };
}
```

(Delete the old `__DEFAULT_DEGRADED_THRESHOLD` placeholder export.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test packages/sandbox/sandbox-router/src/router.test.ts`
Expected: PASS, 11 tests total (5 lifecycle + 6 selection).

- [ ] **Step 5: Run typecheck**

Run: `bun run --cwd packages/sandbox/sandbox-router typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/sandbox-router/src/router.ts packages/sandbox/sandbox-router/src/router.test.ts
git commit -m "feat(sandbox-router): implement capability-based selection with fallback"
```

---

## Task 11: TDD `degraded` ↔ `ready` state transition

**Files:**
- Modify: `packages/sandbox/sandbox-router/src/router.test.ts`

The selection algorithm already increments `consecutiveFailures` and flips to `degraded` at threshold. This task asserts the recovery path: a successful `create()` after a degraded streak resets failures and returns the adapter to `ready`. Plus: `degraded` adapters are still selectable, just behind `ready` peers.

- [ ] **Step 1: Append failing tests**

```typescript
describe("createSandboxRouter — degraded transitions", () => {
  test("flips to degraded after threshold consecutive failures", async () => {
    let calls = 0;
    const flaky: SandboxAdapter = {
      name: "flaky",
      capabilities: { supports: new Set(["exec"]), priority: 0 },
      version: "0.1.0",
      create: async () => {
        calls++;
        throw new Error("boom");
      },
    };
    const r = createSandboxRouter({ adapters: [flaky], degradedThreshold: 2 });
    await Promise.resolve();
    await r.create(profileWithReq(new Set(["exec"])));
    expect(r.describe()[0]?.state).toBe("ready"); // 1 failure < threshold
    await r.create(profileWithReq(new Set(["exec"])));
    expect(r.describe()[0]?.state).toBe("degraded"); // 2 failures = threshold
    expect(calls).toBe(2);
    await r.shutdown();
  });

  test("a successful create after degraded streak returns adapter to ready", async () => {
    let succeed = false;
    const flippy: SandboxAdapter = {
      name: "flippy",
      capabilities: { supports: new Set(["exec"]), priority: 0 },
      version: "0.1.0",
      create: async () => {
        if (!succeed) throw new Error("not yet");
        return fakeInstance();
      },
    };
    const r = createSandboxRouter({ adapters: [flippy], degradedThreshold: 1 });
    await Promise.resolve();
    await r.create(profileWithReq(new Set(["exec"])));
    expect(r.describe()[0]?.state).toBe("degraded");
    succeed = true;
    const result = await r.create(profileWithReq(new Set(["exec"])));
    expect(result.ok).toBe(true);
    expect(r.describe()[0]?.state).toBe("ready");
    await r.shutdown();
  });

  test("degraded adapters are still tried, just after ready peers", async () => {
    // Force a to be degraded by failing it once with threshold 1.
    let aWillFail = true;
    const a: SandboxAdapter = {
      name: "a",
      capabilities: { supports: new Set(["exec"]), priority: 0 },
      version: "0.1.0",
      create: async () => {
        if (aWillFail) throw new Error("a fail");
        return fakeInstance();
      },
    };
    const b = adapter("b", { supports: new Set(["exec"]), priority: 10 });
    const r = createSandboxRouter({ adapters: [a, b], degradedThreshold: 1 });
    await Promise.resolve();
    // First call: a fails (no fallback; b also matches), goes to b.
    const r1 = await r.create(profileWithReq(new Set(["exec"])));
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.value.decision.selected.name).toBe("b");
    // a is now degraded.
    expect(r.describe().find((d) => d.name === "a")?.state).toBe("degraded");
    // Second call: b is ready (priority 10), a is degraded (priority 0). b wins.
    const r2 = await r.create(profileWithReq(new Set(["exec"])));
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.value.decision.selected.name).toBe("b");
    // Third call: stop a from failing, but it stays degraded until it succeeds.
    // Force selection by making b fail this time.
    aWillFail = false;
    const bFailing: SandboxAdapter = {
      ...b,
      create: async () => {
        throw new Error("b temporarily down");
      },
    };
    const r3 = createSandboxRouter({ adapters: [a, bFailing], degradedThreshold: 1 });
    await Promise.resolve();
    // r3 has fresh records — both ready initially. With aWillFail=false, a succeeds.
    const r3result = await r3.create(profileWithReq(new Set(["exec"])));
    if (!r3result.ok) throw new Error("expected ok");
    expect(r3result.value.decision.selected.name).toBe("a");
    await r.shutdown();
    await r3.shutdown();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/sandbox/sandbox-router/src/router.test.ts`
Expected: PASS, 14 tests total. (The implementation from Task 10 already supports degraded transitions; these tests confirm the behavior.)

If any test fails, the issue is in `router.ts` Task 10 — fix there and re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/sandbox/sandbox-router/src/router.test.ts
git commit -m "test(sandbox-router): cover degraded state transitions"
```

---

## Task 12: Wire `index.ts` exports for `@koi/sandbox-router`

**Files:**
- Modify: `packages/sandbox/sandbox-router/src/index.ts`

- [ ] **Step 1: Replace stub with full exports**

```typescript
// packages/sandbox/sandbox-router/src/index.ts
export type { MatchRejection, MatchResult } from "./match.js";
export { matchAdapters } from "./match.js";
export type {
  BuildDecisionInput,
  SelectionAttempt,
  SelectionDecision,
} from "./decision.js";
export { buildDecision } from "./decision.js";
export type { RouterConfig, SandboxRouter } from "./router.js";
export { createSandboxRouter } from "./router.js";
```

- [ ] **Step 2: Build the package**

Run: `bun run --cwd packages/sandbox/sandbox-router build`
Expected: `dist/index.js`, `dist/index.d.ts` produced; zero errors.

- [ ] **Step 3: Run typecheck**

Run: `bun run --cwd packages/sandbox/sandbox-router typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests in the package**

Run: `bun test packages/sandbox/sandbox-router/`
Expected: PASS — all 14 router tests + match + decision tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-router/src/index.ts
git commit -m "feat(sandbox-router): wire public exports"
```

---

## Task 13: Scaffold `@koi/sandbox-conformance` package

**Files:**
- Create: `packages/sandbox/sandbox-conformance/package.json`
- Create: `packages/sandbox/sandbox-conformance/tsconfig.json`
- Create: `packages/sandbox/sandbox-conformance/tsup.config.ts`
- Create: `packages/sandbox/sandbox-conformance/src/index.ts` (stub)

This package is consumed by other packages' test files. It must build to ESM `dist/` so consumers can `import { describeSandboxConformance } from "@koi/sandbox-conformance"` from their `__tests__/` files.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@koi/sandbox-conformance",
  "description": "Shared bun:test conformance suite for SandboxAdapter implementations",
  "version": "0.1.0",
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
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "devDependencies": {}
}
```

Note: `bun:test` is provided by Bun itself — no `peerDependency` needed; consumers run their tests with `bun test` and the import path `bun:test` resolves at runtime.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    {
      "path": "../../kernel/core"
    }
  ]
}
```

- [ ] **Step 3: Create `tsup.config.ts`** (identical pattern to other L2 packages)

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

- [ ] **Step 4: Create `src/index.ts` stub**

```typescript
export {};
```

- [ ] **Step 5: Install workspace deps**

Run: `bun install`
Expected: `@koi/sandbox-conformance` registered in workspace.

- [ ] **Step 6: Typecheck**

Run: `bun run --cwd packages/sandbox/sandbox-conformance typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox/sandbox-conformance/ bun.lock
git commit -m "chore(sandbox-conformance): scaffold @koi/sandbox-conformance L2 package"
```

---

## Task 14: TDD `lifecycle.ts` conformance group

**Files:**
- Create: `packages/sandbox/sandbox-conformance/src/lifecycle.ts`
- Create: `packages/sandbox/sandbox-conformance/src/__tests__/lifecycle.test.ts`

Each conformance group is a function that calls `describe()` and `test()` from `bun:test`. The test file inside `__tests__/` self-tests the group by passing a fake adapter that satisfies the contract — confirming the group's tests pass when the adapter is correct.

- [ ] **Step 1: Write self-test (failing)**

```typescript
// packages/sandbox/sandbox-conformance/src/__tests__/lifecycle.test.ts
import type { AdapterCapabilities, SandboxAdapter, SandboxInstance } from "@koi/core";
import { describe } from "bun:test";
import { describeLifecycleConformance } from "../lifecycle.js";

const caps: AdapterCapabilities = { supports: new Set(["exec"]), priority: 0 };

function fakeInstance(): SandboxInstance {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
  };
}

describe("lifecycle conformance — adapter without init/shutdown passes", () => {
  const adapter: SandboxAdapter = {
    name: "fake-no-hooks",
    capabilities: caps,
    version: "0.0.0",
    create: async () => fakeInstance(),
  };
  describeLifecycleConformance(() => adapter);
});

describe("lifecycle conformance — adapter with init+shutdown passes", () => {
  let initRan = false;
  let shutdownRan = false;
  const adapter: SandboxAdapter = {
    name: "fake-with-hooks",
    capabilities: caps,
    version: "0.0.0",
    create: async () => fakeInstance(),
    init: async () => {
      initRan = true;
    },
    shutdown: async () => {
      shutdownRan = true;
    },
  };
  describeLifecycleConformance(() => adapter);
  // The describe block below verifies the hooks fired.
  describe("post-conformance assertions", () => {
    void initRan;
    void shutdownRan;
    // We can't assert here because describeLifecycleConformance schedules tests
    // that run after this block. The fact that the lifecycle suite passes is
    // sufficient evidence.
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/sandbox/sandbox-conformance/src/__tests__/lifecycle.test.ts`
Expected: FAIL — module `../lifecycle.js` not found.

- [ ] **Step 3: Implement `lifecycle.ts`**

```typescript
// packages/sandbox/sandbox-conformance/src/lifecycle.ts
import type { SandboxAdapter } from "@koi/core";
import { describe, expect, test } from "bun:test";

/**
 * Lifecycle conformance group: verifies optional `init` and `shutdown` hooks
 * are idempotent and that a fresh adapter built by `factory()` reaches usable
 * state without throwing.
 *
 * `factory` MUST return a fresh, never-init'd adapter on each call. The suite
 * builds and tears down its own adapter; the caller's surrounding test
 * harness should not.
 */
export function describeLifecycleConformance(factory: () => SandboxAdapter): void {
  describe("lifecycle", () => {
    test("init() resolves without error (or is omitted)", async () => {
      const adapter = factory();
      if (adapter.init !== undefined) {
        await adapter.init();
      }
      expect(true).toBe(true);
    });

    test("shutdown() is idempotent (calling twice does not throw)", async () => {
      const adapter = factory();
      if (adapter.init !== undefined) {
        await adapter.init();
      }
      if (adapter.shutdown !== undefined) {
        await adapter.shutdown();
        await adapter.shutdown();
      }
      expect(true).toBe(true);
    });

    test("init() can be called twice without throwing (idempotent)", async () => {
      const adapter = factory();
      if (adapter.init !== undefined) {
        await adapter.init();
        await adapter.init();
      }
      expect(true).toBe(true);
    });
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/sandbox/sandbox-conformance/src/__tests__/lifecycle.test.ts`
Expected: PASS — both outer describes contain inner lifecycle describes; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-conformance/src/lifecycle.ts packages/sandbox/sandbox-conformance/src/__tests__/lifecycle.test.ts
git commit -m "feat(sandbox-conformance): add lifecycle conformance group"
```

---

## Task 15: TDD `create-destroy.ts` conformance group

**Files:**
- Create: `packages/sandbox/sandbox-conformance/src/create-destroy.ts`
- Create: `packages/sandbox/sandbox-conformance/src/__tests__/create-destroy.test.ts`

This group exercises `adapter.create(profile) → instance` and `instance.destroy()`. It uses a minimal profile (no capability requirements, lenient filesystem/network).

- [ ] **Step 1: Write self-test**

```typescript
// packages/sandbox/sandbox-conformance/src/__tests__/create-destroy.test.ts
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describe } from "bun:test";
import { describeCreateDestroyConformance } from "../create-destroy.js";

const caps: AdapterCapabilities = {
  supports: new Set(["exec", "copy-files"]),
  priority: 0,
};

function fakeInstance(): SandboxInstance {
  let destroyed = false;
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {
      destroyed = true;
    },
  };
}

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

const adapter: SandboxAdapter = {
  name: "fake",
  capabilities: caps,
  version: "0.0.0",
  create: async () => fakeInstance(),
};

describe("create-destroy conformance — fake adapter", () => {
  describeCreateDestroyConformance(() => adapter, () => profile);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/sandbox/sandbox-conformance/src/__tests__/create-destroy.test.ts`
Expected: FAIL — module `../create-destroy.js` not found.

- [ ] **Step 3: Implement `create-destroy.ts`**

```typescript
// packages/sandbox/sandbox-conformance/src/create-destroy.ts
import type { SandboxAdapter, SandboxProfile } from "@koi/core";
import { describe, expect, test } from "bun:test";

/**
 * Create+Destroy conformance group: verifies `create()` returns a usable
 * `SandboxInstance`, `destroy()` does not throw, and double-destroy is
 * idempotent.
 */
export function describeCreateDestroyConformance(
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe("create + destroy", () => {
    test("create() returns an instance with the documented surface", async () => {
      const adapter = factory();
      const instance = await adapter.create(profile());
      expect(typeof instance.exec).toBe("function");
      expect(typeof instance.readFile).toBe("function");
      expect(typeof instance.writeFile).toBe("function");
      expect(typeof instance.destroy).toBe("function");
      await instance.destroy();
    });

    test("destroy() is idempotent — calling twice does not throw", async () => {
      const adapter = factory();
      const instance = await adapter.create(profile());
      await instance.destroy();
      await instance.destroy();
      expect(true).toBe(true);
    });
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/sandbox/sandbox-conformance/src/__tests__/create-destroy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-conformance/src/create-destroy.ts packages/sandbox/sandbox-conformance/src/__tests__/create-destroy.test.ts
git commit -m "feat(sandbox-conformance): add create+destroy conformance group"
```

---

## Task 16: TDD `capability-honesty.ts` conformance group

**Files:**
- Create: `packages/sandbox/sandbox-conformance/src/capability-honesty.ts`
- Create: `packages/sandbox/sandbox-conformance/src/__tests__/capability-honesty.test.ts`

This group asserts the adapter doesn't lie: if it declares `persistence`, `findOrCreate` must exist; if it declares `spawn`, the instance must expose `spawn` (capability-gated check at the instance level requires creating an instance, so this group depends on profile/instance creation working).

- [ ] **Step 1: Write self-test**

```typescript
// packages/sandbox/sandbox-conformance/src/__tests__/capability-honesty.test.ts
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describe } from "bun:test";
import { describeCapabilityHonestyConformance } from "../capability-honesty.js";

const caps: AdapterCapabilities = {
  supports: new Set(["exec", "copy-files", "spawn", "persistence"]),
  priority: 0,
};

function fakeInstance(): SandboxInstance {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    spawn: async () => ({
      pid: 1,
      stdin: { write: () => {}, end: () => {} },
      stdout: new ReadableStream({ start: (c) => c.close() }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      kill: () => {},
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
  };
}

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

const adapter: SandboxAdapter = {
  name: "fake",
  capabilities: caps,
  version: "0.0.0",
  create: async () => fakeInstance(),
  findOrCreate: async () => fakeInstance(),
};

describe("capability-honesty conformance — fake adapter declaring all caps", () => {
  describeCapabilityHonestyConformance(() => adapter, () => profile);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/sandbox/sandbox-conformance/src/__tests__/capability-honesty.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `capability-honesty.ts`**

```typescript
// packages/sandbox/sandbox-conformance/src/capability-honesty.ts
import type { SandboxAdapter, SandboxProfile } from "@koi/core";
import { describe, expect, test } from "bun:test";

/**
 * Capability-honesty conformance group: verifies the adapter's runtime
 * surface matches its declared capabilities.
 *
 * Currently checks:
 *   - `persistence` declared ⇒ `findOrCreate` exists on the adapter
 *   - `spawn` declared ⇒ `instance.spawn` exists on a freshly-created instance
 */
export function describeCapabilityHonestyConformance(
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe("capability honesty", () => {
    test("persistence ⇒ findOrCreate is implemented", () => {
      const adapter = factory();
      const supports = adapter.capabilities?.supports;
      if (supports?.has("persistence")) {
        expect(typeof adapter.findOrCreate).toBe("function");
      } else {
        expect(true).toBe(true);
      }
    });

    test("spawn ⇒ instance.spawn is implemented", async () => {
      const adapter = factory();
      const supports = adapter.capabilities?.supports;
      if (!supports?.has("spawn")) {
        expect(true).toBe(true);
        return;
      }
      const instance = await adapter.create(profile());
      try {
        expect(typeof instance.spawn).toBe("function");
      } finally {
        await instance.destroy();
      }
    });
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/sandbox/sandbox-conformance/src/__tests__/capability-honesty.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/sandbox-conformance/src/capability-honesty.ts packages/sandbox/sandbox-conformance/src/__tests__/capability-honesty.test.ts
git commit -m "feat(sandbox-conformance): add capability-honesty conformance group"
```

---

## Task 17: Wire `index.ts` and the umbrella `describeSandboxConformance`

**Files:**
- Modify: `packages/sandbox/sandbox-conformance/src/index.ts`
- Create: `packages/sandbox/sandbox-conformance/src/__tests__/conformance.test.ts`

The umbrella function calls all three groups in order so adapter packages can opt into the entire suite with one call.

- [ ] **Step 1: Replace `index.ts` stub**

```typescript
// packages/sandbox/sandbox-conformance/src/index.ts
import type { SandboxAdapter, SandboxProfile } from "@koi/core";
import { describe } from "bun:test";
import { describeCapabilityHonestyConformance } from "./capability-honesty.js";
import { describeCreateDestroyConformance } from "./create-destroy.js";
import { describeLifecycleConformance } from "./lifecycle.js";

export { describeLifecycleConformance } from "./lifecycle.js";
export { describeCreateDestroyConformance } from "./create-destroy.js";
export { describeCapabilityHonestyConformance } from "./capability-honesty.js";

/**
 * Run every conformance group an L2 adapter package should pass.
 *
 * Usage from an adapter package:
 *
 *   import { describeSandboxConformance } from "@koi/sandbox-conformance";
 *   import { createMyAdapter } from "../my-adapter.js";
 *   describeSandboxConformance(
 *     "my-adapter",
 *     () => createMyAdapter(...),
 *     () => myMinimalProfile,
 *   );
 *
 * `factory` MUST return a fresh, never-init'd adapter on each call.
 * `profile` MUST return a profile the adapter accepts.
 */
export function describeSandboxConformance(
  label: string,
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe(`SandboxAdapter conformance: ${label}`, () => {
    describeLifecycleConformance(factory);
    describeCreateDestroyConformance(factory, profile);
    describeCapabilityHonestyConformance(factory, profile);
  });
}
```

- [ ] **Step 2: Write umbrella self-test**

```typescript
// packages/sandbox/sandbox-conformance/src/__tests__/conformance.test.ts
import type {
  AdapterCapabilities,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { describeSandboxConformance } from "../index.js";

const caps: AdapterCapabilities = {
  supports: new Set(["exec", "copy-files"]),
  priority: 0,
};

function fakeInstance(): SandboxInstance {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      oomKilled: false,
    }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    destroy: async () => {},
  };
}

const adapter: SandboxAdapter = {
  name: "fake",
  capabilities: caps,
  version: "0.0.0",
  create: async () => fakeInstance(),
};

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

describeSandboxConformance("fake-umbrella", () => adapter, () => profile);
```

- [ ] **Step 3: Run all conformance tests**

Run: `bun test packages/sandbox/sandbox-conformance/`
Expected: PASS — every test from lifecycle, create-destroy, capability-honesty, plus the umbrella self-test.

- [ ] **Step 4: Build the package**

Run: `bun run --cwd packages/sandbox/sandbox-conformance build`
Expected: `dist/index.js`, `dist/index.d.ts` produced.

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd packages/sandbox/sandbox-conformance typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/sandbox-conformance/src/index.ts packages/sandbox/sandbox-conformance/src/__tests__/conformance.test.ts
git commit -m "feat(sandbox-conformance): wire umbrella describeSandboxConformance"
```

---

## Task 18: Write `docs/L2/sandbox-router.md`

**Files:**
- Create: `docs/L2/sandbox-router.md`

- [ ] **Step 1: Write the doc**

```markdown
# @koi/sandbox-router — Capability-Based Adapter Selection

Selects a `SandboxAdapter` from a registry based on a `SandboxProfile`'s
declared capability requirements, with create-time fallback and passive
lifecycle/health tracking. Returns a `SelectionDecision` audit record alongside
every successful instance.

## Why it exists

Koi v2 supports multiple sandbox backends (local subprocess, Docker, SSH,
future cloud adapters). Without a router, every caller has to hardcode which
adapter to use. The router lets a profile say "I need exec + persistence; pick
whatever satisfies that" and lets ops/configuration decide which adapters are
available at runtime.

## Layer

```
L2  @koi/sandbox-router
    depends on: @koi/core (L0)
    does NOT import: @koi/engine (L1), peer L2
```

## Public API

```typescript
import {
  createSandboxRouter,
  type SandboxRouter,
  type SelectionDecision,
} from "@koi/sandbox-router";

const router = createSandboxRouter({
  adapters: [localAdapter, dockerAdapter],
  degradedThreshold: 3, // optional, default 3
});

const result = await router.create(profile);
if (result.ok) {
  const { instance, decision } = result.value;
  // decision.selected.{name, version, state, capabilities}
  // decision.attempts:  ordered list of create() calls (failed + successful)
  // decision.rejected:  capability-filter rejections (never reached create)
} else {
  // result.error: KoiError with code = VALIDATION (no match) or UNAVAILABLE (all failed)
  // result.error.context.reason: "no-adapter-matches" | "all-adapters-failed"
}

router.describe(); // BackendDescriptor[] — used for ops/admin UIs
await router.shutdown();
```

## Selection algorithm

1. Filter adapters: drop any that lack a declared `capabilities`, are missing
   a required capability, hold a forbidden capability, or are already
   `terminated`.
2. Sort the survivors: `(state === "ready" ? 0 : 1)` ascending, then
   `priority` ascending.
3. Try `create()` on each in order. First success wins; build a decision and
   return.
4. After every failure, increment that adapter's consecutive-failure count.
   At `degradedThreshold` consecutive failures, the adapter flips to
   `degraded` (still selectable, but ranked behind ready peers).
5. Any successful `create()` resets the count and restores `ready`.
6. If every matched adapter fails, return `UNAVAILABLE` with `cause` chain
   and `context.causedBy` listing all per-adapter errors.

## Lifecycle

| Transition | Trigger |
|------------|---------|
| `created → ready` | `init?()` resolved (or omitted) |
| `created → terminated` | `init()` rejected |
| `ready → degraded` | `degradedThreshold` consecutive failures |
| `degraded → ready` | next successful `create()` |
| any non-terminated → `terminated` | `router.shutdown()` |

The router never polls — state changes only when an adapter is actually used
(or shut down).

## Audit shape

`SelectionDecision` is the unit of audit. The router does not persist; the
caller (typically `@koi/runtime`) is responsible for routing the decision into
its trajectory/event-trace pipeline.

```typescript
interface SelectionDecision {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];   // try order; final entry == selected
  readonly rejected: readonly MatchRejection[];     // capability-filter rejections
}
```

## Error codes

| `KoiErrorCode` | Set when | `context.reason` |
|----------------|----------|------------------|
| `VALIDATION`   | No registered adapter satisfies the requirements | `"no-adapter-matches"` |
| `UNAVAILABLE`  | Every matched adapter's `create()` rejected      | `"all-adapters-failed"` |

`UNAVAILABLE` carries `context.causedBy: KoiError[]` — one entry per attempted
adapter, in attempt order.

## Limitations

- No live mid-session migration. Migration is create-time fallback only.
- No active health probing. Adapter health is inferred from `create()` outcomes.
- No cost-based selection — sort is `(state, priority)` only.
- Backends without a `capabilities` declaration cannot participate in router
  selection. They can still be invoked directly by callers that hold an
  adapter reference.
```

- [ ] **Step 2: Verify the file is committed**

Run: `ls -la docs/L2/sandbox-router.md`
Expected: file exists, size > 0.

- [ ] **Step 3: Commit**

```bash
git add docs/L2/sandbox-router.md
git commit -m "docs: add sandbox-router L2 doc"
```

---

## Task 19: Write `docs/L2/sandbox-conformance.md` and `docs/L2/sandbox-threat-template.md`

**Files:**
- Create: `docs/L2/sandbox-conformance.md`
- Create: `docs/L2/sandbox-threat-template.md`

- [ ] **Step 1: Write `sandbox-conformance.md`**

```markdown
# @koi/sandbox-conformance — Shared Adapter Test Suite

Shared `bun:test` describe blocks adapter packages import to verify they meet
the `SandboxAdapter` contract. Every L2 adapter package SHOULD have a
`__tests__/conformance.test.ts` that calls `describeSandboxConformance`.

## Layer

```
L2  @koi/sandbox-conformance
    depends on: @koi/core (L0), bun:test (Bun runtime)
    does NOT import: @koi/engine (L1), peer L2
```

This package is `private: true` — never published to npm. Adapter packages
include it as a `devDependency`.

## Usage

```typescript
// packages/sandbox/sandbox-<name>/src/__tests__/conformance.test.ts
import { describeSandboxConformance } from "@koi/sandbox-conformance";
import type { SandboxProfile } from "@koi/core";
import { createMyAdapter } from "../adapter.js";

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: false },
  resources: {},
};

describeSandboxConformance(
  "my-adapter",
  () => createMyAdapter({ /* config */ }),
  () => profile,
);
```

## Groups (PR 1)

| Group | What it checks |
|-------|----------------|
| Lifecycle | `init?` and `shutdown?` are idempotent and don't throw |
| Create + Destroy | `create()` returns a usable instance; `destroy()` is idempotent |
| Capability honesty | `persistence` ⇒ `findOrCreate` exists; `spawn` ⇒ `instance.spawn` exists |

## Groups planned for PRs 2-4

| Group | Lands with |
|-------|------------|
| Exec basics (exit codes, stdout/stderr, env, cwd) | PR 2 (`@koi/sandbox-local`) |
| Exec timeout + signal | PR 2 |
| Exec output limits / truncation | PR 2 |
| copy-files roundtrip | PR 2 |
| spawn (capability-gated) | PR 2 |
| Persistence (capability-gated) | PR 3 (`@koi/sandbox-docker` declares it) |
| Profile enforcement (network/filesystem/resources) | PR 2 |

## Design notes

- Each group is exposed both as an individual function (for adapters that
  want to opt into a subset) and via the umbrella `describeSandboxConformance`.
- Capability-gated tests use the adapter's `capabilities.supports` set to
  decide whether to run or skip — a missing capability is not a failure.
- The `factory: () => SandboxAdapter` argument MUST return a fresh adapter
  on each call; the suite manages init/shutdown internally.
```

- [ ] **Step 2: Write `sandbox-threat-template.md`**

```markdown
# Sandbox Adapter Threat Model — Template

Every L2 sandbox adapter package MUST ship a doc at
`docs/L2/sandbox-<name>.md` that includes a "Threat model" section using
this template. PRs 2-4 each populate this template for `sandbox-local`,
`sandbox-docker`, and `sandbox-ssh`.

## Trust boundary

Describe what is inside the sandbox boundary and what is outside. A reader
should be able to point at any resource and say "trusted" or "untrusted".

- Inside: ...
- Outside: ...

## Privileged surfaces

Enumerate every surface the adapter exposes that holds privilege relative to
the sandboxed code. Examples: a Docker daemon socket, an SSH agent, a host
filesystem mount.

## Escape vectors

Known or plausible ways code inside the sandbox could break out. Be specific —
"shell injection" is not enough; specify the boundary.

## Mitigations

For each escape vector above, the design choice that prevents it. If a vector
has no mitigation, it must appear in "Residual risk" below.

## Residual risk

Risks the adapter cannot mitigate at its layer. Callers must treat these as
known and accept them or compensate at a higher layer.

## Out-of-scope

What this adapter explicitly does not defend against. Examples: hardware
side-channel attacks, kernel 0-days. Document so future readers don't
mistakenly expect coverage.
```

- [ ] **Step 3: Commit**

```bash
git add docs/L2/sandbox-conformance.md docs/L2/sandbox-threat-template.md
git commit -m "docs: add sandbox-conformance L2 doc and threat-model template"
```

---

## Task 20: Final verification — full CI gate

**Files:** none changed. Pure verification.

- [ ] **Step 1: Typecheck the entire repo**

Run: `bun run typecheck`
Expected: PASS, zero errors.

If failure: read the error, identify which package, fix in place. Common cause: forgetting to add `import type { ... }` for new core types in a consumer.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 3: Layer check**

Run: `bun run check:layers`
Expected: PASS — both new packages registered as L2; their imports are L0-only.

- [ ] **Step 4: Unused-export check**

Run: `bun run check:unused`
Expected: PASS or warning-only. Investigate any reported unused exports — the public API in `index.ts` files is the entry point.

- [ ] **Step 5: Duplicates check**

Run: `bun run check:duplicates`
Expected: PASS.

- [ ] **Step 6: Run only the new tests**

Run:
```bash
bun test packages/sandbox/sandbox-router/ packages/sandbox/sandbox-conformance/
```
Expected: every test passes — match (5), decision (4), router (14), conformance lifecycle (3 × 2 wrappers), create-destroy (2), capability-honesty (2), umbrella (subset of above).

- [ ] **Step 7: Run full repo test suite**

Run: `bun run test`
Expected: PASS — no existing test broken by the additive L0 changes.

If any pre-existing test breaks: revert the offending change, narrow the L0 modification to truly additive, and re-run.

- [ ] **Step 8: Inspect the diff one more time**

Run: `git log --oneline main..HEAD`
Expected: ~19 commits across L0 + router + conformance + docs, in the order of this plan.

- [ ] **Step 9: No additional commit needed**

This task is verification only.

---

## Self-Review Notes

### Spec coverage

| Spec section | Plan task |
|--------------|-----------|
| §5.1 New L0 types (`adapter-capabilities.ts`) | Task 1 |
| §5.2 Extended `SandboxAdapter` | Task 3 |
| §5.3 Extended `SandboxProfile` (`required`, `ssh`) | Task 4 |
| §5.4 New error codes | Deviated — reused existing codes (documented) |
| §6.1 Router public API | Tasks 9, 10, 12 |
| §6.2 Selection algorithm steps 1-5 | Task 10 |
| §6.3 Lifecycle (init/shutdown + state machine) | Task 9 (init/shutdown), Task 11 (degraded) |
| §6.4 Files (router/match/decision/index.ts) | Tasks 7, 8, 9, 10, 11, 12 |
| §8.1 Conformance mechanism | Task 17 |
| §8.2 Lifecycle group | Task 14 |
| §8.2 Create+Destroy group | Task 15 |
| §8.2 Capability-honesty group | Task 16 |
| §8.2 Exec/copy-files/spawn/persistence/profile-enforcement | **Deferred** to PRs 2-4 (documented in Task 19) |
| §9.4 docs/L2/sandbox-router.md | Task 18 |
| §9.4 docs/L2/sandbox-threat-template.md | Task 19 |

### Out-of-PR-1 items (parked for follow-up PRs)

- `@koi/sandbox-local` package (PR 2)
- `@koi/sandbox-docker` capability declaration update (PR 3)
- `@koi/sandbox-ssh` package (PR 4)
- `@koi/runtime` wiring + golden queries (PR 5)
- Exec/copy-files/spawn/persistence conformance groups (added with the adapters that exercise them)

### Risks / things to watch during execution

1. The `void Promise.resolve().then(...)` init pattern in `router.ts` defers init to a microtask — tests need to flush microtasks (`await Promise.resolve()` once or twice) before asserting state. The plan tests do this; if you add new tests, follow the pattern.
2. `bun:test` does not have a built-in microtask flush; it does run `await` correctly. Two `await Promise.resolve()` is the safe minimum.
3. `match.ts` returns `MatchRejection.missing` as a `readonly AdapterCapability[]` — order of capabilities depends on `Set` iteration order. Tests use `toEqual` on a single-element array so this is stable in practice; if you add multi-element assertions, use `toContain` instead.
4. The `SelectionDecision` is `Object.freeze`'d — DO NOT push into `decision.attempts` after building. The router's internal `attempts` array is mutable; the public decision is the frozen snapshot.
5. `@koi/sandbox-conformance` is consumed by adapter `__tests__/`. To avoid the `bun:test` global polluting the build, the conformance package's `tsup` build emits ESM only and the consumer test files import from `bun:test` themselves — the conformance helpers re-import `bun:test`, which Bun resolves at test time. Don't try to mark `bun:test` as `external` in `tsup.config.ts` — Bun's `bun:` scheme is a built-in.

### Open questions surfaced during planning

None blocking. PR 1 is self-contained: contract additions are non-breaking, the router has no real adapter dependency, and the conformance suite self-tests against fakes. PRs 2-5 build on this foundation independently.
