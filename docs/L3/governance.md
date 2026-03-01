# @koi/governance — Enterprise Compliance Bundle

Layer 3 meta-package that assembles up to 9 middleware and 4 scope providers
into a single `createGovernanceStack()` call.

## What This Enables

**One-line enterprise compliance.** Instead of manually importing, configuring,
and ordering 9 separate middleware packages, callers get:

- **Deployment presets** (`open`, `standard`, `strict`) with sensible defaults
- **3-layer config merge**: defaults → preset → user overrides
- **Scope enforcement**: filesystem, browser, credentials, memory — each wrapped
  with enforcer + scoping + audit
- **Pattern-based permissions shorthand**: `permissionRules: { allow: [...] }`
  instead of constructing a full `PermissionBackend`
- **Pay deprecation path**: `pay` still works but emits `console.warn`

## Quick Start

```typescript
import { createGovernanceStack } from "@koi/governance";
import { createKoi } from "@koi/engine";

// Minimal — open preset, all tools allowed
const { middlewares, providers, config } = createGovernanceStack({});

// Standard — PII masking, sanitization, filesystem + browser scope
const stack = createGovernanceStack({
  preset: "standard",
  backends: { filesystem: myFsBackend, browser: myBrowserDriver },
});

// Strict — PII redaction, guardrails, read-only filesystem, HTTPS-only browser
const strict = createGovernanceStack({
  preset: "strict",
  audit: { sink: myAuditSink },
  backends: { filesystem: myFsBackend },
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: stack.middlewares,
  providers: stack.providers,
});
```

## Middleware Priority Order

| Priority | Middleware | Description |
|----------|-----------|-------------|
| 100 | permissions | Coarse-grained tool allow/deny/ask |
| 110 | exec-approvals | Progressive command allowlisting |
| 120 | delegation | Delegation grant verification |
| 150 | governance-backend | Pluggable policy evaluation gate |
| 200 | pay | Token budget enforcement (deprecated) |
| 300 | audit | Compliance audit logging |
| 340 | pii | PII detection and redaction |
| 350 | sanitize | Content sanitization |
| 375 | guardrails | Output schema validation |

## Deployment Presets

### `open` (default)

- Permissions: allow all (`["*"]`)
- No middleware beyond permissions
- No scope enforcement

### `standard`

- Permissions: allow fs_read, web, browser, lsp; deny fs_delete; ask runtime
- PII: mask strategy
- Sanitize: enabled (empty rules)
- Scope: filesystem (rw) + browser (block private addresses)

### `strict`

- Permissions: allow fs_read only; deny runtime, fs_delete, db_write
- PII: redact strategy
- Sanitize: enabled
- Guardrails: enabled
- Scope: filesystem (ro) + browser (HTTPS only, block private) + credentials + memory

## Config Resolution

The 3-layer merge works as follows:

1. **Defaults**: base config (empty)
2. **Preset**: `GOVERNANCE_PRESET_SPECS[preset]` fills in unset fields
3. **User overrides**: explicit config fields always win

### Validation Rules

- `permissions` and `permissionRules` are mutually exclusive (throws)
- `execApprovals` requires an `onAsk` handler (throws)
- `pay` emits a deprecation warning via `console.warn`

## Scope Wiring

When `scope` and `backends` are both provided, the factory wires
`ComponentProvider`s for each configured subsystem:

| Subsystem | Scope Config | Backend |
|-----------|-------------|---------|
| Filesystem | `scope.filesystem` | `backends.filesystem` |
| Browser | `scope.browser` | `backends.browser` |
| Credentials | `scope.credentials` | `backends.credentials` |
| Memory | `scope.memory` | `backends.memory` |

Each backend is optionally wrapped with:
1. **Enforcer** (`ScopeEnforcer`) — pluggable policy (ReBAC, ABAC)
2. **Scoping** — local checks (path containment, pattern matching)
3. **Audit** — when `backends.auditSink` is available

Missing backends for a configured scope are gracefully skipped.

## Return Shape

```typescript
interface GovernanceBundle {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly config: ResolvedGovernanceMeta;
}

interface ResolvedGovernanceMeta {
  readonly preset: GovernancePreset;
  readonly middlewareCount: number;
  readonly providerCount: number;
  readonly payDeprecated: boolean;
  readonly scopeEnabled: boolean;
}
```

## Architecture

```
@koi/governance (L3)
  ├── types.ts              — GovernanceStackConfig, presets, bundle types
  ├── presets.ts             — GOVERNANCE_PRESET_SPECS (frozen)
  ├── config-resolution.ts   — 3-layer merge + validation
  ├── scope-wiring.ts        — scope config → ComponentProviders
  ├── governance-stack.ts     — createGovernanceStack() factory
  └── index.ts               — public API surface
```

Dependencies:
- L0: `@koi/core` (types)
- L0u: `@koi/scope` (enforcer, scoping)
- L2: `@koi/filesystem`, `@koi/tool-browser`, 9 middleware packages
