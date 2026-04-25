# @koi/governance-delegation — Capability Tokens & Delegation

L2 library that implements the L0 capability + delegation contracts in
`packages/kernel/core/src/capability.ts` and `delegation.ts`.

## Position in the layer architecture

- L0 contracts: `CapabilityToken`, `CapabilityProof`, `CapabilityScope`,
  `CapabilityVerifier`, `VerifyContext`, `CapabilityVerifyResult`,
  `ScopeChecker`, `isPermissionSubset`.
- This package: signers, verifiers, revocation registry, token store,
  issuance helpers.
- No middleware in this package (separate follow-up).

## Public API

- `createCapabilityVerifier(opts)` — composite verifier dispatching on
  `proof.kind`. Options:
  - `hmac?: { secret, rootIssuer? }` — HMAC-SHA256 key plus an optional
    AgentId binding. When `rootIssuer` is set, chainDepth=0 tokens whose
    `issuerId` does not match are rejected as `invalid_signature`.
  - `ed25519?: { publicKeys, rootIssuers? }` — fingerprint→key map plus
    an optional fingerprint→AgentId binding for root authority. When
    `rootIssuers` is set, chainDepth=0 tokens are rejected unless
    `rootIssuers.get(proof.publicKey) === token.issuerId`.
  - `scopeChecker` (required) — see `createGlobScopeChecker()`.
  - `revocations?: CapabilityRevocationRegistry` — when provided,
    every token id is checked against the registry.
  - `tokenStore?: CapabilityTokenStore` — required to verify
    chainDepth>0 tokens. The verifier walks the chain via
    `tokenStore.get(parentId)` and validates signature, expiry,
    session, attenuation, and continuity at each level.
- `createGlobScopeChecker()` — default `ScopeChecker` matching
  `permissions.allow`/`deny` with `*` wildcard support.
- `issueRootCapability(opts)` — produces a signed root `CapabilityToken`.
- `delegateCapability(opts)` — produces a signed child `CapabilityToken`
  after verifying attenuation, chain depth, parent expiry, session match,
  and resource subset. Returns `Result<CapabilityToken, KoiError>`.
- `createMemoryCapabilityRevocationRegistry()` — in-memory implementation
  of both `CapabilityRevocationRegistry` and `CapabilityTokenStore`. The
  same instance is suitable for `revocations` and `tokenStore`. Late
  registration of a child whose ancestor is already revoked marks the
  child revoked too (ancestor-aware cascade).

## Verifier checks

For every token (leaf and ancestors):

1. Signature dispatch on `proof.kind` — HMAC, Ed25519, or
   `proof_type_unsupported`. The proof is verified against the
   configured key.
2. `now < createdAt` → `invalid_signature` (clock skew = tampered).
3. `now >= expiresAt` → `expired`.
4. `!activeSessionIds.has(scope.sessionId)` → `session_invalid`.
5. `revocations?.isRevoked(token.id)` → `revoked`.
6. **chainDepth=0 root binding** — when `hmac.rootIssuer` (HMAC) or
   `ed25519.rootIssuers` (Ed25519) is configured, the root token's
   `issuerId` must match. Otherwise `invalid_signature`.

For the leaf token only:

7. **Chain walk** (chainDepth > 0) — via `tokenStore.get(parentId)`,
   recursively verify the parent. Without a `tokenStore`, chainDepth>0
   tokens are rejected as `unknown_grant`. The walk enforces:
   - parent.delegateeId === child.issuerId (continuity)
   - parent.chainDepth + 1 === child.chainDepth
   - child.expiresAt ≤ parent.expiresAt
   - child.scope.sessionId === parent.scope.sessionId
   - `isPermissionSubset(child.permissions, parent.permissions)`
   - resource attenuation (child.resources subset of parent.resources)
8. **Scope check** — `scopeChecker.isAllowed(toolId, scope)` →
   `scope_exceeded` on false.

## Issue-time checks (`delegateCapability`)

- `isPermissionSubset(child.scope.permissions, parent.scope.permissions)`
- Resource subset: when parent has resources, child must declare a
  subset; missing or broader resources → `scope_exceeded`.
- `child.scope.sessionId === parent.scope.sessionId` (cascade)
- `parent.chainDepth + 1 <= parent.maxChainDepth`
- `parent.expiresAt > now`
- `now + ttlMs <= parent.expiresAt`

## Out of scope

- Middleware integration (deferred follow-up).
- Persistent revocation/registry (in-memory only).
- Nexus proof verification (`proof.kind === "nexus"` returns
  `proof_type_unsupported`).
- Verifier cache (L0 defines `VerifierCache`; consumers wrap externally).
- Proof-of-Possession (`requiresPoP` field copied through but not
  enforced).

## Trust model

- **HMAC**: any holder of the secret is a trusted issuer. Configure
  `rootIssuer` to bind chainDepth=0 tokens to a specific AgentId.
- **Ed25519**: each public-key fingerprint binds to one AgentId via
  `rootIssuers`. Without that binding configured, root tokens accept any
  `issuerId` (deprecated; prefer always configuring `rootIssuers` in
  production).
- **Chain validation**: chainDepth>0 tokens MUST be verified through a
  `tokenStore` that returns the parent. Without it, leaf signature
  alone does not prove valid attenuation; the verifier fails closed
  with `unknown_grant`.
- **Cascade revocation**: revoking an ancestor invalidates all currently
  registered descendants and any descendants registered later (via the
  ancestor index maintained by the in-memory registry).
