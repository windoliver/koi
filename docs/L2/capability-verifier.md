# @koi/capability-verifier — Pluggable Capability Token Verification

Verifies capability tokens with support for HMAC-SHA256 and Ed25519 signatures, session-scoped revocation, delegation chain verification, and pluggable scope checking. Auto-wired by `@koi/governance` when delegation is configured.

---

## Why It Exists

1. **Multiple proof types.** Agents may use shared-secret (HMAC) or asymmetric (Ed25519) signing depending on trust model. A single verifier interface routes to the correct implementation.

2. **Session revocation.** When a session ends or is compromised, all tokens scoped to that session must be denied immediately — without revoking each grant individually.

3. **Chain depth enforcement.** Re-delegated tokens must not exceed the maximum chain depth set by the original issuer.

4. **Resource pattern matching.** Flat allow/deny lists are insufficient when tokens carry resource patterns like `read_file:/workspace/**`. Pluggable scope checking enables glob matching through the governance stack.

---

## What This Enables

### Before (legacy delegation-only path)

```
Tool call → delegation middleware → HMAC signature check → flat allow/deny → pass/deny
```

- Only HMAC-SHA256 signatures
- No session-scoped revocation
- No resource pattern matching
- No Ed25519 agent-to-agent chains

### After (capability verifier path)

```
Tool call → delegation middleware → map grant to token
  → composite verifier routes by proof.kind:
    ├── hmac-sha256 → HMAC verifier (timing-safe comparison)
    └── ed25519     → Ed25519 verifier (asymmetric signature)
  → Check order:
    1. Proof type supported?
    2. Signature valid?
    3. Token expired?
    4. Session still active?
    5. Chain depth within limit?
    6. Tool allowed by scope? (pluggable ScopeChecker)
  → pass/deny with specific DelegationDenyReason
```

### Governance auto-wiring (zero config)

```typescript
import { createGovernanceStack } from "@koi/governance";

// Verifier auto-wires when delegation is configured — any preset
const { middlewares, providers, sessionStore } = createGovernanceStack({
  preset: "standard",
  delegation: {
    secret: "my-hmac-secret-32-bytes-minimum!",
    registry: myRevocationRegistry,
    grantStore: myGrantStore,
  },
});

// Session revocation: all tokens scoped to this session are denied
sessionStore?.revoke(sessionId("compromised-session"));
```

### Manual wiring

```typescript
import { createDelegationMiddleware } from "@koi/delegation";
import { createCapabilityVerifier } from "@koi/capability-verifier";

const verifier = createCapabilityVerifier({
  hmacSecret: SECRET,
  scopeChecker: myScopeChecker,  // optional: enables resource patterns
});

const mw = createDelegationMiddleware({
  secret: SECRET,
  registry,
  grantStore,
  verifier,
  activeSessionIds: myActiveSessionSet,
});
```

---

## Architecture

### Layer

`@koi/capability-verifier` is an **L2 feature package**. It imports only from `@koi/core` (L0) and `@koi/crypto-utils` (L0u).

### Module Map

```
src/
├── composite-verifier.ts   Routes by proof.kind, optional cache
├── hmac-verifier.ts        HMAC-SHA256 verification (timing-safe)
├── ed25519-verifier.ts     Ed25519 asymmetric signature verification
├── chain-verifier.ts       Delegation chain + batch revocation checking
├── scope-check.ts          Shared scope checking (pluggable ScopeChecker + built-in)
├── attenuation.ts          Permission subset validation (re-exports from @koi/core)
├── session-revocation.ts   In-memory session revocation store
└── index.ts                Public exports
```

### Key Components

| Component | Type | Purpose |
|-----------|------|---------|
| `createCapabilityVerifier` | Factory | Creates a `CompositeVerifier` that routes by proof.kind |
| `createHmacVerifier` | Factory | HMAC-SHA256 proof verification with timing-safe comparison |
| `createEd25519Verifier` | Factory | Ed25519 signature verification using embedded public key |
| `createChainVerifier` | Factory | Verifies delegation chains with batch revocation checking |
| `createSessionRevocationStore` | Factory | In-memory session tracking with `revoke()` / `snapshot()` |
| `createInMemoryVerifierCache` | Factory | LRU cache (1024 entries) keyed by `(tokenId, toolId)` |

