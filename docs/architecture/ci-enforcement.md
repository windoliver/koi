# CI Enforcement & Architecture Guardrails

This document describes the automated checks that enforce Koi's four-layer architecture and
manifest safety constraints. All checks run on every pull request.

---

## Layer Boundary Enforcement

### Why

The four-layer system (`L0 → L0u → L1 → L2 → L3`) is only valuable if the boundaries are
machine-checked. Without enforcement, a single transitive import from an L2 feature package
into L0 core would erode the kernel's guarantee of zero dependencies.

### How it works

**`scripts/layers.ts`** is the single source of truth for which package belongs to which layer.
Both the enforcement script and the detect script import from it — there is no other place where
layer membership is defined.

```
scripts/layers.ts          ← canonical layer sets (L0_PACKAGES, L0U_PACKAGES, L1_PACKAGES, L3_PACKAGES)
scripts/check-layers.ts    ← enforcement (package.json deps + source-file imports)
scripts/check-layers.test.ts
```

**`scripts/check-layers.ts`** runs four kinds of checks:

| # | Check | What it validates |
|---|-------|------------------|
| 1 | `package.json` dep check | Each package's declared deps obey the layer rules below |
| 2 | L0 source import scan | `@koi/core` source never imports an external module |
| 3 | L2 source import scan | L2 non-test source never imports from L1 (`@koi/engine`) |
| 4 | L0 anti-leak audit | `@koi/core` has zero class declarations and no unlisted function bodies |

#### Layer dependency rules (package.json)

| Layer | Runtime deps allowed | Dev deps allowed |
|-------|---------------------|-----------------|
| L0 `@koi/core` | none | none |
| L0u utility packages | L0 + peer L0u | — |
| L1 `@koi/engine` | L0 + L0u | — |
| L2 feature packages | L0 + L0u | L0, L0u, L1, L2 (for tests) |
| L3 meta-packages | any | any |

#### Source-file import rules

- **L0 source** (`packages/core/src/**/*.ts`): every import must be a relative path (`./` or `../`).
  Any external specifier (npm package, `@koi/*`, Node built-in) is a violation.
- **L2 source** (non-test files): must not import from `@koi/engine`.
  Test files (`.test.ts`, `.spec.ts`, `__tests__/`) are exempt.

The scanner uses **`Bun.Transpiler` AST** (not regex) so commented-out imports are never
flagged. A regex supplement captures `import type` statements that the transpiler elides.

#### L0 anti-leak audit (class & function body enforcement)

`@koi/core` is an interfaces-only kernel. The anti-leak audit enforces two rules on every
non-test `.ts` file in `packages/core/src/`:

| Rule | Policy | Exceptions |
|------|--------|------------|
| **No class declarations** | `class`, `export class`, `abstract class` — all forbidden | None |
| **No function bodies** | `function`, `export function`, `export const x = (` — all forbidden | Files listed in `L0_RUNTIME_ALLOWLIST` |

**`L0_RUNTIME_ALLOWLIST`** is a `ReadonlySet<string>` of 24 files that legitimately contain
function bodies. Every function in these files falls into one of the architecture doc's L0
exceptions:

- Branded type constructors (identity casts like `agentId()`, `sessionId()`)
- Pure type guards (`isProcessState()`, `isAgentStateEvent()`)
- Validation helpers (`validateNonEmpty()`)
- Error factories (`notFound()`, `timeout()`, etc.)
- Pure mapping functions (`mapStopReasonToOutcome()`)
- ComponentProvider factories (`createServiceProvider()`, `createSingleToolProvider()`)

**Adding a new file to the allowlist** requires a PR review to confirm all functions meet
L0 criteria (pure, side-effect-free, operating only on L0 types).

**Detection**: Line-level regex on trimmed, non-comment lines. Comment lines (`//`, `*`,
`/*`) are skipped. The scan short-circuits once both flags (class found, function found)
are set for a given file.

### Running the check

