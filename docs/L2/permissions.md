# @koi/permissions — rule-based tool access control

Implements the L0 `PermissionBackend` contract with glob-based rules, multi-source
config precedence, and permission modes (default/bypass/plan/auto).

---

## Why it exists

Agents need deterministic, configurable tool access decisions before every tool call.
Rules come from multiple sources (operator policy, project config, user prefs) with
clear precedence. Permission modes let the harness switch behavior for plan-mode,
bypass, or classifier-driven auto-approval.

---

## Architecture

### Layer position

```
L2  @koi/permissions
    depends on: @koi/core, @koi/errors, @koi/validation
```

### Internal module map

```
src/
  index.ts                        public re-exports
  rule-types.ts                   PermissionRule, SourcedRule, PermissionMode, PermissionConfig
  rule-evaluator.ts               evaluateRules() — glob + action matching, first-match-wins
  rule-loader.ts                  loadRules() — multi-source precedence + Zod validation
  mode-resolver.ts                resolveMode() — mode to decision behavior mapping
  create-permission-backend.ts    createPermissionBackend() — PermissionBackend factory
```

---

## API

### Types

```typescript
type PermissionMode = "default" | "bypass" | "plan" | "auto";
type RuleSource = "policy" | "project" | "local" | "user";

interface PermissionRule {
  readonly pattern: string;       // glob pattern matched against resource
  readonly action: string;        // action name or "*" for all
  readonly effect: "allow" | "deny" | "ask";
  readonly principal?: string;    // glob matched against query.principal (omit = match all)
  readonly context?: Record<string, string>; // key-value glob predicates on query.context
  readonly reason?: string;
}

interface SourcedRule extends PermissionRule {
  readonly source: RuleSource;
}

interface PermissionConfig {
  readonly mode: PermissionMode;
  readonly rules: readonly SourcedRule[];
}
```

### Functions

| Function | Signature | Purpose |
|----------|-----------|---------|
| `createPermissionBackend` | `(config: PermissionConfig) => PermissionBackend` | Factory — main entry point |
| `evaluateRules` | `(query, rules) => PermissionDecision` | Glob match + first-match-wins |
| `loadRules` | `(sources: ReadonlyMap<RuleSource, readonly PermissionRule[]>) => readonly SourcedRule[]` | Merge + validate + sort by precedence |
| `resolveMode` | `(mode, query, rules) => PermissionDecision` | Mode-driven decision routing |

---

## Permission modes

| Mode | Behavior |
|------|----------|
| `default` | Evaluate rules; fallback to `ask` |
| `bypass` | Always allow (CI, trusted automation) |
| `plan` | Evaluate rules for reads/discover; deny writes unconditionally. Unmatched reads return `ask`. Configure allow rules for expected read paths |
| `auto` | Evaluate rules; fallback to `ask` (classifier in #1236 may promote to `allow`) |

## Rule precedence

Rules are ordered by source: **policy > project > local > user**. First matching rule wins.

---

## Examples

```typescript
import { createPermissionBackend, loadRules } from "@koi/permissions";

const result = loadRules(new Map([
  ["policy", [{ pattern: "/etc/**", action: "*", effect: "deny", reason: "system files" }]],
  ["project", [{ pattern: "src/**", action: "write", effect: "allow" }]],
  ["user", [{ pattern: "**", action: "read", effect: "allow" }]],
]));
if (!result.ok) throw new Error(result.error.message);

const backend = createPermissionBackend({ mode: "default", rules: result.value });

backend.check({ principal: "agent-1", action: "write", resource: "src/index.ts" });
// { effect: "allow" }

// Zone-scoped discovery rule (key must match what callers send)
const discoverResult = loadRules(new Map([
  ["policy", [{
    pattern: "agent:**",
    action: "discover",
    effect: "allow",
    context: { callerZoneId: "us-east-*" }, // matches visibility-filter's context key
  }]],
]));
```

---

## Caller contract

**Resource paths**: Callers must supply canonical resource identifiers. For filesystem
paths, resolve symlinks before constructing the query — the evaluator performs lexical
normalization only (`.` and `..` resolution) and cannot detect symlink escapes.

**Context keys**: Context predicates use exact key matching. Known context keys used
by existing callers:
- `callerZoneId` — set by `createVisibilityFilter()` for zone-scoped agent discovery

---

## Testing

- Glob pattern matching (exact, `*`, `**`, terminal `/**` matches directory root)
- Action exact + wildcard matching
- First-match-wins ordering
- Source precedence (policy overrides user)
- Principal glob matching
- Context predicate glob matching (zone-scoped discovery)
- Path traversal prevention (`..'` rejection, normalization)
- Mode behavior (bypass/plan/default/auto)
- Contract compliance: satisfies `PermissionBackend`

---

## Layer compliance

```
L2 @koi/permissions
    imports: @koi/core (L0), @koi/errors (L0u), @koi/validation (L0u)
    does not import: @koi/engine (L1), any peer L2
```

---

## References

- L0 contract: `packages/kernel/core/src/permission-backend.ts`
- Tracking issue: #1185
- This sub-issue: #1235
- Middleware + classifier: #1236