---

## Verification Order

All verifiers enforce the same check order for consistent deny reasons:

| # | Check | Deny Reason | Notes |
|---|-------|-------------|-------|
| 1 | Proof type | `proof_type_unsupported` | Routes to correct verifier |
| 2 | Signature | `invalid_signature` | Checked before expiry to fail fast on tampered tokens |
| 3 | Expiry | `expired` | `expiresAt <= now` (boundary: equals = expired) |
| 4 | Session | `session_invalid` | `sessionId` must be in `activeSessionIds` |
| 5 | Chain depth | `chain_depth_exceeded` | `chainDepth > maxChainDepth` |
| 6 | Scope | `scope_exceeded` | Pluggable ScopeChecker or built-in allow/deny |

---

## Scope Checking

### Built-in (default)

When no `ScopeChecker` is provided, the verifier uses flat allow/deny matching:

- `"*"` in allow list matches any tool
- Tool name matched before `:` (resource path separator)
- Deny overrides allow

### Pluggable ScopeChecker

When wired through governance, `defaultScopeChecker` from `@koi/delegation` enables resource pattern matching:

```typescript
// Grant with resource patterns
grant({ permissions: { allow: ["read_file"] }, resources: ["read_file:/workspace/**"] });

// Tool call: read_file with path /workspace/src/main.ts → allowed
// Tool call: read_file with path /etc/passwd → denied (scope_exceeded)
```

The `ScopeChecker` interface supports sync and async implementations:
```typescript
interface ScopeChecker {
  readonly isAllowed: (toolId: string, scope: DelegationScope) => boolean | Promise<boolean>;
}
```

---

## Chain Verification

`createChainVerifier` wraps a base verifier and adds delegation chain checks:

1. Walks the parent chain via `parentId` references
2. Batch revocation check (`isRevokedBatch` when available, sequential fallback)
3. Permission attenuation validation (child scope must be subset of parent)

### Fail-Closed Error Handling

- Batch revocation error → falls back to sequential `isRevoked()` calls
- Sequential revocation error → token treated as revoked (fail-closed)
- This ensures infrastructure failures deny access rather than grant it

---

## Caching

`createInMemoryVerifierCache` provides an optional verification result cache:

- Key: `(tokenId, toolId)` with null byte separator (prevents key collision)
- Capacity: 1024 entries with LRU eviction
- `evict(tokenId)` removes all entries for a token (called on revocation)
- Caches both positive and negative results

---

## Session Revocation

`createSessionRevocationStore` tracks active sessions:

```typescript
const store = createSessionRevocationStore();

// Record a session as active
store.recordSession(sessionId("session-1"));

// Get current active sessions (for VerifyContext.activeSessionIds)
const active: ReadonlySet<SessionId> = store.snapshot();

// Revoke a session — all tokens scoped to it are denied
store.revokeSession(sessionId("session-1"));
```

When auto-wired by governance, the store's `snapshot()` is passed as a lazy `activeSessionIds` function to the delegation middleware.

---

## Configuration

### CompositeVerifierConfig

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `hmacSecret` | Yes | — | HMAC-SHA256 signing secret |
| `cache` | No | `undefined` | Optional `VerifierCache` for result caching |
| `scopeChecker` | No | `undefined` | Pluggable scope checker (enables resource patterns) |

---

## Testing

- **117 tests** across 6 test files
- **Coverage**: 98%+ lines across all source files
- Key test areas:
  - All 6 deny reasons + ok path for both HMAC and Ed25519
  - Cache hit/miss/evict, key collision regression
  - Chain depth, attenuation, batch revocation
  - Fail-closed error handling (registry errors)
  - ScopeChecker injection (sync + async)
  - Composite routing by proof.kind

---

## References

- `@koi/core` — L0 types: `CapabilityToken`, `CapabilityVerifier`, `VerifyContext`, `ScopeChecker`
- `@koi/crypto-utils` — Canonicalization, Ed25519 verification
- `@koi/delegation` — Delegation middleware integration, `mapGrantToCapabilityToken`
- `@koi/governance` — Auto-wiring via `createGovernanceStack`