```bash
# Standalone
bun scripts/check-layers.ts

# Via Turborepo (content-hash cached)
bun run check:layers
```

The Turborepo task caches on:
- `packages/*/package.json`
- `packages/*/src/**/*.ts`
- `scripts/layers.ts`

Cache is invalidated whenever any of those files change.

### CI integration

The check runs as a dedicated step in `.github/workflows/ci.yml`, **after Lint and before Build**:

```yaml
- name: Check layer boundaries
  run: bun run check:layers
```

A violation blocks the build immediately, before any compilation or test run.

---

## Layer Classification

The canonical layer membership is defined in `scripts/layers.ts`:

| Constant | Packages |
|----------|----------|
| `L0_PACKAGES` | `@koi/core` |
| `L0U_PACKAGES` | 24 utility packages (acp-protocol, channel-base, crypto-utils, dashboard-types, edit-match, errors, event-delivery, execution-context, file-resolution, git-utils, harness-scheduler, hash, manifest, nexus-client, resolve, sandbox-cloud-base, scope, shutdown, skill-scanner, snapshot-chain-store, sqlite-utils, test-utils, token-estimator, validation) |
| `L1_PACKAGES` | `@koi/engine` |
| `L3_PACKAGES` | autonomous, cli, context-arena, governance, starter |

Any package not in L0, L0u, L1, or L3 is treated as **L2** by the enforcement script.

**To add a new package to a layer:** edit `scripts/layers.ts` only. The enforcement script and any
future tooling (detect-layer, CI matrix) pick up the change automatically.

---

## Manifest Template-Syntax Guard

### Why

Manifest YAML files are declarative agent definitions. Accepting Jinja-style (`{{model}}`) or
Django-style (`{%if%}`) template expressions in string fields would introduce a silent
class of failures: manifests that look valid but break at parse time depending on the
rendering environment.

### How it works

`packages/manifest/src/schema.ts` wraps key string fields with a Zod `.refine()` that rejects
any value matching `/\{\{|\{%/`:

```typescript
// Rejects {{ and {% — single-brace {region} is intentionally allowed
function noTemplateExpressions(schema: z.ZodString): z.ZodEffects<z.ZodString, string, string> {
  return schema.refine(
    (val) => !TEMPLATE_EXPR_RE.test(val),
    "Manifest does not support template expressions ({{...}} or {%...%}). Use static values only.",
  );
}
```

**Fields guarded:**
- `manifest.name`
- `manifest.model` (string shorthand and `model.name` object form)
- Tool, middleware, and skill `name` fields
- Channel `name` field

**Intentionally not guarded:** free-text fields like `description`, `soul`, `user`, and
`context` — these may legitimately contain prose that includes curly braces.

**Single-brace format strings** like `"custom-model-{region}"` are allowed. The regex only
triggers on `{{` and `{%`.

---

## PR Labeling by Layer

Every pull request is automatically labeled with the deepest layer it touches:

| Label | Files matched |
|-------|--------------|
| `layer:L0` | `packages/core/**` |
| `layer:L1` | `packages/engine/**` |
| `layer:L3` | `packages/cli/**`, `packages/starter/**` |
| `layer:L2` | `packages/**` (catch-all) |

The labeler runs via `.github/workflows/label-layers.yml` using `actions/labeler@v5` pinned to
its commit SHA for supply-chain safety.

---

## L0 Reviewer Gating

`@koi/core` changes require mandatory review. `.github/CODEOWNERS` assigns `packages/core/`
to `@taofeng`. GitHub branch protection should be configured to require 2 reviews for PRs
carrying the `layer:L0` label or touching `packages/core/`.

---

## Adding a New Package

1. Create the package under `packages/<name>/`.
2. If it is L0u-eligible (pure utility, no L1 deps), add it to `L0U_PACKAGES` in `scripts/layers.ts`.
3. If it is an L3 meta-package, add it to `L3_PACKAGES`.
4. All other packages are automatically L2 — no registration needed.
5. Run `bun run check:layers` to confirm zero violations.
