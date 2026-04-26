# gov-3: `@koi/governance-delegation` — design

**Issue:** [#1395](https://github.com/windoliver/koi/issues/1395)
**Date:** 2026-04-25
**Status:** Revised after L0 audit (was: Design approved). Awaiting re-approval.

## 1. Goal

Provide the L2 implementation of `@koi/core`'s **already-defined** capability + delegation contracts. `capability.ts:131` notes the planned package: *"`@koi/capability-verifier`: HMAC + Ed25519 composite verifier (L2)"*. This package fulfils that role under the issue's name `@koi/governance-delegation`.

The L0 contracts that already exist and that we implement:

| L0 contract | Purpose | Lives in |
|---|---|---|
| `CapabilityToken` (object) | Bearer token: id, issuerId, delegateeId, scope, parentId, chainDepth, maxChainDepth, createdAt, expiresAt, proof | `packages/kernel/core/src/capability.ts` |
| `CapabilityProof` (union) | `{kind:"hmac-sha256",digest}` \| `{kind:"ed25519",publicKey,signature}` \| `{kind:"nexus",token}` | `delegation.ts` |
| `CapabilityScope` | `{permissions: PermissionConfig, resources?: string[], sessionId: SessionId}` | `capability.ts` |
| `CapabilityVerifier` | `verify(token, ctx) → CapabilityVerifyResult \| Promise<…>` + optional `cache`, `dispose` | `capability.ts` |
| `VerifyContext` | `{toolId, now, activeSessionIds: ReadonlySet<SessionId>}` | `capability.ts` |
| `CapabilityVerifyResult` | `{ok: true, token}` \| `{ok: false, reason: CapabilityDenyReason}` | `capability.ts` |
| `isPermissionSubset` (pure fn) | Monotonic-attenuation check over `PermissionConfig` | `delegation.ts` |
| `ScopeChecker` | `isAllowed(toolId, DelegationScope) → boolean \| Promise<…>` | `delegation.ts` |
| `RevocationRegistry` | DelegationId-keyed registry; we add a CapabilityId-keyed sibling | `delegation.ts` |

What this package adds (L2):
- HMAC and Ed25519 implementations of `CapabilityVerifier`, plus a composite that dispatches on `proof.kind`.
- Issuance helpers — `issueRoot`, `delegate` — that produce signed `CapabilityToken` objects with monotonic attenuation enforced at issue time.
- A `CapabilityRevocationRegistry` (sibling of L0's `RevocationRegistry`, keyed on `CapabilityId`) with cascading revocation and an in-memory implementation.
- A default `ScopeChecker` doing glob match over `permissions.allow/deny` + `resources`.

This package is a **library**. Middleware that pulls a token from request context and gates tool calls is a separate follow-up.

## 2. Layer & dependencies

- New L2 package: `@koi/governance-delegation` at `packages/security/governance-delegation/`
- Depends on `@koi/core` (L0 types) and `@koi/hash` (L0u, optional — only if we reuse `computeStringHash` for canonical-payload hashing)
- No external runtime dependencies. Crypto via `node:crypto` (`createHmac`, `timingSafeEqual`, `sign`, `verify`, `generateKeyPairSync`) — same style as `@koi/hash/src/hmac-signing.ts`
- Wired into `@koi/runtime` per the v2 golden-query rule (standalone golden queries only — library-only package, no cassette per `@koi/url-safety` precedent in `golden-replay.test.ts:2372`)

LOC budget: ~600 src + ~600 tests. Slightly over the issue's ~500 estimate because we honor existing L0 contracts (more types to map) but well under v1's 6800 LOC. Each file remains < 100 LOC.

## 3. Design decisions (revised)

| Decision | Choice | Why |
|---|---|---|
| Crypto schemes | HMAC-SHA256 **and** Ed25519 (composite verifier dispatches on `proof.kind`) | L0's `CapabilityProof` is already a discriminated union with both. Implementing both matches the doc's stated L2 mandate ("HMAC + Ed25519 composite verifier"). |
| Capability language | `PermissionConfig` (`allow`/`deny` lists) + optional `resources` globs | L0's `CapabilityScope` already defines this. `isPermissionSubset` already implements attenuation. We do not invent a new scope language. |
| Token shape | Structured `CapabilityToken` JS object per L0, signature lives in `proof` field | L0 contract — not negotiable. No wire format invented. |
| Canonical signing | JSON-stringify the token *minus* the `proof` field with sorted keys → UTF-8 bytes → digest. Signer/verifier operate on those bytes. | Standard "everything but the signature" payload. ~30 LOC. |
| Chain enforcement | Attenuation + chain-depth + parent-expiry checked at **issue time**. `delegate()` requires the parent token, verifies it, attenuates, then signs the child with `parentId = parent.id, chainDepth = parent.chainDepth + 1`. | Verify-time only sees the leaf token (no walk-back), per L0's `verify(token, context)` shape. The leaf signature is the integrity guarantee — it commits to `parentId` and the (already-attenuated) `scope`. |
| Revocation | Two-layer: (a) session-scoped via L0 `VerifyContext.activeSessionIds` (free, cascading via shared sessionId); (b) per-token `CapabilityRevocationRegistry` (new L2 contract, sibling of L0's `RevocationRegistry`, keyed on `CapabilityId`) with optional cascade-walk over a parent→children index maintained by the registry implementation when tokens are registered at issue time. | L0's existing `RevocationRegistry` is `DelegationId`-typed; we cannot reuse it for `CapabilityId`. Session-scoped revocation handles the bulk path; per-token revocation handles surgical revoke of a sub-tree. |
| Integration boundary | Library only — no middleware, no agent-loop wiring | Keeps LOC honest; transport-shape (where tokens live in messages) belongs with the future MW. |

## 4. Public API (`src/index.ts`)

We do not redefine L0 types. We export factories and helpers.

```typescript
// L0 types we operate on (re-exported for convenience only — same identities as @koi/core)
export type {
  CapabilityToken,
  CapabilityProof,
  CapabilityScope,
  CapabilityId,
  CapabilityVerifier,
  CapabilityVerifyResult,
  VerifyContext,
  ScopeChecker,
  PermissionConfig,
  AgentId,
  SessionId,
} from "@koi/core";

// New L2 contract — sibling of L0's RevocationRegistry, keyed on CapabilityId
export type { CapabilityRevocationRegistry } from "./revocation.js";
export { createMemoryCapabilityRevocationRegistry } from "./revocation.js";

// Composite verifier — accepts hmac and/or ed25519 keys + revocation registry
export {
  createCapabilityVerifier,
  type CapabilityVerifierOptions,
} from "./verifier.js";

// Default glob-based scope checker
export { createGlobScopeChecker } from "./scope-checker.js";

// Signer — discriminated union analogous to CapabilityProof
export type { CapabilitySigner } from "./signer.js";
export { createHmacCapabilitySigner, createEd25519CapabilitySigner } from "./signer.js";

// Issuance helpers
export { issueRootCapability, delegateCapability } from "./issue.js";
```

### 4.1 New L2 type: `CapabilityRevocationRegistry`

```typescript
interface CapabilityRevocationRegistry {
  // Called by issueRoot/delegate at token creation. Records (id, parentId) for cascade.
  // No-op if id already present.
  register(token: CapabilityToken): void | Promise<void>;

  isRevoked(id: CapabilityId): boolean | Promise<boolean>;

  // cascade=true walks the parent→children index registered above.
  revoke(id: CapabilityId, cascade: boolean): void | Promise<void>;
}
```

In-memory impl: two `Map`s — `revoked: Set<CapabilityId>`, `children: Map<CapabilityId, Set<CapabilityId>>`. ~40 LOC.

### 4.2 `CapabilityVerifierOptions`

```typescript
interface CapabilityVerifierOptions {
  // At least one must be provided. Verifier rejects tokens whose proof.kind has no key.
  readonly hmac?: { readonly secret: Uint8Array };
  readonly ed25519?: {
    // Map from proof.publicKey (hex/base64) → public key bytes.
    // Allows multiple issuers in the same trust domain.
    readonly publicKeys: ReadonlyMap<string, Uint8Array>;
  };

  // Required. Default available via createGlobScopeChecker().
  readonly scopeChecker: ScopeChecker;

  // Optional. When present, verifier checks token id against it.
  // Without one, only signature/expiry/session-active/scope checks run.
  readonly revocations?: CapabilityRevocationRegistry;
}
```

### 4.3 `CapabilitySigner`

```typescript
type CapabilitySigner =
  | { readonly kind: "hmac-sha256"; readonly secret: Uint8Array }
  | { readonly kind: "ed25519"; readonly privateKey: Uint8Array; readonly publicKey: Uint8Array };
```

Plain data — the issuance functions know how to sign with each shape. No factory ceremony.

### 4.4 Issuance helpers

```typescript
issueRootCapability(opts: {
  readonly signer: CapabilitySigner;
  readonly issuerId: AgentId;
  readonly delegateeId: AgentId;
  readonly scope: CapabilityScope;            // sessionId required
  readonly ttlMs: number;
  readonly maxChainDepth: number;             // 0 = no further re-delegation
  readonly registry?: CapabilityRevocationRegistry;  // if present, register() called
  readonly now?: () => number;                // default Date.now
}): Promise<CapabilityToken>;

delegateCapability(opts: {
  readonly signer: CapabilitySigner;
  readonly parent: CapabilityToken;
  readonly delegateeId: AgentId;
  readonly scope: CapabilityScope;            // must attenuate parent
  readonly ttlMs: number;
  readonly registry?: CapabilityRevocationRegistry;
  readonly now?: () => number;
}): Promise<Result<CapabilityToken, KoiError>>;
```

`issueRootCapability` returns a plain `Promise<CapabilityToken>` — caller-supplied inputs are accepted as-is, signing is async. Programmer errors (e.g., `ttlMs <= 0`, missing privateKey) throw.

`delegateCapability` returns `Promise<Result<CapabilityToken, KoiError>>` — attenuation, chain-depth, parent-expiry, parent-revocation, and TTL-exceeds-parent are all validation failures.

`now` is injectable for testability.

## 5. File layout

```
packages/security/governance-delegation/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
└── src/
    ├── index.ts                 ~30   public exports
    ├── canonical.ts             ~40   serializeForSigning(token): canonical JSON of token-minus-proof, UTF-8 bytes
    ├── scope-checker.ts         ~70   createGlobScopeChecker — glob match on permissions/resources
    ├── signer.ts                ~50   sign(signer, bytes) helper — produces CapabilityProof
    ├── hmac-verifier.ts         ~30   verifyHmac(token, secret): boolean
    ├── ed25519-verifier.ts      ~50   verifyEd25519(token, pubKeys): boolean
    ├── verifier.ts              ~90   createCapabilityVerifier — composite, dispatches on proof.kind, runs all checks
    ├── revocation.ts            ~50   CapabilityRevocationRegistry interface + in-memory impl
    ├── issue.ts                 ~120  issueRootCapability + delegateCapability
    └── __tests__/
        ├── canonical.test.ts
        ├── scope-checker.test.ts
        ├── hmac-roundtrip.test.ts
        ├── ed25519-roundtrip.test.ts
        ├── attenuation.test.ts          (delegate: narrows / rejects widening / chain depth)
        ├── verify-chain.test.ts         (verifier: signature, expiry, session, tool scope)
        └── revocation.test.ts           (cascade revoke, non-cascade revoke)
```

Source total ≈ 530 lines, every file < 100 LOC. Tests ≈ 600 lines.

Plus:
- `docs/L2/governance-delegation.md` (Doc-gate prerequisite)
- `packages/meta/runtime/package.json` + `tsconfig.json` updated to include `@koi/governance-delegation`
- 2 standalone golden queries appended to `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:
  1. `Golden: @koi/governance-delegation — issue + verify roundtrip`
  2. `Golden: @koi/governance-delegation — revocation invalidates downstream`

## 6. Algorithms

### 6.1 Canonical signing payload (`canonical.ts`)

```typescript
serializeForSigning(token: Omit<CapabilityToken, "proof">): Uint8Array
```

- Build a deterministic JSON string with sorted keys at every nesting level
- Encode with `TextEncoder().encode(...)` → `Uint8Array`
- This byte sequence is the input to both signing and verification

`requiresPoP` is included if defined; omitted if undefined (treated as field-absent in canonical form). Numeric fields (`createdAt`, `expiresAt`, `chainDepth`, `maxChainDepth`) are serialized as JSON numbers — same on both sides → bit-exact bytes.

### 6.2 Scope checker (`scope-checker.ts`)

`createGlobScopeChecker()` returns a `ScopeChecker` whose `isAllowed(toolId, scope)` returns `true` iff:

1. `toolId` not in `scope.permissions.deny` (deny wins)
2. AND (`scope.permissions.allow` contains `"*"` OR `toolId` is matched by `scope.permissions.allow`)
3. AND if `scope.resources` is non-empty, at least one entry's pre-colon prefix equals `toolId` and post-colon glob matches the resource argument the verifier was passed (NOT in scope of `isAllowed(toolId, scope)` — see note)

Note: L0's `ScopeChecker.isAllowed(toolId, scope)` only takes `toolId`. Resource-pattern matching against the *call's* arguments belongs in the call-site (the future MW). The default checker therefore implements 1+2 only and ignores `resources`. This matches `isPermissionSubset` semantics.

Glob semantics for permission entries: identical to `isPermissionSubset` — exact match by default, `*` wildcard for the whole entry. We deliberately keep the matcher minimal; richer globs are a future MW concern.

### 6.3 HMAC verifier (`hmac-verifier.ts`)

```typescript
function verifyHmac(token: CapabilityToken, secret: Uint8Array): boolean {
  if (token.proof.kind !== "hmac-sha256") return false;
  const payload = serializeForSigning(stripProof(token));
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(token.proof.digest, "base64");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

`token.proof.digest` is base64 in the wire/object form.

### 6.4 Ed25519 verifier (`ed25519-verifier.ts`)

```typescript
function verifyEd25519(
  token: CapabilityToken,
  publicKeys: ReadonlyMap<string, Uint8Array>
): boolean {
  if (token.proof.kind !== "ed25519") return false;
  const pub = publicKeys.get(token.proof.publicKey);
  if (!pub) return false;
  const payload = serializeForSigning(stripProof(token));
  const sig = Buffer.from(token.proof.signature, "base64");
  return crypto.verify(null, payload, { key: pub, format: "der", type: "spki" }, sig);
}
```

Public-key encoding: SPKI DER, base64-stored in `token.proof.publicKey` (the lookup key) is a stable hex/base64 fingerprint, and the actual key bytes live in the `publicKeys` map keyed on that fingerprint. (Implementation detail — verifier construction normalizes either way.)

### 6.5 Composite verifier (`verifier.ts`)

`createCapabilityVerifier(opts) → CapabilityVerifier` returns an object whose `verify(token, ctx)` does:

1. Signature — dispatch on `token.proof.kind`:
   - `"hmac-sha256"` → require `opts.hmac`, else `proof_type_unsupported`. Run `verifyHmac` → `invalid_signature` on fail.
   - `"ed25519"` → require `opts.ed25519`, else `proof_type_unsupported`. Run `verifyEd25519` → `invalid_signature` on fail.
   - `"nexus"` → not supported in this package → `proof_type_unsupported`.
2. Expiry — `ctx.now >= token.expiresAt` → `expired`. `ctx.now < token.createdAt` → `invalid_signature` (clock-skew == tampered).
3. Session — `!ctx.activeSessionIds.has(token.scope.sessionId)` → `session_invalid`.
4. Revocation (if `opts.revocations` provided) — `await opts.revocations.isRevoked(token.id)` → `revoked`.
5. Scope — `await opts.scopeChecker.isAllowed(ctx.toolId, { permissions: token.scope.permissions, resources: token.scope.resources, sessionId: token.scope.sessionId })` → `scope_exceeded` on `false`.
6. Return `{ ok: true, token }`.

Returned `CapabilityVerifyResult` shape per L0. All checks short-circuit.

The returned verifier exposes the optional `dispose: undefined` and `cache: undefined` fields per the L0 contract — caching deferred (see §8).

### 6.6 `issueRootCapability(opts)`

1. Build the un-signed token with `id = capabilityId(crypto.randomUUID())`, `parentId: undefined`, `chainDepth: 0`, `createdAt = opts.now?.() ?? Date.now()`, `expiresAt = createdAt + opts.ttlMs`.
2. Compute payload bytes via `serializeForSigning(unSigned)`.
3. Sign per `opts.signer.kind` → produce `CapabilityProof`.
4. Build the signed `CapabilityToken` and return it. If `opts.registry` present, `await opts.registry.register(token)` first.

Throws on `opts.ttlMs <= 0`, `opts.maxChainDepth < 0`, missing signer key for the chosen kind. These are programmer errors per CLAUDE.md.

### 6.7 `delegateCapability(opts)`

Returns `Result<CapabilityToken, KoiError>`. Validation failures return `{ok: false, error}`:

1. `opts.parent.chainDepth + 1 > opts.parent.maxChainDepth` → `chain_depth_exceeded`.
2. `opts.parent.expiresAt <= now` → `expired`.
3. `opts.parent.scope.sessionId !== opts.scope.sessionId` → `session_invalid` (child must inherit parent's session for cascade).
4. `!isPermissionSubset(opts.scope.permissions, opts.parent.scope.permissions)` → `scope_exceeded`.
5. `now + opts.ttlMs > opts.parent.expiresAt` → `scope_exceeded` reason code overloaded — emit a clearer dedicated code: `ttl_exceeds_parent` (added to a small per-package error-code enum; not an L0 change).
6. Build child token: `id = capabilityId(randomUUID())`, `parentId = opts.parent.id`, `chainDepth = parent.chainDepth + 1`, `maxChainDepth = parent.maxChainDepth`, `expiresAt = now + opts.ttlMs`.
7. Sign and return `{ok: true, value: child}`. If `opts.registry` present, register.

`delegateCapability` does not run a full `CapabilityVerifier.verify` on the parent — only the structural checks above. Callers responsible for verifying parents they didn't issue themselves.

### 6.8 In-memory revocation registry

Maintains:
- `revoked: Set<CapabilityId>`
- `children: Map<CapabilityId, Set<CapabilityId>>` (parentId → set of immediate child ids)

`register(token)`:
- `if (token.parentId) { children.get(token.parentId) ?? children.set(token.parentId, new Set()); ... .add(token.id) }`

`isRevoked(id) → revoked.has(id)`.

`revoke(id, cascade)`:
- `revoked.add(id)`
- If `cascade`, BFS over `children` from `id`, adding each descendant to `revoked`.

This is sync. The interface returns `T | Promise<T>` so async stores can replace it later.

### 6.9 Error model

Verifier failures use L0's `CapabilityDenyReason` (enumerated in `capability.ts:147`).

`delegateCapability` returns L0 `KoiError` with codes — we map to a stable subset:

| Code | When |
|---|---|
| `EXPIRED` | parent already expired |
| `CHAIN_DEPTH_EXCEEDED` | child would exceed `parent.maxChainDepth` |
| `SCOPE_EXCEEDED` | child not subset of parent (also covers permission-deny growth) |
| `SESSION_MISMATCH` | child sessionId ≠ parent sessionId |
| `TTL_EXCEEDS_PARENT` | child.expiresAt > parent.expiresAt |

These align with L0's existing `KoiErrorCode` where possible. Any new code is added to the per-package error builder; we do **not** add new codes to L0 unless we discover a strong reason.

## 7. Testing

Coverage target ≥ 80%. Tests map to issue requirements:

| Issue requirement | Test file | Cases |
|---|---|---|
| Capability token created and verified | `hmac-roundtrip.test.ts`, `ed25519-roundtrip.test.ts` | issueRoot → verify with matching ctx → ok; tamper id/scope/createdAt → `invalid_signature`; tamper digest → `invalid_signature` |
| Delegation narrows capabilities | `attenuation.test.ts` | parent allow=["read_file","write_file"], child allow=["read_file"] → ok; parent allow=["*"], child allow=["read_file"] → ok |
| Widening attempt rejected | `attenuation.test.ts` | parent allow=["read_file"], child allow=["write_file"] → `SCOPE_EXCEEDED`; parent deny=["bash"], child deny=[] → `SCOPE_EXCEEDED` (deny only grows) |
| Delegation chain traversed correctly | `attenuation.test.ts` + `verify-chain.test.ts` | A→B→C three-level chain: B's child of A signed correctly, C's child of B signed correctly, leaf C verifies under final verifier; `chainDepth` increments; depth > maxChainDepth → `CHAIN_DEPTH_EXCEEDED` |
| Revocation invalidates downstream | `revocation.test.ts` | Register A, B (child of A), C (child of B). `revoke(A.id, cascade=true)` → all three return `revoked` from registry. `revoke(B.id, cascade=true)` → A still ok, B+C revoked. `revoke(B.id, cascade=false)` → only B revoked, C still ok |
| Expired delegation rejected | `verify-chain.test.ts` | Token with `expiresAt = createdAt - 1` → verifier returns `expired`. Re-delegate from expired parent → `EXPIRED`. |

Plus essential coverage:
- `canonical.test.ts` — same input → bit-equal bytes; key-order independence; tamper detection (changing one field changes bytes)
- `scope-checker.test.ts` — `*` wildcard; deny wins over allow; missing-toolId in non-wildcard allow → false
- `verify-chain.test.ts` — `proof_type_unsupported` when verifier lacks the key for the proof kind; `session_invalid` when sessionId not in `activeSessionIds`; clock-skew (`now < createdAt`) → `invalid_signature`
- `attenuation.test.ts` — child's `expiresAt > parent.expiresAt` → `TTL_EXCEEDS_PARENT`
- `revocation.test.ts` — `register` is idempotent; cascade with diamond ancestry hits each descendant once

**Standalone golden queries** for `@koi/runtime` (per the `@koi/url-safety` precedent at `golden-replay.test.ts:2372`):

```typescript
describe("Golden: @koi/governance-delegation — issue + verify roundtrip", () => {
  // Build HMAC signer + verifier, issue a root token, verify it. Tamper, re-verify, expect invalid_signature.
});

describe("Golden: @koi/governance-delegation — revocation invalidates downstream", () => {
  // Issue chain A→B→C via delegateCapability. Revoke A with cascade. Expect revocations.isRevoked returns true for B and C.
});
```

No cassette needed — pure library queries.

## 8. Out of scope (explicit)

- **Middleware integration** — pulling tokens from message context and gating tool calls. Separate follow-up.
- **Verifier cache** — L0 defines `VerifierCache`; we expose `cache: undefined` and let consumers wrap our verifier with a cache later.
- **Persistent revocation/registry** — in-memory only. SQLite/Nexus stores are follow-up L2 packages.
- **Nexus proof verification** — `proof.kind === "nexus"` returns `proof_type_unsupported`. Nexus integration belongs to gov-5 (`#1399 permissions-nexus`).
- **Proof-of-Possession** — L0 reserves `requiresPoP` for v2; we copy the field into signed tokens but enforce nothing.
- **Key rotation** — caller supplies key bytes to verifier construction; rotation handled by caller.
- **Cross-process tokens** — token is a JS object, not a wire format. If a future package needs to ship tokens between processes, it will define a transport encoding.

## 9. CI gates

```bash
bun run test                          # unit, ≥80% coverage
bun run typecheck                     # strict TS6
bun run lint                          # Biome
bun run check:layers                  # L0/L1/L2 enforcement
bun run check:unused                  # no dead exports
bun run check:duplicates              # no copy-paste blocks
bun run check:orphans                 # @koi/governance-delegation must be a runtime dep
bun run check:golden-queries          # standalone goldens registered
bun run test --filter=@koi/runtime    # standalone goldens green
```

## 10. Anti-leak checklist

- [x] No imports from L1 (`@koi/engine`) or peer L2 packages
- [x] No vendor types
- [x] All interface properties `readonly`
- [x] Async-by-default — `verify`, `isRevoked`, `register`, `revoke`, issuance helpers all return `T | Promise<T>`
- [x] No external runtime deps; crypto via `node:crypto`
- [x] No throws on expected failures — `delegateCapability` returns `Result`; verifier returns `CapabilityVerifyResult`
- [x] Implements L0 contracts; does not redefine them
