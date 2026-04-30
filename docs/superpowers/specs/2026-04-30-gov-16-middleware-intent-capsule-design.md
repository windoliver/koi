# Design: @koi/middleware-intent-capsule (gov-16)

**Date:** 2026-04-30  
**Issue:** #1883  
**Parent:** #1208 (v2 Phase 3: governance umbrella)

---

## Problem

Prompt-injection attacks aim to hijack an agent's goal mid-execution by inserting "new instructions" into tool results (fetched pages, file content, memory retrieval). Without cryptographic binding, the agent has no way to verify its original mandate has not been overwritten.

Defends against **OWASP Agentic Top 10 ASI01** (Goal Hijacking).

---

## Decision

Port v1 `archive/v1/packages/security/middleware-intent-capsule/` to v2 with surgical adaptations. No new abstraction layers. API shape matches `docs/L2/middleware-intent-capsule.md` exactly.

**Crypto backend:** `node:crypto` (consistent with `@koi/governance-delegation`). Issue said `crypto.subtle` to mean "no npm packages" — `node:crypto` satisfies that and keeps the code sync/simpler.

**Nexus signer:** deferred to gov-5. No `MandateSigner` interface in this package.

---

## Package

```
packages/security/middleware-intent-capsule/
  package.json          name: @koi/middleware-intent-capsule
  tsconfig.json
  tsup.config.ts
  src/
    canonicalize.ts
    config.ts
    middleware.ts
    index.ts
    canonicalize.test.ts
    middleware.test.ts
```

### Dependencies

| Package | Why |
|---------|-----|
| `@koi/core` | `IntentCapsule`, `CapsuleVerifier`, `CapsuleVerifyResult`, `capsuleId`, middleware types |
| `@koi/errors` | `KoiRuntimeError` |
| `@koi/hash` | `computeStringHash` (SHA-256 via `Bun.CryptoHasher`) |
| `node:crypto` | `generateKeyPairSync`, `sign` (Ed25519) |

No external npm deps. No L1 or peer L2 imports.

---

## API

```typescript
// index.ts public surface
export type { MandateFields } from "./canonicalize.js";
export { canonicalizeMandatePayload } from "./canonicalize.js";
export type { IntentCapsuleConfig } from "./config.js";
export { DEFAULT_CAPSULE_TTL_MS } from "./config.js";
export { createIntentCapsuleMiddleware } from "./middleware.js";
```

```typescript
interface IntentCapsuleConfig {
  readonly systemPrompt: string;
  readonly objectives?: readonly string[];   // default: []
  readonly maxTtlMs?: number;                // default: 3_600_000 (1 hr)
  readonly injectMandate?: boolean;          // default: false
  readonly verifier?: CapsuleVerifier;       // default: hash-only verifier
}
```

Middleware: `name: "intent-capsule"`, `priority: 290`.  
Hooks: `onSessionStart`, `wrapModelCall`, `wrapModelStream`, `onSessionEnd`.

---

## Crypto implementation

### onSessionStart (one-time cost)

```typescript
import { generateKeyPairSync, sign } from "node:crypto";
import { computeStringHash } from "@koi/hash";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const mandateHash = computeStringHash(canonicalizeMandatePayload({ agentId, sessionId, systemPrompt, objectives }));
const signature   = sign(null, Buffer.from(mandateHash), privateKey).toString("base64");
const publicKeyB64 = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64");
```

### wrapModelCall / wrapModelStream (hot path — no crypto)

```typescript
const currentHash = computeStringHash(canonicalizeMandatePayload({ ... }));
const result = await verifier.verify(entry.capsule, currentHash);
// mismatch → throw KoiRuntimeError PERMISSION
```

### Default verifier (hash equality only)

```typescript
const defaultVerifier: CapsuleVerifier = {
  verify(capsule, currentMandateHash) {
    if (capsule.mandateHash !== currentMandateHash) {
      return { ok: false, reason: "mandate_hash_mismatch" };
    }
    return { ok: true, capsule };
  },
};
```

Signature stored in capsule for audit/external verification. No asymmetric crypto on hot path.

---

## Canonical mandate payload

```
v1
agentId:<agentId>
sessionId:<sessionId>
systemPrompt:<systemPrompt>
objectives:<sorted objectives joined with \n>
```

Objectives sorted lexicographically before joining — order-invariant.

---

## Error handling

All errors: `KoiRuntimeError`, code `"PERMISSION"`, `retryable: false`, fail-closed.

| Condition | `detail` |
|-----------|----------|
| `wrapModelCall` before `onSessionStart` | `"capsule_not_found"` |
| Hash mismatch | `"mandate_hash_mismatch"` |
| Invalid signature (custom verifier) | `"invalid_signature"` |

Context always includes `sessionId` + `capsuleId`.

---

## Tests

All 13 cases ported from v1 (`middleware.test.ts`):

1. Session start → model call passes
2. Empty objectives pass
3. Multiple sequential turns pass
4. Injectable verifier returns `ok: false` → `PERMISSION` thrown, `next` not called
5. Missing `onSessionStart` → `capsule_not_found`
6. Error context includes `sessionId` + `capsuleId`
7. `onSessionEnd` cleanup → subsequent call throws `capsule_not_found`
8. TTL eviction via `spyOn(Date, "now")`
9. Concurrent session isolation
10. `wrapModelStream` happy path yields chunks
11. `wrapModelStream` violation throws
12. `injectMandate: true` prepends `[Signed Mandate — v1]` message
13. `injectMandate: false` (default) does not inject

---

## Layer compliance

```
L0  @koi/core               IntentCapsule, CapsuleVerifier, middleware types
L0u @koi/errors             KoiRuntimeError
L0u @koi/hash               computeStringHash
L2  @koi/middleware-intent-capsule  ← this package
    imports L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2
```

---

## Out of scope

- `createNexusSigner` — deferred to gov-5
- `MandateSigner` interface — not needed until gov-5
- `createIntentCapsule` / `verifyIntentCapsule` standalone functions — internal to middleware (v1 pattern)
- Doctor rule `goal-hijack:missing-intent-capsule` — separate package
