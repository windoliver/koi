# Approval Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@koi/approval-zones`, an L2 package that intercepts `ask` decisions from the permissions backend and converts them to auto-approve, sandbox-then-auto, or pass-through ask based on configured zones + risk scoring.

**Architecture:** New L2 package depending only on `@koi/core` + L0u (`bash-ast`, `bash-classifier`). Zone evaluation is pure. Sandbox orchestration lives in a separate `middleware-bridge` module that is imported by `@koi/middleware-permissions`. `createPermissionsMiddleware` gains one optional `zones` config field. Default-off: omitting `zones` keeps existing behavior byte-identical.

**Tech Stack:** TypeScript 6 (strict, ESM), `bun:test`, `tsup`, `@koi/core` (PermissionQuery/Decision), `@koi/bash-ast`, `@koi/bash-classifier`, `@koi/sandbox-router` (peer of `@koi/middleware-permissions`, not of `@koi/approval-zones`).

**Spec:** `docs/superpowers/specs/2026-05-10-issue-1644-approval-zones-design.md`

**Issue:** [#1644](https://github.com/windoliver/koi/issues/1644)

---

## Conventions

- **Working dir:** `/Users/sophiawj/private/koi/.claude/worktrees/issue-1644-approval-zones` — all paths in this plan are relative to it.
- **Branch:** `worktree-issue-1644-approval-zones` (already created by setup).
- **Commits:** one per task end. Use Conventional Commits prefix `feat(approval-zones):` for code, `test(approval-zones):` for test-only, `docs(approval-zones):` for docs.
- **Test runner:** `bun test packages/security/approval-zones/` for the package; `bun run test --filter=@koi/approval-zones` from repo root.
- **TDD discipline:** every behavior step is failing-test → minimal-impl → green → commit. Do not batch.
- **Package name:** `@koi/approval-zones` (Koi convention drops the `security/` prefix from package name; directory still lives under `packages/security/approval-zones`).
- **Layer:** L2. Must be added to `scripts/layers.ts` `L2_PACKAGES` (or whichever set permissions packages live in — check the file).

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/security/approval-zones/package.json`
- Create: `packages/security/approval-zones/tsconfig.json`
- Create: `packages/security/approval-zones/tsup.config.ts`
- Create: `packages/security/approval-zones/src/index.ts`

- [ ] **Step 1: Create `packages/security/approval-zones/package.json`**

```json
{
  "name": "@koi/approval-zones",
  "description": "Approval zones with risk scoring — converts ask verdicts into auto / sandbox-then-auto / ask",
  "version": "0.0.0",
  "private": true,
  "koi": {
    "optional": true
  },
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "bun ../../../scripts/run-tsup.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/bash-ast": "workspace:*",
    "@koi/bash-classifier": "workspace:*",
    "@koi/core": "workspace:*"
  },
  "devDependencies": {}
}
```

- [ ] **Step 2: Create `packages/security/approval-zones/tsconfig.json`**

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
    { "path": "../../lib/bash-ast" },
    { "path": "../../lib/bash-classifier" }
  ]
}
```

- [ ] **Step 3: Create `packages/security/approval-zones/tsup.config.ts`**

```ts
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

- [ ] **Step 4: Create placeholder `packages/security/approval-zones/src/index.ts`**

```ts
// @koi/approval-zones — public surface filled in by later tasks.
export {};
```

- [ ] **Step 5: Install + typecheck**

Run from repo root:
```bash
bun install
bun --cwd packages/security/approval-zones run typecheck
```
Expected: install succeeds, typecheck passes (no symbols yet).

- [ ] **Step 6: Add package to layer classification**

Open `scripts/layers.ts`. Find the set permissions packages live in (search for `@koi/permissions`). Add `"@koi/approval-zones"` to the same set, keeping alphabetical order.

Run:
```bash
bun run check:layers
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/security/approval-zones scripts/layers.ts bun.lock
git commit -m "feat(approval-zones): scaffold @koi/approval-zones package"
```

---

## Task 2: Type definitions (zone-types + risk-types)

**Files:**
- Create: `packages/security/approval-zones/src/zone-types.ts`
- Create: `packages/security/approval-zones/src/risk-types.ts`
- Create: `packages/security/approval-zones/src/zone-types.test.ts`

- [ ] **Step 1: Write the failing test `zone-types.test.ts`**

```ts
import { describe, expect, it } from "bun:test";
import type { ApprovalZone, ZoneAction, ZoneVerdict } from "./zone-types.js";

