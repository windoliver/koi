# @koi/governance-delegation — Capability Tokens & Delegation

L2 library that implements the L0 capability + delegation contracts in
`packages/kernel/core/src/capability.ts` and `delegation.ts`.

## Position in the layer architecture

- L0 contracts: `CapabilityToken`, `CapabilityProof`, `CapabilityScope`,
  `CapabilityVerifier`, `VerifyContext`, `CapabilityVerifyResult`,
  `ScopeChecker`, `isPermissionSubset`.
- This package: signers, verifiers, revocation registry, issuance helpers.
- No middleware in this package (separate follow-up).

## Public API

- `createCapabilityVerifier(opts)` — composite verifier dispatching on
  `proof.kind`. Accepts HMAC secret and/or Ed25519 public-key map, a
  required `ScopeChecker`, and an optional `CapabilityRevocationRegistry`.
- `createGlobScopeChecker()` — default `ScopeChecker` matching `permissions.allow`/`deny`.
- `issueRootCapability(opts)` — produces a signed root `CapabilityToken`.
- `delegateCapability(opts)` — produces a signed child `CapabilityToken`
  after verifying attenuation, chain depth, and parent expiry. Returns
  `Result<CapabilityToken, KoiError>`.
- `createMemoryCapabilityRevocationRegistry()` — in-memory registry with
  cascade revocation.

## Verifier checks (in order)

1. Signature dispatch on `proof.kind` — HMAC, Ed25519, or `proof_type_unsupported`.
2. `now < createdAt` → `invalid_signature` (clock-skew = tampered).
3. `now >= expiresAt` → `expired`.
4. `!activeSessionIds.has(scope.sessionId)` → `session_invalid`.
5. `revocations.isRevoked(token.id)` (if provided) → `revoked`.
6. `scopeChecker.isAllowed(toolId, scope)` → `scope_exceeded` on false.

## Issue-time checks

- `isPermissionSubset(child.scope.permissions, parent.scope.permissions)`
- `child.scope.sessionId === parent.scope.sessionId` (cascade)
- `parent.chainDepth + 1 <= parent.maxChainDepth`
- `parent.expiresAt > now`
- `now + ttlMs <= parent.expiresAt`

## Out of scope

- Middleware integration (deferred follow-up).
- Persistent revocation/registry (in-memory only).
- Nexus proof verification (`proof.kind === "nexus"` returns `proof_type_unsupported`).
- Verifier cache (L0 defines `VerifierCache`; consumers wrap externally).
- Proof-of-Possession (`requiresPoP` field copied through but not enforced).
