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
  - `ed25519?: { publicKeys, issuerKeys, rootKeys }` — three required
    fields separating per-agent delegation authority from root-issuance
    authority:
    - `publicKeys` — fingerprint→key map (every key valid for some
      chain position).
    - `issuerKeys` — fingerprint→AgentId binding applied at EVERY chain
      depth. Prevents cross-issuer forgery where one configured key
      signs a token claiming another issuer's AgentId.
    - `rootKeys` — set of fingerprints authorized to sign
      `chainDepth === 0` tokens. Without this allowlist, any configured
      downstream delegatee key (intended only for chain delegation)
      could self-sign a parentless wildcard root, bypassing the
      delegation chain entirely. Pass an empty set when the deployment
      uses HMAC-only roots.
  - `scopeChecker` (required) — see `createGlobScopeChecker()`.
  - `revocations?: CapabilityRevocationRegistry` — when provided,
    every token id is checked against the registry.
  - `tokenStore?: CapabilityTokenStore` — required to verify
    chainDepth>0 tokens. The verifier walks the chain via
    `tokenStore.get(parentId)` and validates signature, expiry,
    session, attenuation, and continuity at each level.
- `createGlobScopeChecker()` — default `ScopeChecker` applying deny-first
  glob matching against `permissions.allow`/`deny` with `*` and `prefix*`
  support (e.g. `db:*` matches `db:delete`). Mirrors the matcher used by
  `@koi/middleware-permissions`. Fails closed on:
  - tokens with non-empty `scope.resources` — `VerifyContext` carries no
    requested resource, so resource-aware checks require a custom checker
  - tokens whose `permissions.ask` matches the requested toolId — the
    default checker has no human-in-the-loop mechanism; production
    deployments that issue ask-bearing tokens MUST inject an interactive
    scope checker capable of returning true after explicit approval
  - any allow/deny/ask list contains a `group:*` pattern — group
    expansion requires a manifest's groups config, unavailable here;
    deployments using groups MUST inject a group-aware checker.
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

1. **Numeric finiteness** — `createdAt`, `expiresAt`, `chainDepth`,
   `maxChainDepth`, and `ctx.now` must all be finite (`Number.isFinite`).
   NaN/Infinity → `invalid_signature`. Without this, a forged NaN
   `expiresAt` would defeat both `now < createdAt` and `now >= expiresAt`
   ordered comparisons.
2. Signature dispatch on `proof.kind` — HMAC, Ed25519, or
   `proof_type_unsupported`. The proof is verified against the
   configured key.
3. `now < createdAt` → `invalid_signature` (clock skew = tampered).
4. `now >= expiresAt` → `expired`.
5. `!activeSessionIds.has(scope.sessionId)` → `session_invalid`.
6. `revocations?.isRevoked(token.id)` → `revoked`.
7. **Issuer-key binding** — for HMAC, `hmac.rootIssuer` (when configured)
   restricts chainDepth=0 tokens to a single issuer. For Ed25519,
   `ed25519.issuerKeys` is enforced at EVERY chain depth: each token's
   `proof.publicKey` must map to its `issuerId`. Otherwise
   `invalid_signature`.

For the leaf token only:

8. **Chain walk** (chainDepth > 0) — via `tokenStore.get(parentId)`,
   recursively verify the parent. Without a `tokenStore`, chainDepth>0
   tokens are rejected as `unknown_grant`. The walk enforces:
   - parent.delegateeId === child.issuerId (continuity)
   - parent.chainDepth + 1 === child.chainDepth
   - child.chainDepth ≤ parent.maxChainDepth (forged-depth defense)
   - child.maxChainDepth ≤ parent.maxChainDepth (no budget widening)
   - child.expiresAt ≤ parent.expiresAt
   - child.scope.sessionId === parent.scope.sessionId
   - `isPermissionSubset(child.permissions, parent.permissions)`
   - resource attenuation (child.resources subset of parent.resources)
9. **Scope check** — `scopeChecker.isAllowed(toolId, scope)` →
   `scope_exceeded` on false.

## Issue-time checks (`delegateCapability`)

- `isPermissionSubsetWithAsk(child.scope.permissions, parent.scope.permissions)`
  — wraps L0's `isPermissionSubset` (allow ⊆ parent, deny only grows) and
  adds **ask preservation**: every entry in `parent.ask` must remain in
  `child.ask` OR be promoted to `child.deny` (strictly more restrictive).
  Without this, a child could silently drop human-approval requirements.
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
- Proof-of-Possession challenge flow. The `requiresPoP` field is
  fail-closed: any token with `requiresPoP === true` is rejected as
  `proof_type_unsupported` until the challenge mechanism lands.
  Accepting such tokens as plain bearer would silently downgrade the
  contract the issuer opted into.

## Trust model

- **HMAC**: any holder of the secret is a trusted issuer. Configure
  `rootIssuer` to bind chainDepth=0 tokens to a specific AgentId.
- **Ed25519**: trust is split into two distinct authorities. `issuerKeys`
  binds each fingerprint to an AgentId, applied at every chain depth — a
  configured key may sign tokens only for its bound AgentId. `rootKeys`
  is a separate allowlist of fingerprints authorized to mint
  `chainDepth === 0` tokens. Conflating them would let any downstream
  delegatee key self-sign wildcard roots and bypass the chain. Always
  configure both maps in production; pass an empty `rootKeys` for
  HMAC-only-root deployments.
- **Chain validation**: chainDepth>0 tokens MUST be verified through a
  `tokenStore` that returns the parent. Without it, leaf signature
  alone does not prove valid attenuation; the verifier fails closed
  with `unknown_grant`.
- **Cascade revocation**: revoking an ancestor invalidates all currently
  registered descendants and any descendants registered later (via the
  ancestor index maintained by the in-memory registry).

## TS 6 Compatibility

All internal `Buffer` variables and `randomBytes()`/`KeyObject.export()` return
values are wrapped in `new Uint8Array(...)`. TypeScript 6 no longer treats
`Buffer` as assignable to `Uint8Array<ArrayBufferLike>` or `ArrayBufferView`,
so explicit wrapping is required for `timingSafeEqual`, `sign`/`verify`, and
any public interface typed as `Uint8Array`.