describe("zone-types", () => {
  it("ZoneAction has exactly the three documented actions", () => {
    const actions: ZoneAction[] = ["auto", "ask", "sandbox-then-auto"];
    expect(actions).toHaveLength(3);
  });

  it("ApprovalZone shape compiles with all optional fields omitted", () => {
    const zone: ApprovalZone = { name: "x", match: {}, action: "ask" };
    expect(zone.name).toBe("x");
  });

  it("ZoneVerdict has 3 discriminated cases", () => {
    const v1: ZoneVerdict = { kind: "auto", zone: "z", risk: "low" };
    const v2: ZoneVerdict = { kind: "sandbox", zone: "z", risk: "low", backendId: "default" };
    const v3: ZoneVerdict = { kind: "ask", reason: "no-match" };
    expect([v1.kind, v2.kind, v3.kind]).toEqual(["auto", "sandbox", "ask"]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
bun --cwd packages/security/approval-zones test src/zone-types.test.ts
```
Expected: FAIL — `Cannot find module './zone-types.js'`.

- [ ] **Step 3: Create `risk-types.ts`**

```ts
/**
 * Risk tiers for approval-zone gating.
 * Ordering: low < medium < high < critical (use compareRisk to compare).
 */
export type RiskTier = "low" | "medium" | "high" | "critical";

export interface RiskInputs {
  readonly toolId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly resource?: string | undefined;
  readonly bashCommand?: string | undefined;
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  /** Human-readable reasons; surfaced in audit events. */
  readonly reasons: readonly string[];
}

export interface RiskScorer {
  score(inputs: RiskInputs): RiskAssessment | Promise<RiskAssessment>;
}

const RISK_ORDER: Readonly<Record<RiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Returns negative if a < b, zero if equal, positive if a > b. */
export function compareRisk(a: RiskTier, b: RiskTier): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}
```

- [ ] **Step 4: Create `zone-types.ts`**

```ts
import type { RiskTier } from "./risk-types.js";

export type ZoneAction = "auto" | "ask" | "sandbox-then-auto";

export interface ZoneMatch {
  /** Glob patterns matched against `PermissionQuery.action` (the toolId). */
  readonly tools?: readonly string[];
  /** Glob patterns matched against `PermissionQuery.resource`. */
  readonly paths?: readonly string[];
  /** Per-arg-key glob predicates against `PermissionQuery.context`. */
  readonly args?: Readonly<Record<string, string>>;
}

export interface ApprovalZone {
  readonly name: string;
  readonly match: ZoneMatch;
  readonly action: ZoneAction;
  /** Default `"low"` if omitted. Action only fires when score ≤ this. */
  readonly maxRisk?: RiskTier;
  /** Required when `action === "sandbox-then-auto"`. */
  readonly sandboxBackendId?: string;
}

export type ZoneVerdict =
  | {
      readonly kind: "auto";
      readonly zone: string;
      readonly risk: RiskTier;
      readonly riskReasons?: readonly string[];
    }
  | {
      readonly kind: "sandbox";
      readonly zone: string;
      readonly risk: RiskTier;
      readonly backendId: string;
      readonly riskReasons?: readonly string[];
    }
  | {
      readonly kind: "ask";
      readonly reason:
        | "no-match"
        | "risk-exceeded"
        | "missing-backend"
        | "non-bash-tool"
        | "matcher-error"
        | "scorer-error";
      readonly zone?: string;
      readonly risk?: RiskTier;
      readonly riskReasons?: readonly string[];
    };
```

- [ ] **Step 5: Run — verify it passes**

```bash
bun --cwd packages/security/approval-zones test src/zone-types.test.ts
```
Expected: 3 pass.

- [ ] **Step 6: Add a test for `compareRisk`**

Append to `zone-types.test.ts`:
```ts
import { compareRisk } from "./risk-types.js";

describe("compareRisk", () => {
  it("orders low < medium < high < critical", () => {
    expect(compareRisk("low", "critical")).toBeLessThan(0);
    expect(compareRisk("critical", "low")).toBeGreaterThan(0);
    expect(compareRisk("medium", "medium")).toBe(0);
  });
});
```

Run again. Expected: 4 pass.

- [ ] **Step 7: Commit**

```bash
git add packages/security/approval-zones/src
git commit -m "feat(approval-zones): zone + risk type definitions"
```

---

## Task 3: Zone matcher (`zone-match.ts`)

**Files:**
- Create: `packages/security/approval-zones/src/zone-match.ts`
- Create: `packages/security/approval-zones/src/zone-match.test.ts`

The matcher decides whether a `PermissionQuery` matches a single `ApprovalZone`. Globs use the same dialect as `@koi/permissions` (`*` = single segment, `**` = any). Reuse the local glob compiler — do NOT import from `@koi/permissions` (would be L2→L2).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import type { ApprovalZone } from "./zone-types.js";
import { matchesZone } from "./zone-match.js";

const baseQuery: PermissionQuery = {
  principal: "agent:main",
  action: "read",
  resource: "/proj/src/foo.ts",
};

describe("matchesZone", () => {
  it("matches when no match fields are set (catch-all zone)", () => {
    const zone: ApprovalZone = { name: "all", match: {}, action: "auto" };
    expect(matchesZone(baseQuery, zone)).toBe(true);
  });

  it("matches tool glob", () => {
    const zone: ApprovalZone = { name: "z", match: { tools: ["read", "glob"] }, action: "auto" };
    expect(matchesZone(baseQuery, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, action: "write" }, zone)).toBe(false);
  });

  it("matches path glob with **", () => {
    const zone: ApprovalZone = { name: "z", match: { paths: ["**/*.test.ts"] }, action: "auto" };
    expect(matchesZone({ ...baseQuery, resource: "/a/b/x.test.ts" }, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, resource: "/a/b/x.ts" }, zone)).toBe(false);
  });

  it("requires ALL match fields to pass (AND across fields)", () => {
    const zone: ApprovalZone = {
      name: "z",
      match: { tools: ["read"], paths: ["**/*.ts"] },
      action: "auto",
    };
    expect(matchesZone(baseQuery, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, action: "write" }, zone)).toBe(false);
    expect(matchesZone({ ...baseQuery, resource: "/x.py" }, zone)).toBe(false);
  });

  it("matches args predicate via context", () => {
    const zone: ApprovalZone = {
      name: "z",
      match: { args: { branch: "feature/*" } },
      action: "auto",
    };
    const q: PermissionQuery = { ...baseQuery, context: { branch: "feature/x" } };
    expect(matchesZone(q, zone)).toBe(true);
    expect(matchesZone({ ...baseQuery, context: { branch: "main" } }, zone)).toBe(false);
    expect(matchesZone(baseQuery, zone)).toBe(false); // missing context key
  });

  it("returns false when context is non-string for an args predicate", () => {
    const zone: ApprovalZone = {
      name: "z",
      match: { args: { count: "5" } },
      action: "auto",
    };
    const q: PermissionQuery = { ...baseQuery, context: { count: 5 } };
    expect(matchesZone(q, zone)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
bun --cwd packages/security/approval-zones test src/zone-match.test.ts
```
Expected: FAIL — `Cannot find module './zone-match.js'`.

- [ ] **Step 3: Implement `zone-match.ts`**

```ts
import type { PermissionQuery } from "@koi/core";
import type { ApprovalZone, ZoneMatch } from "./zone-types.js";

/**
 * Convert a glob pattern to RegExp.
 * `*`  → single path segment (no `/`); `**` → zero or more segments.
 * Local copy of the dialect used by @koi/permissions; do not import that
 * package (L2→L2 violation).
 */
function compileGlob(pattern: string): RegExp {
  let result = "^";
  for (let i = 0; i < pattern.length; ) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      i += 2;
      if (pattern.charAt(i) === "/") {
        result += "(?:.*/)?";
        i += 1;
      } else if (result.endsWith("/")) {
        result = `${result.slice(0, -1)}(?:/.*)?`;
      } else {
        result += ".*";
      }
    } else if (c === "*") {
      result += "[^/]*";
      i += 1;
    } else {
      result += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${result}$`);
}

const compiledCache = new WeakMap<readonly string[], readonly RegExp[]>();
function compileAll(patterns: readonly string[]): readonly RegExp[] {
  let cached = compiledCache.get(patterns);
  if (cached === undefined) {
    cached = patterns.map(compileGlob);
    compiledCache.set(patterns, cached);
  }
  return cached;
}

function anyMatch(patterns: readonly string[], value: string): boolean {
  for (const re of compileAll(patterns)) {
    if (re.test(value)) return true;
  }
  return false;
}

function matchesArgs(
  predicate: Readonly<Record<string, string>>,
  context: PermissionQuery["context"],
): boolean {
  if (context === undefined) return false;
  for (const [key, pattern] of Object.entries(predicate)) {
    const value = context[key];
    if (typeof value !== "string") return false;
    if (!compileGlob(pattern).test(value)) return false;
  }
  return true;
}

export function matchesZone(query: PermissionQuery, zone: ApprovalZone): boolean {
  const m: ZoneMatch = zone.match;
  if (m.tools !== undefined && !anyMatch(m.tools, query.action)) return false;
  if (m.paths !== undefined && !anyMatch(m.paths, query.resource)) return false;
  if (m.args !== undefined && !matchesArgs(m.args, query.context)) return false;
  return true;
}
```

- [ ] **Step 4: Run — verify it passes**

```bash
bun --cwd packages/security/approval-zones test src/zone-match.test.ts
```
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/approval-zones/src
git commit -m "feat(approval-zones): zone matcher with glob + args predicates"
```

---

## Task 4: Default risk scorer (`risk-scorer.ts`)

**Files:**
- Create: `packages/security/approval-zones/src/risk-scorer.ts`
- Create: `packages/security/approval-zones/src/risk-scorer.test.ts`

Default scorer composes three signals (path, tool, bash AST). Highest tier wins; reasons accumulate.

- [ ] **Step 1: Write the failing test (path + tool signals)**

```ts
import { describe, expect, it } from "bun:test";
import { createDefaultRiskScorer } from "./risk-scorer.js";

const scorer = createDefaultRiskScorer({ projectRoot: "/proj" });

describe("createDefaultRiskScorer — path signal", () => {
  it("flags ~/.ssh paths as critical", async () => {
    const r = await scorer.score({
      toolId: "read",
      args: {},
      resource: "/Users/me/.ssh/id_rsa",
    });
    expect(r.tier).toBe("critical");
    expect(r.reasons.some((s) => s.includes(".ssh"))).toBe(true);
  });

  it("flags .env files as critical", async () => {
    const r = await scorer.score({
      toolId: "read",
      args: {},
      resource: "/proj/.env.local",
    });
    expect(r.tier).toBe("critical");
  });

  it("flags /etc paths as critical", async () => {
    const r = await scorer.score({ toolId: "read", args: {}, resource: "/etc/passwd" });
    expect(r.tier).toBe("critical");
  });

  it("rates resources outside project root as medium", async () => {
    const r = await scorer.score({ toolId: "read", args: {}, resource: "/tmp/foo" });
    expect(r.tier).toBe("medium");
  });

  it("rates resources inside project root as low", async () => {
    const r = await scorer.score({
      toolId: "read",
      args: {},
      resource: "/proj/src/foo.ts",
    });
    expect(r.tier).toBe("low");
  });
});

describe("createDefaultRiskScorer — tool signal", () => {
  it("rates read/glob/grep as low", async () => {
    for (const t of ["read", "glob", "grep"]) {
      const r = await scorer.score({ toolId: t, args: {}, resource: "/proj/x.ts" });
      expect(r.tier).toBe("low");
    }
  });

  it("rates write/edit as medium even on project files", async () => {
    const r = await scorer.score({ toolId: "write", args: {}, resource: "/proj/src/foo.ts" });
    expect(r.tier).toBe("medium");
  });

  it("highest signal wins (critical path beats low tool)", async () => {
    const r = await scorer.score({
      toolId: "read",
      args: {},
      resource: "/proj/.env",
    });
    expect(r.tier).toBe("critical");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
bun --cwd packages/security/approval-zones test src/risk-scorer.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `risk-scorer.ts` (path + tool only, bash signal in next step)**

```ts
import type { RiskAssessment, RiskInputs, RiskScorer, RiskTier } from "./risk-types.js";
import { compareRisk } from "./risk-types.js";

export interface DefaultRiskScorerOptions {
  /** Absolute path of project root. Resources inside score `low`; outside score `medium`. */
  readonly projectRoot: string;
}

const CRITICAL_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /^\/etc(?:\/|$)/,
];
const HIGH_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.aws(?:\/|$)/,
  /(?:^|\/)\.config(?:\/|$)/,
];

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep", "ls"]);
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multi-edit", "patch"]);

