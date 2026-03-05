# @koi/governance — Enterprise Compliance Bundle

Layer 3 meta-package that assembles up to 11 middleware and 4 scope providers
into a single `createGovernanceStack()` call.

## What This Enables

**One-line enterprise compliance.** Instead of manually importing, configuring,
and ordering 11 separate middleware packages, callers get:

- **Deployment presets** (`open`, `standard`, `strict`) with sensible defaults
- **3-layer config merge**: defaults → preset → user overrides
- **Scope enforcement**: filesystem, browser, credentials, memory — each wrapped
  with enforcer + scoping + audit
- **Pattern-based permissions shorthand**: `permissionRules: { allow: [...] }`
  instead of constructing a full `PermissionBackend`
- **Cost/budget governance**: `pay` middleware for token budget enforcement
- **OWASP ASI01 defense**: `intentCapsule` cryptographically binds the agent's
  mandate at session start and verifies integrity on every model call
- **Human escalation**: `delegationEscalation` pauses the engine loop and asks
  a human for instructions when all delegatee circuit breakers are open

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

// With intent-capsule (ASI01 defense) + delegation escalation
const governed = createGovernanceStack({
  preset: "standard",
  intentCapsule: {
    systemPrompt: manifest.model.options.system,
    objectives: ["Process invoices", "Generate reports"],
  },
  delegationEscalation: {
    channel: humanChannel,
    isExhausted: () => manager.isExhausted(workerIds),
    issuerId: agentId("supervisor"),
    monitoredDelegateeIds: workerIds,
    taskSummary: "Batch invoice processing",
  },
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: governed.middlewares,
  providers: governed.providers,
});
```

## Middleware Priority Order

| Priority | Middleware | Phase | Description |
|----------|-----------|-------|-------------|
| 100 | permissions | intercept | Coarse-grained tool allow/deny/ask |
| 110 | exec-approvals | intercept | Progressive command allowlisting |
| 120 | delegation | intercept | Delegation grant verification |
| 125 | capability-request | intercept | Pull-model delegation requests |
| 130 | delegation-escalation | intercept | Human escalation on delegatee exhaustion |
| 150 | governance-backend | intercept | Pluggable policy evaluation gate |
| 200 | pay | resolve | Cost/budget governance |
| 290 | intent-capsule | intercept | Cryptographic mandate binding (ASI01) |
| 300 | audit | observe | Compliance audit logging |
| 340 | pii | resolve | PII detection and redaction |
| 350 | sanitize | resolve | Content sanitization |
| 375 | guardrails | resolve | Output schema validation |

## New Middleware (v0.x)

### Intent Capsule (priority 290)

Implements **OWASP ASI01 (Agentic Goal Hijacking)** defense:

1. **Session start**: signs the agent's mandate (system prompt + objectives) with Ed25519
2. **Every model call**: verifies mandate integrity via hash comparison (no crypto on hot path)
3. **Session end**: cleanup + TTL eviction

This prevents prompt injection attacks from silently altering an agent's core
mission during a long-running session. If the mandate hash changes, the
middleware rejects the model call with a clear error.

```typescript
const stack = createGovernanceStack({
  intentCapsule: {
    systemPrompt: "You are an invoice processor. Never execute code.",
    objectives: ["Parse invoices", "Extract line items"],
    injectMandate: true,  // re-inject mandate as system message on every call
  },
});
```

**Not included in presets** — requires deployment-specific config (system prompt).

### Delegation Escalation (priority 130)

Human escalation when **all delegatee circuit breakers are open**:

1. Detects exhaustion via the `isExhausted` callback
2. Pauses the engine loop
3. Sends a structured escalation message to the human via `ChannelAdapter`
4. Waits for human response: `resume` (optionally with new instructions) or `abort`

The `DelegationEscalationHandle` returned on the bundle provides:
- `isPending()` — check if an escalation is awaiting response
- `cancel()` — abort a pending escalation programmatically

```typescript
const { delegationEscalationHandle } = createGovernanceStack({
  delegationEscalation: {
    channel: slackChannel,
    isExhausted: () => manager.allExhausted(workerIds),
    issuerId: agentId("supervisor"),
    monitoredDelegateeIds: workerIds,
    taskSummary: "Batch data processing",
    escalationTimeoutMs: 300_000, // 5 min (default: 10 min)
    onEscalation: (decision) => telemetry.track("escalation", decision),
  },
});

// Later: check if waiting for human
if (delegationEscalationHandle?.isPending()) {
  console.log("Waiting for human response...");
}
```

**Not included in presets** — requires deployment-specific config (channel, agent IDs).

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

Fields excluded from preset resolution (require explicit config):
- `intentCapsule` — deployment-specific system prompt
- `delegationEscalation` — deployment-specific channel + agent IDs

### Validation Rules

- `permissions` and `permissionRules` are mutually exclusive (throws)
- `capabilityRequest` requires `delegationBridge` (throws with actionable message)

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
  readonly disposables: readonly Disposable[];
  readonly nexusHooks?: NexusDelegationHooks;
  readonly sessionStore?: SessionRevocationStore;
  readonly delegationEscalationHandle?: DelegationEscalationHandle;
}

interface ResolvedGovernanceMeta {
  readonly preset: GovernancePreset;
  readonly middlewareCount: number;
  readonly providerCount: number;
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
- L2: `@koi/filesystem`, `@koi/tool-browser`, 11 middleware packages
