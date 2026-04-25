# gov-3: `@koi/governance-delegation` — design

**Issue:** [#1395](https://github.com/windoliver/koi/issues/1395)
**Date:** 2026-04-25
**Status:** Design approved (brainstorming complete)

## 1. Goal

Provide an unforgeable capability-token primitive for in-process delegation between Koi agents. An agent A can issue a token granting a subset of its capabilities to agent B; B can re-delegate a further subset to C; verification walks the embedded chain and validates signature, expiry, attenuation, and revocation at every level.

This package is a **library** — pure signers, verifiers, chain operations, and a revocation store interface. Middleware integration (gating tool calls on tokens) is a separate follow-up issue and explicitly out of scope.

## 2. Layer & dependencies

- New L2 package: `@koi/governance-delegation` at `packages/security/governance-delegation/`
- Depends on `@koi/core` (L0 types only) and `@koi/hash` (L0u, for canonical hashing if needed)
- No external runtime dependencies. Crypto comes from Bun's `crypto.subtle` (HMAC-SHA256, Ed25519) — no `jose`, `tweetnacl`, or `node-forge`
- Wired into `@koi/runtime` per the v2 golden-query rule (one new golden query)

LOC budget: ~540 src + ~500 tests, every file < 100 LOC. Fits the ~500 LOC issue estimate.

## 3. Design decisions (from brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Crypto schemes | HMAC-SHA256 **and** Ed25519, pluggable via `CapabilityVerifier` interface | Same in-process trust domain today; pluggable keeps door open for cross-trust-domain Ed25519 use without redesign |
| Capability language | OAuth2-style colon-delimited scope strings with glob match | Familiar mental model, easy to log, ~30 LOC for matching, what v1 used |
| Token format | Custom compact: `base64url(canonical-json-payload).base64url(sig)` | Half the LOC of JWT; no header registry; in-process anyway |
| Chain representation | Embedded — child token contains parent token verbatim | Self-contained verification; no registry lookup for chain traversal |
| Revocation | Pluggable `RevocationStore` (`isRevoked` / `revoke`) with in-memory impl | Async-by-default per CLAUDE.md; SQLite/Nexus stores deferred to follow-up |
| Integration boundary | Library only; no middleware in this package | Keeps LOC budget honest; transport-shape questions belong with the MW that consumes tokens |

## 4. Public API (`src/index.ts`)

```typescript
export type { CapabilityToken, CapabilityPayload, Scope, Jti } from "./types.js";
export type { CapabilityVerifier, VerifyResult } from "./verifier.js";
export type { CapabilitySigner } from "./signer.js";
export type { RevocationStore } from "./revocation.js";

export { createHmacVerifier } from "./hmac-verifier.js";
export { createEd25519Verifier } from "./ed25519-verifier.js";
export { createHmacSigner, createEd25519Signer } from "./signer.js";
export { createMemoryRevocationStore } from "./revocation.js";

export { issueRoot, delegate } from "./delegate.js";
export { verifyChain } from "./verify-chain.js";
export { matchesScope, isAttenuation } from "./scope.js";
```

### 4.1 Core types

```typescript
type Jti = Brand<string, "Jti">;
type Scope = string;                          // "<resource>:<action>" or "<resource>:<action>:<pattern>"

type CapabilityPayload = {
  readonly jti: Jti;
  readonly iss: string;                       // issuer agent id
  readonly sub: string;                       // delegate agent id
  readonly scopes: readonly Scope[];
  readonly iat: number;                       // unix ms
  readonly exp: number;                       // unix ms
  readonly parent?: CapabilityToken;          // embedded parent token; absent on root
};

type CapabilityToken = string;                // base64url(payload).base64url(sig)
```

### 4.2 Operations

```typescript
issueRoot(
  signer: CapabilitySigner,
  opts: { iss: string; sub: string; scopes: readonly Scope[]; ttlMs: number }
): Promise<CapabilityToken>;

delegate(
  signer: CapabilitySigner,
  parent: CapabilityToken,
  opts: { sub: string; scopes: readonly Scope[]; ttlMs: number }
): Promise<Result<CapabilityToken>>;

verifyChain(
  verifier: CapabilityVerifier,
  store: RevocationStore,
  token: CapabilityToken,
  now?: number   // defaults to Date.now()
): Promise<VerifyResult>;

type VerifyResult =
  | { readonly ok: true; readonly payload: CapabilityPayload; readonly chain: readonly CapabilityPayload[] }
  | { readonly ok: false; readonly error: KoiError };
```

`issueRoot` returns a plain `Promise<CapabilityToken>` because it has no validation failure modes — caller-supplied scopes/sub/ttl are accepted as-is, signing is async. Programmer errors (e.g. `ttlMs <= 0`) throw.

`delegate` returns `Promise<Result<CapabilityToken>>` because attenuation, parent-expiry, parent-malformed, and TTL-exceeds-parent are all expected validation failures.

`verifyChain` is always async — the verifier and revocation store are async-by-default.

### 4.3 Verifier / signer interfaces

```typescript
interface CapabilityVerifier {
  readonly scheme: "hmac-sha256" | "ed25519";
  verify(payloadBytes: Uint8Array, sigBytes: Uint8Array): Promise<boolean>;
}

interface CapabilitySigner {
  readonly scheme: "hmac-sha256" | "ed25519";
  sign(payloadBytes: Uint8Array): Promise<Uint8Array>;
}

interface RevocationStore {
  isRevoked(jti: Jti): boolean | Promise<boolean>;
  revoke(jti: Jti): void | Promise<void>;
}
```

## 5. File layout

```
packages/security/governance-delegation/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
└── src/
    ├── index.ts              ~30   public exports
    ├── types.ts              ~40   CapabilityPayload, CapabilityToken, Jti, Scope
    ├── codec.ts              ~50   encode/decode (base64url + canonical JSON)
    ├── scope.ts              ~60   matchesScope, isAttenuation
    ├── verifier.ts           ~20   CapabilityVerifier interface
    ├── hmac-verifier.ts      ~40   createHmacVerifier
    ├── ed25519-verifier.ts   ~50   createEd25519Verifier
    ├── signer.ts             ~60   CapabilitySigner + HMAC + Ed25519 signers
    ├── revocation.ts         ~30   RevocationStore + in-memory impl
    ├── delegate.ts           ~80   issueRoot, delegate
    ├── verify-chain.ts       ~80   verifyChain
    └── __tests__/
        ├── codec.test.ts
        ├── scope.test.ts
        ├── hmac-roundtrip.test.ts
        ├── ed25519-roundtrip.test.ts
        ├── delegate.test.ts
        ├── verify-chain.test.ts
        └── revocation.test.ts
```

Plus:
- `docs/L2/governance-delegation.md` (Doc-gate prerequisite)
- `packages/meta/runtime/package.json` + `tsconfig.json` updated to include `@koi/governance-delegation`
- New golden query `delegation-attenuation` in `packages/meta/runtime/scripts/record-cassettes.ts` and replay assertions in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

## 6. Algorithms

### 6.1 Canonical encoding (`codec.ts`)

- Payload → JSON with deterministic key order → UTF-8 bytes → base64url
- Signature → raw bytes → base64url
- Wire: `<payload-b64>.<sig-b64>`
- Decode returns `{ payload, payloadBytes, sigBytes }` — `payloadBytes` is the *exact* input to signature verification, not a re-serialized copy. This defends against canonicalization bugs.

### 6.2 Scope matching (`scope.ts`)

- Scope grammar: `<resource>:<action>` or `<resource>:<action>:<pattern>`
- `resource` and `action` exact-match (case sensitive)
- `pattern` uses minimal globs — `*` matches any chars except `/`, `**` matches any chars including `/`. No regex, no character classes.
- `matchesScope(granted, requested)` → true iff every component is covered
- `isAttenuation(parent[], child[])` → true iff every `child[i]` is matched by some `parent[j]`. Empty `child` is a valid attenuation (drops all scopes).

### 6.3 Crypto (`hmac-verifier.ts`, `ed25519-verifier.ts`, `signer.ts`)

- HMAC: `crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [...])` once at construction; `subtle.sign("HMAC", key, payloadBytes)` / `subtle.verify("HMAC", key, sigBytes, payloadBytes)`. `subtle.verify` is constant-time.
- Ed25519: `crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [...])`; same `sign`/`verify` shape. Bun supports Ed25519 in `crypto.subtle` natively.
- Signers and verifiers carry a `scheme` discriminant so callers can detect mismatch at construction (programmer error → throw).

### 6.4 `delegate(signer, parent, opts)`

Returns `Result<CapabilityToken>`. Validation failures return `{ ok: false, error }`:

1. Decode `parent` → `parentPayload`. Decode failure → `MALFORMED`.
2. If `parentPayload.exp <= now()` → `EXPIRED`.
3. If `!isAttenuation(parentPayload.scopes, opts.scopes)` → `ATTENUATION_VIOLATED`.
4. If `now() + opts.ttlMs > parentPayload.exp` → `TTL_EXCEEDS_PARENT`.
5. Build child payload with `parent: <parent token string>` embedded verbatim.
6. Sign and return `{ ok: true, value: <child token> }`.

`delegate` does *not* verify the parent's signature — that's `verifyChain`'s job. Callers who delegate from a token they didn't just create should `verifyChain` it first.

### 6.5 `verifyChain(verifier, store, token, now)`

1. Decode → `{ payload, payloadBytes, sigBytes }` (rejects on malformed → `MALFORMED`)
2. `await verifier.verify(payloadBytes, sigBytes)` → reject `SIGNATURE_INVALID`
3. Check `payload.iat <= now < payload.exp` → reject `EXPIRED` or `NOT_YET_VALID`
4. `await store.isRevoked(payload.jti)` → reject `REVOKED`
5. If `payload.parent`:
   - Recurse on `payload.parent`
   - Verify `parentPayload.sub === payload.iss` → reject `CHAIN_BROKEN`
   - Verify `isAttenuation(parentPayload.scopes, payload.scopes)` → reject `ATTENUATION_VIOLATED`
   - Verify `payload.exp <= parentPayload.exp` → reject `CHAIN_BROKEN`
6. Accumulate chain root → leaf, return `{ ok: true, payload, chain }`

### 6.6 Jti generation

`crypto.randomUUID()` inside `issueRoot` and `delegate`. Caller never supplies it, so callers can't collide jtis on purpose.

### 6.7 Error model

Every reject returns a typed `KoiError` (per CLAUDE.md error-handling rules — no throws on expected failures). Stable codes:

| Code | Meaning |
|---|---|
| `MALFORMED` | Token doesn't decode |
| `SIGNATURE_INVALID` | Signature doesn't verify |
| `EXPIRED` | `payload.exp <= now` |
| `NOT_YET_VALID` | `payload.iat > now` |
| `REVOKED` | Jti in revocation store |
| `ATTENUATION_VIOLATED` | Child has scopes the parent doesn't |
| `CHAIN_BROKEN` | `iss/sub` mismatch or child outlives parent |
| `TTL_EXCEEDS_PARENT` | `delegate()` called with TTL > parent's remaining lifetime |

`retryable: false` for all of the above (per `RETRYABLE_DEFAULTS` semantics — these are validation failures).

## 7. Testing

Coverage target ≥ 80% (per `bunfig.toml`). Tests map to issue requirements:

| Issue requirement | Test file | Cases |
|---|---|---|
| Capability token created and verified | `hmac-roundtrip.test.ts`, `ed25519-roundtrip.test.ts` | sign → encode → decode → verify roundtrip; tamper payload byte → reject; tamper signature byte → reject |
| Delegation narrows capabilities | `delegate.test.ts` | `["fs:read:/tmp/*"]` → `["fs:read:/tmp/foo"]` succeeds |
| Widening attempt rejected | `delegate.test.ts` | `["fs:read:/tmp/*"]` → `["fs:read:/etc/*"]` returns `ATTENUATION_VIOLATED`; `["fs:read"]` → `["fs:write"]` rejected |
| Delegation chain traversed correctly | `verify-chain.test.ts` | A→B→C three-level chain verifies; intermediate signature tamper → `SIGNATURE_INVALID`; broken `iss/sub` → `CHAIN_BROKEN` |
| Revocation invalidates downstream | `revocation.test.ts` | A→B→C; revoke A's jti → C verify returns `REVOKED`; revoke B's jti → C rejected, A still valid |
| Expired delegation rejected | `verify-chain.test.ts` | `exp = now-1` → `EXPIRED`; expired parent → child rejected even if child not yet expired |

Plus:
- `codec.test.ts` — base64url roundtrip, malformed token rejected, payload-bytes preserved exactly
- `scope.test.ts` — `*` vs `**` glob semantics, exact match, action mismatch, attenuation subset semantics, empty child attenuates trivially
- `delegate.test.ts` — child TTL exceeding parent's remaining lifetime → `TTL_EXCEEDS_PARENT`
- `verify-chain.test.ts` — clock skew (`iat > now`) → `NOT_YET_VALID`; HMAC sig verified by Ed25519 verifier → `SIGNATURE_INVALID`

**Property test (one):** if `fast-check` is already a workspace dep, add an attenuation-transitivity check (`A⊇B ∧ B⊇C ⇒ A⊇C`). Otherwise rely on enumerated cases.

**Golden query for `@koi/runtime`:**
- `delegation-attenuation` — agent given a delegated token, attempts an in-scope tool call (allowed) and an out-of-scope tool call (denied). ATIF trajectory shows verify decisions.
- Wires `governance-delegation` into runtime per CLAUDE.md's golden-query rule.

## 8. Out of scope (explicit)

- **Middleware integration.** A future MW would pull a token from request context and gate tool calls. That requires deciding token transport (where does the token live in the message/context?), which is a separate design.
- **Persistent revocation stores** (SQLite, Nexus). The interface is shipped; implementations are follow-up L2 packages.
- **Capability request bridge** (v1's cross-agent token-request flow). Not required by the issue.
- **Cache for repeated verifications.** v1 had a verify-cache; YAGNI for first cut.
- **Key management / rotation.** Caller supplies the key bytes to the signer/verifier factory. Rotation is an operational concern outside this package.
- **Token introspection endpoints, formats other than the compact one, JWT compatibility.**

## 9. CI gates this PR must pass

```bash
bun run test                          # unit tests, ≥80% coverage
bun run typecheck                     # strict TS6
bun run lint                          # Biome
bun run check:layers                  # L0/L1/L2 enforcement — must pass
bun run check:unused                  # no dead exports
bun run check:duplicates              # no copy-paste blocks
bun run check:orphans                 # @koi/governance-delegation must be a runtime dep
bun run check:golden-queries          # delegation-attenuation must be present
bun run test --filter=@koi/runtime    # golden-replay test must pass
```

## 10. Anti-leak checklist

- [x] No imports from L1 (`@koi/engine`) or peer L2 packages
- [x] No vendor types (LangGraph, OpenAI, etc.)
- [x] All interface properties `readonly`
- [x] Async-by-default (`isRevoked`, `verify`, `sign` return `T | Promise<T>`)
- [x] No external runtime deps
- [x] No throws on expected failures — typed `KoiError` returned