function scorePath(resource: string | undefined, projectRoot: string): {
  readonly tier: RiskTier;
  readonly reason: string;
} {
  if (resource === undefined) return { tier: "low", reason: "no-resource" };
  for (const re of CRITICAL_PATH_PATTERNS) {
    if (re.test(resource)) return { tier: "critical", reason: `path-sensitive:${re.source}` };
  }
  for (const re of HIGH_PATH_PATTERNS) {
    if (re.test(resource)) return { tier: "high", reason: `path-config:${re.source}` };
  }
  if (resource.startsWith(projectRoot)) {
    return { tier: "low", reason: "in-project" };
  }
  return { tier: "medium", reason: "outside-project" };
}

function scoreTool(toolId: string): { readonly tier: RiskTier; readonly reason: string } {
  if (READ_ONLY_TOOLS.has(toolId)) return { tier: "low", reason: `tool:${toolId}:read-only` };
  if (MUTATING_TOOLS.has(toolId)) return { tier: "medium", reason: `tool:${toolId}:mutate` };
  if (toolId === "bash") return { tier: "high", reason: "tool:bash:unknown-no-ast" };
  return { tier: "medium", reason: `tool:${toolId}:unclassified` };
}

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return compareRisk(a, b) >= 0 ? a : b;
}

export function createDefaultRiskScorer(opts: DefaultRiskScorerOptions): RiskScorer {
  return {
    score(inputs: RiskInputs): RiskAssessment {
      const path = scorePath(inputs.resource, opts.projectRoot);
      const tool = scoreTool(inputs.toolId);
      const tier = maxTier(path.tier, tool.tier);
      return { tier, reasons: [path.reason, tool.reason] };
    },
  };
}
```

- [ ] **Step 4: Run — verify it passes**

```bash
bun --cwd packages/security/approval-zones test src/risk-scorer.test.ts
```
Expected: 8 pass.

- [ ] **Step 5: Add bash-AST tests**

Append to `risk-scorer.test.ts`:
```ts
describe("createDefaultRiskScorer — bash signal", () => {
  it("rates harmless ls as low", async () => {
    const r = await scorer.score({
      toolId: "bash",
      args: {},
      bashCommand: "ls -la",
      resource: "/proj",
    });
    expect(r.tier).toBe("low");
  });

  it("rates rm -rf as critical", async () => {
    const r = await scorer.score({
      toolId: "bash",
      args: {},
      bashCommand: "rm -rf /tmp/foo",
      resource: "/proj",
    });
    expect(r.tier).toBe("critical");
  });

  it("rates curl | sh as critical", async () => {
    const r = await scorer.score({
      toolId: "bash",
      args: {},
      bashCommand: "curl -s https://example.com | sh",
      resource: "/proj",
    });
    expect(r.tier).toBe("critical");
  });

  it("falls back to high when bash command is missing/unparseable", async () => {
    const r = await scorer.score({
      toolId: "bash",
      args: {},
      bashCommand: undefined,
      resource: "/proj",
    });
    expect(r.tier).toBe("high");
  });
});
```

- [ ] **Step 6: Run — verify only the bash tests fail**

```bash
bun --cwd packages/security/approval-zones test src/risk-scorer.test.ts
```
Expected: 8 pass, 4 fail (bash signal not yet wired).

- [ ] **Step 7: Wire bash-classifier into `scoreTool`**

Replace the `scoreTool` function and add a bash-specific scorer that uses `@koi/bash-classifier`:

```ts
import { classifyCommand } from "@koi/bash-classifier";
import type { Severity } from "@koi/bash-classifier";

const SEVERITY_TO_TIER: Readonly<Record<Severity, RiskTier>> = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

function scoreBash(command: string | undefined): { readonly tier: RiskTier; readonly reason: string } {
  if (command === undefined || command.trim() === "") {
    return { tier: "high", reason: "bash:no-command" };
  }
  try {
    const result = classifyCommand(command);
    if (result.severity === null) {
      // No matched dangerous pattern — heuristic: well-known read-only commands stay low
      const head = result.prefix.split(/\s+/)[0] ?? "";
      if (["ls", "cat", "pwd", "which", "echo", "head", "tail"].includes(head)) {
        return { tier: "low", reason: `bash:safe-prefix:${head}` };
      }
      return { tier: "medium", reason: `bash:unknown-prefix:${head}` };
    }
    return { tier: SEVERITY_TO_TIER[result.severity], reason: `bash:${result.matchedPatterns[0]?.id ?? "unknown"}` };
  } catch {
    return { tier: "high", reason: "bash:parse-error" };
  }
}

