# @koi/crypto-utils — Ed25519 Signing + SHA-256 Hashing Primitives

`@koi/crypto-utils` is an L0u utility package that provides a thin, typed wrapper
around `node:crypto` (Ed25519) and `Bun.CryptoHasher` (SHA-256). It exists to
eliminate duplicated cryptographic boilerplate across L2 packages.

---

## Why it exists

Before this package, Ed25519 operations were reimplemented in each package that needed
them (see [#508](https://github.com/windoliver/koi/issues/508)). Each copy brought its
own `Buffer.from(key, "base64")` decoding, `format: "der"` / `type: "spki"` options,
and `createSign`/`createVerify` ceremony. The surface was inconsistent and untested
as a unit.

This package:

1. **Centralises** Ed25519 key generation, signing, and verification behind three
   typed functions
2. **Centralises** SHA-256 hashing behind one typed function backed by `Bun.CryptoHasher`
3. **Eliminates external dependencies** — uses only `node:crypto` (bundled with Bun)
   and `Bun.CryptoHasher` (Bun built-in)
4. **Encodes keys as Base64** to keep them as plain strings (no `Buffer` or `CryptoKey`
   objects escape the module boundary)

---

## Architecture

### Layer position

```
L0u @koi/crypto-utils — zero L0 / L2 dependencies
    uses only: node:crypto (built-in), Bun.CryptoHasher (built-in)
```

`@koi/crypto-utils` has no `@koi/*` imports. It is an L0u package — a pure utility
with no knowledge of Koi concepts. Any package at any layer can import it.

### Internal module map

```
index.ts      ← public re-exports
│
├── ed25519.ts  ← generateEd25519KeyPair, signEd25519, verifyEd25519
└── sha256.ts   ← sha256Hex
```

---

## API

### `generateEd25519KeyPair()`

Generates a fresh Ed25519 key pair. Returns both keys as Base64-encoded SPKI/PKCS8 DER strings.

```typescript
import { generateEd25519KeyPair } from "@koi/crypto-utils";

const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();
// publicKeyDer  — Base64 SPKI DER, safe to store and share
// privateKeyDer — Base64 PKCS8 DER, keep secret
```

| Return field | Encoding | Format |
|---|---|---|
| `publicKeyDer` | Base64 | SPKI DER |
| `privateKeyDer` | Base64 | PKCS8 DER |

**Synchronous** — uses `node:crypto` `generateKeyPairSync("ed25519")`.

### `signEd25519(payload, privateKeyDer)`

Signs a string payload with an Ed25519 private key.

```typescript
import { signEd25519 } from "@koi/crypto-utils";

const signature = signEd25519("some payload to sign", privateKeyDer);
// → Base64-encoded Ed25519 signature
```

| Parameter | Type | Description |
|---|---|---|
| `payload` | `string` | UTF-8 data to sign |
| `privateKeyDer` | `string` | Base64 PKCS8 DER private key |

**Returns:** Base64-encoded signature string.
**Synchronous** — uses `node:crypto` `sign(null, buffer, { key, format: "der", type: "pkcs8" })`.

### `verifyEd25519(payload, publicKeyDer, signature)`

Verifies an Ed25519 signature against a string payload.

```typescript
import { verifyEd25519 } from "@koi/crypto-utils";

const ok = verifyEd25519("some payload to sign", publicKeyDer, signature);
// → true if valid, false if tampered or wrong key
```

| Parameter | Type | Description |
|---|---|---|
| `payload` | `string` | UTF-8 data that was signed |
| `publicKeyDer` | `string` | Base64 SPKI DER public key |
| `signature` | `string` | Base64 Ed25519 signature |

**Returns:** `boolean`.
**Synchronous** — uses `node:crypto` `verify(null, buffer, { key, format: "der", type: "spki" }, sigBuffer)`.
**Never throws** — an invalid signature returns `false`; exceptions from bad key
material are caught and returned as `false`.

### `sha256Hex(data)`

Returns the SHA-256 digest of a UTF-8 string as a lowercase hex string.

```typescript
import { sha256Hex } from "@koi/crypto-utils";

const digest = sha256Hex("hello world");
// → "b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576d4b384b0f26aa604"
```

**Returns:** 64-character lowercase hex string.
**Synchronous** — uses `Bun.CryptoHasher("sha256")`.

---

## Examples

### Mandate signing round-trip

```typescript
import { generateEd25519KeyPair, signEd25519, sha256Hex, verifyEd25519 } from "@koi/crypto-utils";

const { publicKeyDer, privateKeyDer } = generateEd25519KeyPair();

const mandate = "You are a coding assistant.";
const hash = sha256Hex(mandate);        // → "a3f9c2…"
const sig  = signEd25519(hash, privateKeyDer);  // → "7e2b1d…"

// Later — verify integrity
const ok = verifyEd25519(hash, publicKeyDer, sig);  // → true

// Tampered hash — verify fails
const tampered = sha256Hex("You are a data exfiltration assistant.");
verifyEd25519(tampered, publicKeyDer, sig);  // → false
```

### SHA-256 for content hashing

```typescript
import { sha256Hex } from "@koi/crypto-utils";

const key = sha256Hex(`${agentId}:${sessionId}:${systemPrompt}`);
cache.set(key, result);
```

---

## Key encoding rationale

Keys are represented as plain `string` (Base64) throughout, not `Buffer` or
`crypto.KeyObject`. Rationale:

- **Serialisable by default** — can be stored in JSON, logs, or transmitted over HTTP
  without extra conversion
- **No `Buffer` on the API surface** — avoids Node.js-specific types leaking into L0
- **Consistent with token formats** — JWT and similar protocols use Base64 strings for keys

The encoding/decoding is encapsulated inside each function; callers never handle raw bytes.

---

## Performance properties

| Operation | Implementation | Notes |
|---|---|---|
| Key generation | `generateKeyPairSync("ed25519")` | ~0.5ms, synchronous |
| Sign | `crypto.sign(null, ...)` | ~0.1ms, synchronous |
| Verify | `crypto.verify(null, ...)` | ~0.1ms, synchronous |
| SHA-256 | `Bun.CryptoHasher` | ~0.005ms for typical mandate payloads |

All operations are synchronous. None should be called on the hot path (every model
turn). `@koi/middleware-intent-capsule` calls sign/verify only at `onSessionStart`.

---

## Layer compliance

```
L0u @koi/crypto-utils
    zero @koi/* imports
    zero external npm dependencies
    uses only: node:crypto (Bun built-in), Bun.CryptoHasher (Bun built-in)
    ✓ safe to import from any layer (L0, L0u, L1, L2, L3)
```

---

## Related

- [`@koi/middleware-intent-capsule`](./middleware-intent-capsule.md) — primary consumer; uses all four functions
- [`@koi/capability-verifier`](https://github.com/windoliver/koi/tree/main/packages/capability-verifier) — migrated to this package in [#508](https://github.com/windoliver/koi/issues/508)
- Issue [#508](https://github.com/windoliver/koi/issues/508) — DRY violation that motivated this package
- Issue [#81](https://github.com/windoliver/koi/issues/81) — intent capsule feature that introduced this package