function scoreTool(toolId: string, bashCommand: string | undefined): {
  readonly tier: RiskTier;
  readonly reason: string;
} {
  if (READ_ONLY_TOOLS.has(toolId)) return { tier: "low", reason: `tool:${toolId}:read-only` };
  if (MUTATING_TOOLS.has(toolId)) return { tier: "medium", reason: `tool:${toolId}:mutate` };
  if (toolId === "bash") {
    const r = scoreBash(bashCommand);
    return { tier: r.tier, reason: r.reason };
  }
  return { tier: "medium", reason: `tool:${toolId}:unclassified` };
}
```

Update `score(inputs)` to pass `inputs.bashCommand` to `scoreTool`.

- [ ] **Step 8: Run — verify all pass**

```bash
bun --cwd packages/security/approval-zones test src/risk-scorer.test.ts
```
Expected: 12 pass. If `classifyCommand` does not flag `rm -rf` as critical, inspect `@koi/bash-classifier` patterns (`packages/lib/bash-classifier/src/patterns.ts`) and adjust the test expectation to match the package's actual output — but only after confirming `rm -rf` IS in the dangerous-pattern registry. Do not weaken the test for an unrelated reason.

- [ ] **Step 9: Commit**

```bash
git add packages/security/approval-zones/src
git commit -m "feat(approval-zones): default risk scorer with path/tool/bash-AST signals"
```

---

## Task 5: Zone evaluator (`evaluator.ts`)

**Files:**
- Create: `packages/security/approval-zones/src/evaluator.ts`
- Create: `packages/security/approval-zones/src/evaluator.test.ts`

The evaluator wraps `matchesZone` + a `RiskScorer` to produce a `ZoneVerdict`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import { createZoneEvaluator } from "./evaluator.js";
import type { RiskAssessment, RiskScorer } from "./risk-types.js";
import type { ApprovalZone } from "./zone-types.js";

const fixedScorer = (a: RiskAssessment): RiskScorer => ({ score: () => a });

const baseQuery: PermissionQuery = {
  principal: "agent:main",
  action: "read",
  resource: "/proj/x.ts",
};

describe("createZoneEvaluator", () => {
  it("returns ask:no-match when no zones match", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "z", match: { tools: ["write"] }, action: "auto" }],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v).toEqual({ kind: "ask", reason: "no-match" });
  });

  it("returns auto when zone matches and risk ≤ maxRisk", async () => {
    const zone: ApprovalZone = {
      name: "ro",
      match: { tools: ["read"] },
      action: "auto",
      maxRisk: "low",
    };
    const ev = createZoneEvaluator({
      zones: [zone],
      scorer: fixedScorer({ tier: "low", reasons: ["in-project"] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("auto");
    if (v.kind === "auto") expect(v.zone).toBe("ro");
  });

  it("returns ask:risk-exceeded when risk > maxRisk", async () => {
    const zone: ApprovalZone = {
      name: "ro",
      match: { tools: ["read"] },
      action: "auto",
      maxRisk: "low",
    };
    const ev = createZoneEvaluator({
      zones: [zone],
      scorer: fixedScorer({ tier: "high", reasons: ["x"] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("risk-exceeded");
  });

  it("default maxRisk is 'low' when omitted", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "z", match: {}, action: "auto" }],
      scorer: fixedScorer({ tier: "medium", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("risk-exceeded");
  });

  it("returns sandbox for sandbox-then-auto on bash with backendId", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "cleanup",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
          sandboxBackendId: "default",
        },
      ],
      scorer: fixedScorer({ tier: "medium", reasons: [] }),
    });
    const v = await ev.evaluate({ ...baseQuery, action: "bash" });
    expect(v.kind).toBe("sandbox");
    if (v.kind === "sandbox") expect(v.backendId).toBe("default");
  });

  it("returns ask:non-bash-tool for sandbox action on non-bash tool", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "z",
          match: { tools: ["write"] },
          action: "sandbox-then-auto",
          maxRisk: "high",
          sandboxBackendId: "default",
        },
      ],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate({ ...baseQuery, action: "write" });
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("non-bash-tool");
  });

  it("returns ask:missing-backend when sandbox-then-auto omits sandboxBackendId", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "z",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
        },
      ],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate({ ...baseQuery, action: "bash" });
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("missing-backend");
  });

  it("returns first-match-wins across multiple zones", async () => {
    const ev = createZoneEvaluator({
      zones: [
        { name: "first", match: { tools: ["read"] }, action: "auto", maxRisk: "low" },
        { name: "second", match: { tools: ["read"] }, action: "ask" },
      ],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("auto");
    if (v.kind === "auto") expect(v.zone).toBe("first");
  });

  it("returns ask:matcher-error when matcher throws", async () => {
    // Force a throw by injecting an invalid pattern via a custom zone (regex compile success
    // but match() throws). Easiest path: use a bogus context value type elsewhere.
    // Instead: pass a zone whose match is replaced post-hoc with a throwing getter.
    const evilZone = {
      name: "evil",
      get match() {
        throw new Error("boom");
      },
      action: "auto" as const,
    } as unknown as ApprovalZone;
    const ev = createZoneEvaluator({
      zones: [evilZone],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("matcher-error");
  });

  it("returns ask:scorer-error when scorer throws", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "z", match: { tools: ["read"] }, action: "auto", maxRisk: "low" }],
      scorer: { score: () => { throw new Error("boom"); } },
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("scorer-error");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
bun --cwd packages/security/approval-zones test src/evaluator.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `evaluator.ts`**

```ts
import type { PermissionQuery } from "@koi/core";
import { compareRisk } from "./risk-types.js";
import type { RiskAssessment, RiskScorer } from "./risk-types.js";
import { matchesZone } from "./zone-match.js";
import type { ApprovalZone, ZoneVerdict } from "./zone-types.js";

export interface ZoneEvaluatorConfig {
  readonly zones: readonly ApprovalZone[];
  readonly scorer: RiskScorer;
}

export interface ZoneEvaluator {
  evaluate(query: PermissionQuery): Promise<ZoneVerdict>;
}

const DEFAULT_MAX_RISK = "low";

export function createZoneEvaluator(config: ZoneEvaluatorConfig): ZoneEvaluator {
  return {
    async evaluate(query) {
      let matched: ApprovalZone | undefined;
      try {
        for (const zone of config.zones) {
          if (matchesZone(query, zone)) {
            matched = zone;
            break;
          }
        }
      } catch {
        return { kind: "ask", reason: "matcher-error" };
      }
      if (matched === undefined) return { kind: "ask", reason: "no-match" };

      let assessment: RiskAssessment;
      try {
        assessment = await Promise.resolve(
          config.scorer.score({
            toolId: query.action,
            args: query.context ?? {},
            resource: query.resource,
            bashCommand:
              query.action === "bash" && typeof query.context?.command === "string"
                ? (query.context.command as string)
                : undefined,
          }),
        );
      } catch {
        return { kind: "ask", reason: "scorer-error" };
      }

      const maxRisk = matched.maxRisk ?? DEFAULT_MAX_RISK;
      if (compareRisk(assessment.tier, maxRisk) > 0) {
        return {
          kind: "ask",
          reason: "risk-exceeded",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }

      if (matched.action === "ask") {
        return {
          kind: "ask",
          reason: "no-match",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }

      if (matched.action === "auto") {
        return {
          kind: "auto",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }

      // sandbox-then-auto
      if (query.action !== "bash") {
        return {
          kind: "ask",
          reason: "non-bash-tool",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }
      if (matched.sandboxBackendId === undefined) {
        return {
          kind: "ask",
          reason: "missing-backend",
          zone: matched.name,
          risk: assessment.tier,
          riskReasons: assessment.reasons,
        };
      }
      return {
        kind: "sandbox",
        zone: matched.name,
        risk: assessment.tier,
        backendId: matched.sandboxBackendId,
        riskReasons: assessment.reasons,
      };
    },
  };
}
```

- [ ] **Step 4: Run — verify it passes**

```bash
bun --cwd packages/security/approval-zones test src/evaluator.test.ts
```
Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/approval-zones/src
git commit -m "feat(approval-zones): zone evaluator with verdict resolution"
```

---

## Task 6: Default profiles (`default-profiles.ts`)

**Files:**
- Create: `packages/security/approval-zones/src/default-profiles.ts`
- Create: `packages/security/approval-zones/src/default-profiles.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import {
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
  SCRIPTED_CLEANUP_PROFILE,
} from "./default-profiles.js";
import { createZoneEvaluator } from "./evaluator.js";
import { createDefaultRiskScorer } from "./risk-scorer.js";

const scorer = createDefaultRiskScorer({ projectRoot: "/proj" });

function q(over: Partial<PermissionQuery>): PermissionQuery {
  return {
    principal: "agent:main",
    action: "read",
    resource: "/proj/x.ts",
    ...over,
  };
}

describe("READ_ONLY_PROFILE", () => {
  const ev = createZoneEvaluator({ zones: READ_ONLY_PROFILE, scorer });
  it("auto-approves read on project files", async () => {
    expect((await ev.evaluate(q({}))).kind).toBe("auto");
  });
  it("does not auto-approve write", async () => {
    expect((await ev.evaluate(q({ action: "write" }))).kind).toBe("ask");
  });
  it("does not auto-approve read on .env", async () => {
    expect((await ev.evaluate(q({ resource: "/proj/.env" }))).kind).toBe("ask");
  });
});

describe("EDIT_TEST_FILES_PROFILE", () => {
  const ev = createZoneEvaluator({ zones: EDIT_TEST_FILES_PROFILE, scorer });
  it("auto-approves edits to .test.ts", async () => {
    expect((await ev.evaluate(q({ action: "edit", resource: "/proj/foo.test.ts" }))).kind).toBe(
      "auto",
    );
  });
  it("does not auto-approve edits to non-test files", async () => {
    expect((await ev.evaluate(q({ action: "edit", resource: "/proj/foo.ts" }))).kind).toBe("ask");
  });
});

describe("SCRIPTED_CLEANUP_PROFILE", () => {
  const ev = createZoneEvaluator({ zones: SCRIPTED_CLEANUP_PROFILE, scorer });
  it("returns sandbox verdict for bash on /tmp", async () => {
    const v = await ev.evaluate(
      q({ action: "bash", resource: "/tmp/work", context: { command: "ls /tmp/work" } }),
    );
    expect(v.kind).toBe("sandbox");
  });
  it("falls back to ask for bash outside /tmp", async () => {
    const v = await ev.evaluate(
      q({ action: "bash", resource: "/proj", context: { command: "ls /proj" } }),
    );
    expect(v.kind).toBe("ask");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
bun --cwd packages/security/approval-zones test src/default-profiles.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `default-profiles.ts`**

```ts
import type { ApprovalZone } from "./zone-types.js";

export const READ_ONLY_PROFILE: readonly ApprovalZone[] = [
  {
    name: "read-only",
    match: { tools: ["read", "glob", "grep", "ls"] },
    action: "auto",
    maxRisk: "low",
  },
];

export const EDIT_TEST_FILES_PROFILE: readonly ApprovalZone[] = [
  {
    name: "edit-test-files",
    match: {
      tools: ["write", "edit"],
      paths: ["**/*.test.ts", "**/*.test.js", "**/__tests__/**"],
    },
    action: "auto",
    maxRisk: "low",
  },
];

export const SCRIPTED_CLEANUP_PROFILE: readonly ApprovalZone[] = [
  {
    name: "scripted-cleanup",
    match: { tools: ["bash"], paths: ["/tmp/**"] },
    action: "sandbox-then-auto",
    maxRisk: "medium",
    sandboxBackendId: "default",
  },
];
```

- [ ] **Step 4: Run — verify it passes**

```bash
bun --cwd packages/security/approval-zones test src/default-profiles.test.ts
```
Expected: all pass. If a test fails because the default scorer rates `bash` higher than `medium` for harmless `ls /tmp/work`, the scorer's `bash:unknown-prefix:ls` falls under the safe-prefix list and should return `low`. If the scorer disagrees, examine `risk-scorer.ts` `scoreBash` and add `ls` to the safe-prefix allowlist (it should already be there per Task 4 step 7).

- [ ] **Step 5: Commit**

```bash
git add packages/security/approval-zones/src
git commit -m "feat(approval-zones): ship 3 default profiles"
```

---

## Task 7: Public exports + index

**Files:**
- Modify: `packages/security/approval-zones/src/index.ts`
- Create: `packages/security/approval-zones/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Write failing API-surface test**

```ts
import { describe, expect, it } from "bun:test";
import * as api from "../index.js";

describe("@koi/approval-zones public surface", () => {
  it("exports the documented value entry points", () => {
    expect(typeof api.createZoneEvaluator).toBe("function");
    expect(typeof api.createDefaultRiskScorer).toBe("function");
    expect(typeof api.matchesZone).toBe("function");
    expect(typeof api.compareRisk).toBe("function");
    expect(Array.isArray(api.READ_ONLY_PROFILE)).toBe(true);
    expect(Array.isArray(api.EDIT_TEST_FILES_PROFILE)).toBe(true);
    expect(Array.isArray(api.SCRIPTED_CLEANUP_PROFILE)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
bun --cwd packages/security/approval-zones test src/__tests__/api-surface.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Replace `src/index.ts`**

```ts
/**
 * @koi/approval-zones — convert ask verdicts into auto / sandbox / ask
 * based on configured zones + risk scoring.
 */

export {
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
  SCRIPTED_CLEANUP_PROFILE,
} from "./default-profiles.js";
export type { ZoneEvaluator, ZoneEvaluatorConfig } from "./evaluator.js";
export { createZoneEvaluator } from "./evaluator.js";
export type { DefaultRiskScorerOptions } from "./risk-scorer.js";
export { createDefaultRiskScorer } from "./risk-scorer.js";
export type { RiskAssessment, RiskInputs, RiskScorer, RiskTier } from "./risk-types.js";
export { compareRisk } from "./risk-types.js";
export { matchesZone } from "./zone-match.js";
export type { ApprovalZone, ZoneAction, ZoneMatch, ZoneVerdict } from "./zone-types.js";
```

- [ ] **Step 4: Run — verify it passes**

```bash
bun --cwd packages/security/approval-zones test
bun --cwd packages/security/approval-zones run typecheck
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/approval-zones/src
git commit -m "feat(approval-zones): public API surface"
```

---

## Task 8: Middleware bridge — wire into `@koi/middleware-permissions`

This task lives in `@koi/middleware-permissions` (not the new package) because that's where `createPermissionsMiddleware` is defined and where the sandbox-router peer dep is acceptable.

**Files:**
- Modify: `packages/security/middleware-permissions/package.json` (add deps)
- Modify: `packages/security/middleware-permissions/tsconfig.json` (add references)
- Create: `packages/security/middleware-permissions/src/zones-bridge.ts`
- Create: `packages/security/middleware-permissions/src/zones-bridge.test.ts`
- Modify: `packages/security/middleware-permissions/src/middleware.ts` (add `zones` config field; consult bridge at the ask interception point)
- Modify: `packages/security/middleware-permissions/src/config.ts` (add `zones` to the config type)

Read `packages/security/middleware-permissions/src/middleware.ts` and `handle-ask-decision.ts` first to find the precise insertion point (between persistent-approval cache hit and prompt). The hook must run AFTER persistent + session cache lookups (user-granted approvals win).

- [ ] **Step 1: Add deps**

Edit `packages/security/middleware-permissions/package.json`:
```diff
   "dependencies": {
     "@koi/bash-ast": "workspace:*",
     "@koi/bash-classifier": "workspace:*",
+    "@koi/approval-zones": "workspace:*",
     "@koi/core": "workspace:*",
     "@koi/errors": "workspace:*",
-    "@koi/hash": "workspace:*"
+    "@koi/hash": "workspace:*",
+    "@koi/sandbox-router": "workspace:*"
   }
```

Edit `packages/security/middleware-permissions/tsconfig.json` `references` to add:
```json
{ "path": "../approval-zones" },
{ "path": "../../sandbox/sandbox-router" }
```

Run `bun install`.

- [ ] **Step 2: Write failing bridge test**

Create `packages/security/middleware-permissions/src/zones-bridge.test.ts`:

```ts
import { describe, expect, it, mock } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import { createZoneEvaluator } from "@koi/approval-zones";
import type { RiskScorer } from "@koi/approval-zones";
import { applyZoneVerdict, type ZoneAuditSink } from "./zones-bridge.js";

const scorer: RiskScorer = { score: () => ({ tier: "low", reasons: [] }) };

const baseQuery: PermissionQuery = {
  principal: "agent:main",
  action: "read",
  resource: "/proj/x.ts",
};

function makeSink(): { events: { event: string; meta: unknown }[]; sink: ZoneAuditSink } {
  const events: { event: string; meta: unknown }[] = [];
  return {
    events,
    sink: { record: (event, meta) => events.push({ event, meta }) },
  };
}

describe("applyZoneVerdict", () => {
  it("returns 'allow' decision and emits zone-auto for auto verdict", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "ro", match: { tools: ["read"] }, action: "auto", maxRisk: "low" }],
      scorer,
    });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: baseQuery,
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("auto-allow");
    expect(events.map((e) => e.event)).toEqual(["zone-auto"]);
  });

  it("returns 'fall-through' and emits zone-ask-passthrough for ask verdict", async () => {
    const ev = createZoneEvaluator({ zones: [], scorer });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: baseQuery,
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events).toHaveLength(0); // no-match is silent — no zone matched
  });

  it("emits zone-ask-passthrough when matched zone over risk", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "ro", match: { tools: ["read"] }, action: "auto", maxRisk: "low" }],
      scorer: { score: () => ({ tier: "high", reasons: ["x"] }) },
    });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: baseQuery,
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events.map((e) => e.event)).toEqual(["zone-ask-passthrough"]);
  });

  it("runs sandbox preview, on success returns 'auto-allow' and emits sandbox-ok + zone-auto", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "cleanup",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
          sandboxBackendId: "default",
        },
      ],
      scorer,
    });
    const exec = mock(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      oomKilled: false,
    }));
    const destroy = mock(async () => {});
    const sandboxRouter = {
      create: mock(async () => ({
        ok: true as const,
        value: {
          instance: { exec, readFile: async () => new Uint8Array(), writeFile: async () => {}, destroy },
          decision: { selected: { name: "default" } },
        },
      })),
      describe: () => [],
      shutdown: async () => {},
    };
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: { ...baseQuery, action: "bash", context: { command: "ls /tmp" } },
      evaluator: ev,
      sandboxRouter: sandboxRouter as unknown as Parameters<typeof applyZoneVerdict>[0]["sandboxRouter"],
      auditSink: sink,
    });
    expect(result.outcome).toBe("auto-allow");
    expect(events.map((e) => e.event)).toEqual([
      "zone-sandbox-preview",
      "zone-sandbox-ok",
      "zone-auto",
    ]);
    expect(destroy).toHaveBeenCalled();
  });

  it("on sandbox failure, returns 'fall-through' and emits sandbox-failed", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "cleanup",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
          sandboxBackendId: "default",
        },
      ],
      scorer,
    });
    const exec = mock(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "err",
      durationMs: 1,
      timedOut: false,
      oomKilled: false,
    }));
    const destroy = mock(async () => {});
    const sandboxRouter = {
      create: mock(async () => ({
        ok: true as const,
        value: {
          instance: { exec, readFile: async () => new Uint8Array(), writeFile: async () => {}, destroy },
          decision: { selected: { name: "default" } },
        },
      })),
      describe: () => [],
      shutdown: async () => {},
    };
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: { ...baseQuery, action: "bash", context: { command: "ls /tmp" } },
      evaluator: ev,
      sandboxRouter: sandboxRouter as unknown as Parameters<typeof applyZoneVerdict>[0]["sandboxRouter"],
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events.map((e) => e.event)).toEqual(["zone-sandbox-preview", "zone-sandbox-failed"]);
  });

  it("on sandbox verdict without a router configured, falls through with sandbox-failed", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "cleanup",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
          sandboxBackendId: "default",
        },
      ],
      scorer,
    });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: { ...baseQuery, action: "bash", context: { command: "ls /tmp" } },
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events.map((e) => e.event)).toContain("zone-sandbox-failed");
  });
});
```

- [ ] **Step 3: Run — verify it fails**

```bash
bun --cwd packages/security/middleware-permissions test src/zones-bridge.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `zones-bridge.ts`**

```ts
import type { PermissionQuery } from "@koi/core";
import type { ZoneEvaluator, ZoneVerdict } from "@koi/approval-zones";
import type { SandboxRouter } from "@koi/sandbox-router";

export interface ZoneAuditSink {
  record(
    event:
      | "zone-auto"
      | "zone-sandbox-preview"
      | "zone-sandbox-ok"
      | "zone-sandbox-failed"
      | "zone-ask-passthrough",
    meta: ZoneAuditMeta,
  ): void;
}

export interface ZoneAuditMeta {
  readonly zoneName?: string | undefined;
  readonly riskTier?: string | undefined;
  readonly riskReasons?: readonly string[] | undefined;
  readonly reason?: string | undefined;
  readonly backendId?: string | undefined;
  readonly sandboxExitCode?: number | undefined;
}

export type ZoneOutcome = "auto-allow" | "fall-through";

export interface ApplyZoneVerdictArgs {
  readonly query: PermissionQuery;
  readonly evaluator: ZoneEvaluator;
  readonly sandboxRouter: SandboxRouter | undefined;
  readonly auditSink: ZoneAuditSink;
}

export interface ApplyZoneVerdictResult {
  readonly outcome: ZoneOutcome;
  readonly verdict: ZoneVerdict;
}

function metaFromVerdict(v: ZoneVerdict): ZoneAuditMeta {
  if (v.kind === "ask") {
    return { zoneName: v.zone, riskTier: v.risk, riskReasons: v.riskReasons, reason: v.reason };
  }
  if (v.kind === "auto") {
    return { zoneName: v.zone, riskTier: v.risk, riskReasons: v.riskReasons };
  }
  return {
    zoneName: v.zone,
    riskTier: v.risk,
    riskReasons: v.riskReasons,
    backendId: v.backendId,
  };
}

export async function applyZoneVerdict(
  args: ApplyZoneVerdictArgs,
): Promise<ApplyZoneVerdictResult> {
  const verdict = await args.evaluator.evaluate(args.query);

  if (verdict.kind === "ask") {
    if (verdict.zone !== undefined) {
      // Zone matched but bailed (risk-exceeded / non-bash-tool / missing-backend / *-error).
      args.auditSink.record("zone-ask-passthrough", metaFromVerdict(verdict));
    }
    return { outcome: "fall-through", verdict };
  }

  if (verdict.kind === "auto") {
    args.auditSink.record("zone-auto", metaFromVerdict(verdict));
    return { outcome: "auto-allow", verdict };
  }

  // sandbox
  if (args.sandboxRouter === undefined) {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: "no-router-configured",
    });
    return { outcome: "fall-through", verdict };
  }

  args.auditSink.record("zone-sandbox-preview", metaFromVerdict(verdict));

  const command =
    typeof args.query.context?.command === "string" ? (args.query.context.command as string) : "";
  if (command === "") {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: "missing-command",
    });
    return { outcome: "fall-through", verdict };
  }

  try {
    const created = await args.sandboxRouter.create({
      // Minimal profile — let the router choose any matching adapter.
      // The zone's sandboxBackendId is informational for audit; selection is by router config.
    } as Parameters<SandboxRouter["create"]>[0]);
    if (!created.ok) {
      args.auditSink.record("zone-sandbox-failed", {
        ...metaFromVerdict(verdict),
        reason: created.error.message,
      });
      return { outcome: "fall-through", verdict };
    }
    const { instance } = created.value;
    try {
      const result = await instance.exec("bash", ["-lc", command], { timeoutMs: 30_000 });
      if (result.exitCode === 0) {
        args.auditSink.record("zone-sandbox-ok", {
          ...metaFromVerdict(verdict),
          sandboxExitCode: result.exitCode,
        });
        args.auditSink.record("zone-auto", metaFromVerdict(verdict));
        return { outcome: "auto-allow", verdict };
      }
      args.auditSink.record("zone-sandbox-failed", {
        ...metaFromVerdict(verdict),
        sandboxExitCode: result.exitCode,
      });
      return { outcome: "fall-through", verdict };
    } finally {
      try {
        await instance.destroy();
      } catch {
        // destroy errors are not actionable here
      }
    }
  } catch (err) {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: err instanceof Error ? err.message : String(err),
    });
    return { outcome: "fall-through", verdict };
  }
}
```

- [ ] **Step 5: Run — verify it passes**

```bash
bun --cwd packages/security/middleware-permissions test src/zones-bridge.test.ts
```
Expected: 6 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/security/middleware-permissions
git commit -m "feat(approval-zones): zones bridge with audit + sandbox preview"
```

---

## Task 9: Wire `zones` config into `createPermissionsMiddleware`

**Files:**
- Modify: `packages/security/middleware-permissions/src/config.ts`
- Modify: `packages/security/middleware-permissions/src/middleware.ts` (or `handle-ask-decision.ts` — find the function that owns the post-ask flow)
- Create: `packages/security/middleware-permissions/src/__tests__/zones-integration.test.ts`

Before writing code: read `handle-ask-decision.ts` end-to-end. The bridge call must be inserted **after** persistent + session approval lookups and **before** the user prompt. The bridge's `auto-allow` outcome should short-circuit identically to a persistent-approval cache hit; `fall-through` should leave the existing prompt path unchanged.

- [ ] **Step 1: Find the insertion point**

```bash
grep -n "persistent\|session.*approv\|prompt" packages/security/middleware-permissions/src/handle-ask-decision.ts | head -30
```

Identify the function and line range where, after both caches miss and before the user prompt fires, the code can call into the bridge. Document the exact line range in the next step's commit message.

- [ ] **Step 2: Add `zones` field to the middleware config type**

Open `packages/security/middleware-permissions/src/config.ts`. Find the exported config interface (typically `PermissionsMiddlewareConfig`). Add:

```ts
import type { ZoneEvaluator } from "@koi/approval-zones";
import type { SandboxRouter } from "@koi/sandbox-router";

// inside the config interface:
  /**
   * Optional approval-zone integration. When set, ask verdicts that miss
   * persistent + session approvals are routed through the zone evaluator
   * before prompting the user.
   */
  readonly zones?: {
    readonly evaluator: ZoneEvaluator;
    /** Required only if any configured zone uses sandbox-then-auto. */
    readonly sandboxRouter?: SandboxRouter | undefined;
  };
```

- [ ] **Step 3: Write failing integration test**

The harness pattern is established in `persistent-approval.test.ts` — copy its helpers (`makeTurnContext`, `makeToolRequest`, `noopToolHandler`, `IS_DEFAULT_ASK_TEST`, `askBackend`) verbatim, then write the zone test.

Create `packages/security/middleware-permissions/src/__tests__/zones-integration.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionBackend, PermissionDecision } from "@koi/core/permission-backend";
import {
  READ_ONLY_PROFILE,
  createDefaultRiskScorer,
  createZoneEvaluator,
} from "@koi/approval-zones";
import { createPermissionsMiddleware } from "../middleware.js";

const IS_DEFAULT_ASK_TEST: symbol = Symbol.for("@koi/permissions/default-fallthrough-ask");

function askBackend(): PermissionBackend {
  return {
    check: (): PermissionDecision =>
      ({
        effect: "ask",
        reason: "needs approval",
        [IS_DEFAULT_ASK_TEST]: true,
      }) as PermissionDecision,
  };
}

function makeTurnContext(
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): TurnContext {
  const base = {
    session: {
      agentId: "agent:test",
      sessionId: "s-1" as never,
      runId: "r-1" as never,
      userId: "user-1",
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t-1" as never,
    messages: [] as const,
    metadata: {},
  };
  return requestApproval ? { ...base, requestApproval } : base;
}

function makeToolRequest(toolId: string, input: JsonObject = {}): ToolRequest {
  return { toolId, input };
}

const noopToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({ output: "done" });

describe("zones integration with createPermissionsMiddleware", () => {
  test("READ_ONLY_PROFILE auto-allows read without prompting", async () => {
    const evaluator = createZoneEvaluator({
      zones: READ_ONLY_PROFILE,
      scorer: createDefaultRiskScorer({ projectRoot: "/proj" }),
    });
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "deny" }));
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      zones: { evaluator },
    });
    const ctx = makeTurnContext(approvalHandler);

    // The middleware needs a way to know the resource for the read; the
    // existing extractor for the "read" toolId reads input.path. If your
    // middleware build extracts via a different key, adjust input here.
    const result = await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("read", { path: "/proj/src/foo.ts" }),
      noopToolHandler,
    );

    expect(result?.output).toBe("done");
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  test("zone risk-exceeded falls through to user prompt", async () => {
    const evaluator = createZoneEvaluator({
      zones: READ_ONLY_PROFILE,
      scorer: createDefaultRiskScorer({ projectRoot: "/proj" }),
    });
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      zones: { evaluator },
    });
    const ctx = makeTurnContext(approvalHandler);

    // .ssh path → critical → exceeds READ_ONLY_PROFILE.maxRisk=low → prompt
    await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("read", { path: "/Users/me/.ssh/id_rsa" }),
      noopToolHandler,
    );

    expect(approvalHandler).toHaveBeenCalled();
  });

  test("omitting zones config is byte-identical to pre-zones behavior (prompt fires)", async () => {
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({ backend: askBackend() });
    const ctx = makeTurnContext(approvalHandler);
    await mw.wrapToolCall?.(
      ctx,
      makeToolRequest("read", { path: "/proj/src/foo.ts" }),
      noopToolHandler,
    );
    expect(approvalHandler).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run — verify it fails**

```bash
bun --cwd packages/security/middleware-permissions test src/__tests__/zones-integration.test.ts
```
Expected: FAIL — middleware does not yet honor the `zones` config field, so the first two tests will both prompt or both auto-allow incorrectly.

Note on resource extraction: `applyZoneVerdict` builds the `PermissionQuery` from data the middleware already has when it calls the backend. Inspect how the existing middleware constructs `PermissionQuery.resource` for the `read` tool (search `handle-ask-decision.ts` and `wrap-tool-call.ts` for `resource:`) and ensure the bridge call uses the same constructed query. If the existing flow does not produce a `resource` for the `read` tool, the path-sensitivity scoring will receive `undefined` and the test will need to use a tool whose `resource` is populated. Adjust the test's tool to whichever is established in the existing test corpus (e.g. `bash`/`fs_read`) before claiming the test fails for the right reason.

- [ ] **Step 5: Wire the bridge into the ask-handling code path**

In the function identified in Step 1, after persistent-approval and session-approval cache lookups have both missed, and before the user prompt is invoked:

```ts
import { applyZoneVerdict } from "./zones-bridge.js";

// ... inside the post-cache, pre-prompt block:
if (config.zones !== undefined) {
  const result = await applyZoneVerdict({
    query,
    evaluator: config.zones.evaluator,
    sandboxRouter: config.zones.sandboxRouter,
    auditSink: {
      record: (event, meta) => emitAuditEvent("tool_call", {
        permissionEvent: event,
        ...meta,
      }),
    },
  });
  if (result.outcome === "auto-allow") {
    // Same code path as a persistent-approval cache hit: allow, do not prompt.
    return { decision: "allow" };
  }
  // fall-through: continue to existing prompt flow unchanged.
}
```

The exact `emitAuditEvent` and return-value names depend on the surrounding code — match them. Do NOT introduce a new audit channel; reuse the channel persistent-approvals already uses.

- [ ] **Step 6: Run — verify it passes**

```bash
bun --cwd packages/security/middleware-permissions test src/__tests__/zones-integration.test.ts
bun --cwd packages/security/middleware-permissions test
```
Expected: new test passes; no existing tests regress.

- [ ] **Step 7: Commit**

```bash
git add packages/security/middleware-permissions
git commit -m "feat(approval-zones): wire zones config into createPermissionsMiddleware"
```

---

## Task 10: Documentation

**Files:**
- Create: `docs/L2/security-approval-zones.md`
- Modify: `docs/L2/security-permissions.md` (append cross-link section)

- [ ] **Step 1: Create `docs/L2/security-approval-zones.md`**

Use the spec at `docs/superpowers/specs/2026-05-10-issue-1644-approval-zones-design.md` as the source. The L2 doc should cover: purpose, configuration example, zone schema reference, default profiles table, audit-event reference, error semantics. Aim for 200–400 lines, similar to `docs/L2/security-permissions.md`.

Required sections:
1. Overview (1 paragraph)
2. Configuration example (createZoneEvaluator + createPermissionsMiddleware wiring)
3. Zone schema reference (table per field)
4. Risk scoring (default scorer behavior + how to plug a custom scorer)
5. Default profiles (3-row table)
6. Audit events (table — match Spec's "Audit events" section)
7. Error / fail-safe semantics (table)
8. Limitations (sandbox-then-auto bash-only; two-execution cost; etc.)

- [ ] **Step 2: Append cross-link section to `docs/L2/security-permissions.md`**

Append a new H2 section at the end:

```markdown
---

## Approval Zones (#1644)

When the rule evaluator returns `ask` and both persistent + session approvals miss, an optional **approval-zone evaluator** can convert the verdict into auto-allow or sandbox-then-auto before the user is prompted. See `@koi/approval-zones` and `docs/L2/security-approval-zones.md`.

Zones never override `allow` or `deny` from the rule evaluator; they only intercept `ask`.
```

- [ ] **Step 3: Run docs gate (if a script exists)**

```bash
bun run check:docs 2>/dev/null || echo "no docs check script — skipping"
```

- [ ] **Step 4: Commit**

```bash
git add docs/L2/security-approval-zones.md docs/L2/security-permissions.md
git commit -m "docs(approval-zones): L2 doc + cross-link from permissions"
```

---

## Task 11: Wire into `@koi/runtime` for orphan check + golden query

CLAUDE.md requires every new L2 to be a dependency of `@koi/runtime` and to have at least one golden query.

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (add 1–2 standalone golden queries)
- Optionally: `packages/meta/runtime/scripts/record-cassettes.ts` (skip a full LLM-recorded cassette for v1 — see Step 4)

- [ ] **Step 1: Add dep + reference**

Edit `packages/meta/runtime/package.json`:
```diff
   "dependencies": {
+    "@koi/approval-zones": "workspace:*",
     ...
   }
```

Edit `packages/meta/runtime/tsconfig.json` `references`:
```diff
+    { "path": "../../security/approval-zones" },
```

Run `bun install`.

- [ ] **Step 2: Run orphan check — verify it passes**

```bash
bun run check:orphans
```
Expected: PASS (`@koi/approval-zones` is now a dep of `@koi/runtime`).

- [ ] **Step 3: Add 2 standalone golden queries**

In `packages/meta/runtime/src/__tests__/golden-replay.test.ts`, add a `describe("Golden: @koi/approval-zones", ...)` block with two test cases that use the package's pure APIs (no LLM, no network):

```ts
describe("Golden: @koi/approval-zones", () => {
  it("READ_ONLY_PROFILE auto-allows read on project files", async () => {
    const { READ_ONLY_PROFILE, createZoneEvaluator, createDefaultRiskScorer } = await import(
      "@koi/approval-zones"
    );
    const ev = createZoneEvaluator({
      zones: READ_ONLY_PROFILE,
      scorer: createDefaultRiskScorer({ projectRoot: "/proj" }),
    });
    const v = await ev.evaluate({
      principal: "agent:main",
      action: "read",
      resource: "/proj/src/foo.ts",
    });
    expect(v.kind).toBe("auto");
  });

  it("default scorer rates ~/.ssh as critical", async () => {
    const { createDefaultRiskScorer } = await import("@koi/approval-zones");
    const scorer = createDefaultRiskScorer({ projectRoot: "/proj" });
    const r = await scorer.score({
      toolId: "read",
      args: {},
      resource: "/Users/me/.ssh/id_rsa",
    });
    expect(r.tier).toBe("critical");
  });
});
```

- [ ] **Step 4: Run check:golden-queries**

```bash
bun run check:golden-queries
```
Expected: PASS. If it fails because the script demands a recorded cassette, add a `QueryConfig` entry to `packages/meta/runtime/scripts/record-cassettes.ts` for a `zone-auto` query, but **defer the actual recording** to a follow-up issue (it requires a live OPENROUTER_API_KEY). Add a TODO comment in record-cassettes.ts:

```ts
// TODO(#1644 follow-up): record fixtures/zone-auto.cassette.json with a real LLM run.
```

- [ ] **Step 5: Run full L2 + runtime test suite**

```bash
bun --cwd packages/security/approval-zones test
bun --cwd packages/security/middleware-permissions test
bun test packages/meta/runtime/src/__tests__/golden-replay.test.ts -t "Golden: @koi/approval-zones"
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/meta/runtime
git commit -m "feat(approval-zones): wire into @koi/runtime + golden queries"
```

---

## Task 12: Final CI gate + PR

- [ ] **Step 1: Run the full CI gate**

```bash
bun run typecheck
bun run lint
bun run check:layers
bun run check:orphans
bun run check:golden-queries
bun run check:unused
bun run check:duplicates
bun run test --filter "@koi/approval-zones"
bun run test --filter "@koi/middleware-permissions"
bun run test --filter "@koi/runtime"
```

Each must pass. If any fail, fix the underlying issue before continuing — do not weaken tests or skip checks.

- [ ] **Step 2: Verify diff size**

```bash
git diff --stat main...HEAD | tail -1
```
Expect well under the 1,500-line PR ceiling. If over, propose splitting Task 11 into a follow-up PR.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin worktree-issue-1644-approval-zones
gh pr create --title "feat(approval-zones): smart approval zones with sandboxed execution (#1644)" --body "$(cat <<'EOF'
## Summary
- New `@koi/approval-zones` L2 package: zone schema (auto / ask / sandbox-then-auto), default risk scorer (path + tool + bash AST), 3 default profiles (read-only, edit-test-files, scripted-cleanup)
- Bridge inside `@koi/middleware-permissions`: optional `zones` config; intercepts `ask` after persistent + session lookups, before user prompt
- Sandbox-then-auto runs preview via `@koi/sandbox-router` (bash tools only in v1; non-bash falls through to ask)
- Audit events: `zone-auto`, `zone-sandbox-preview`, `zone-sandbox-ok`, `zone-sandbox-failed`, `zone-ask-passthrough`
- Wired into `@koi/runtime` with 2 standalone golden queries
- Docs: new `docs/L2/security-approval-zones.md` + cross-link from `security-permissions.md`

Closes #1644.

Spec: `docs/superpowers/specs/2026-05-10-issue-1644-approval-zones-design.md`
Plan: `docs/superpowers/plans/2026-05-10-issue-1644-approval-zones.md`

## Test plan
- [ ] `bun --cwd packages/security/approval-zones test` passes
- [ ] `bun --cwd packages/security/middleware-permissions test` passes (no regressions)
- [ ] `bun run check:layers` / `check:orphans` / `check:golden-queries` pass
- [ ] Manual: build a zone config in a sample app, verify a read on a project file is auto-approved without prompt and emits `zone-auto` audit event

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Acceptance-criteria mapping

| Issue criterion | Plan task |
|------|----|
| Zone schema with ≥ 3 actions | Task 2 (`ZoneAction` union) |
| Sandbox-then-auto runs in isolated executor and merges atomically | Task 8 (preview model: side effects discarded; tool re-runs on host) |
| Risk scoring uses bash AST + path patterns | Task 4 |
| Auto-approve emits audit event | Task 8 (`zone-auto`) + Task 9 (wired into middleware audit channel) |
| At least 3 default profiles shipped | Task 6 |
| Tests cover all 3 actions + risk score computation | Tasks 4, 5, 6 |
| Documented in `docs/L2/security-permissions.md` | Task 10 (new file + cross-link) |

## Out-of-scope (filed as follow-ups if needed after merge)

- Recording a real LLM cassette for `zone-auto` (Task 11 step 4 TODO)
- Wrapping non-bash tools in sandbox-then-auto (requires tool-host runtime inside sandbox)
- Cross-session learned zones (separate concept from configured zones)
- ML-based risk classifier
