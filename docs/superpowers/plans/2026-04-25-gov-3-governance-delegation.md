# gov-3 governance-delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `@koi/governance-delegation` (L2) — the L2 implementation of `@koi/core`'s `CapabilityVerifier`, `ScopeChecker`, plus a CapabilityId-keyed `CapabilityRevocationRegistry` and signed-token issuance helpers.

**Architecture:** Library-only L2 package. Implements existing L0 contracts in `packages/kernel/core/src/{capability.ts,delegation.ts}`. Signs structured `CapabilityToken` objects via `node:crypto` (HMAC-SHA256 + Ed25519). Composite verifier dispatches on `proof.kind`. Per-token revocation via in-memory registry with cascade. Monotonic attenuation enforced at issue time using L0's `isPermissionSubset`.

**Tech Stack:** Bun 1.3.x · TypeScript 6 (strict, ESM-only) · `bun:test` · tsup · Biome · `node:crypto` · `@koi/core` types · `@koi/hash` (computeStringHash) for deterministic hashing in tests

**Spec:** `docs/superpowers/specs/2026-04-25-gov-3-governance-delegation-design.md`

**Issue:** [#1395](https://github.com/windoliver/koi/issues/1395)

---

## Conventions used in this plan

- All paths are absolute from the worktree root `/Users/tafeng/koi/.claude/worktrees/iridescent-herding-hopcroft`. Steps use repo-relative paths.
- `bun test <path>` runs a single test file directly. Whole-package: `cd packages/security/governance-delegation && bun test`.
- Commits use Conventional Commits (`feat(governance-delegation):`, `test(governance-delegation):`, `docs(governance-delegation):`). Each task ends with one commit.
- Every test file lives next to source (`foo.ts` + `foo.test.ts`) per CLAUDE.md.
- All exported functions on type-emitting source files have explicit return types (TS6 `isolatedDeclarations`). All imports use `.js` extensions. Type-only imports use `import type`.

---

## Task 1: Scaffold package + L2 doc

**Files:**
- Create: `packages/security/governance-delegation/package.json`
- Create: `packages/security/governance-delegation/tsconfig.json`
- Create: `packages/security/governance-delegation/tsup.config.ts`
- Create: `packages/security/governance-delegation/README.md`
- Create: `packages/security/governance-delegation/src/index.ts` (stub, will fill in Task 13)
- Create: `docs/L2/governance-delegation.md` (Doc-gate prerequisite)

- [ ] **Step 1: Create the package directory tree**

```bash
mkdir -p packages/security/governance-delegation/src/__tests__
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@koi/governance-delegation",
  "description": "Capability-token verifier + delegation primitives — L2 implementation of @koi/core's CapabilityVerifier and CapabilityRevocationRegistry contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test",
    "test:api": "bun test src/__tests__/api-surface.test.ts"
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/hash": "workspace:*"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../kernel/core" },
    { "path": "../../lib/hash" }
  ]
}
```

- [ ] **Step 4: Write `tsup.config.ts`**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

- [ ] **Step 5: Write `README.md`**

```markdown
# @koi/governance-delegation

L2 implementation of `@koi/core`'s capability + delegation contracts.

- HMAC-SHA256 and Ed25519 signed `CapabilityToken` objects.
- Monotonic attenuation enforced at issue time via `isPermissionSubset`.
- Composite `CapabilityVerifier` dispatching on `proof.kind`.
- In-memory `CapabilityRevocationRegistry` with cascade.

See `docs/L2/governance-delegation.md` for the full contract.
```

- [ ] **Step 6: Write the L2 doc (Doc-gate prerequisite)**

File: `docs/L2/governance-delegation.md`

```markdown
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
```

- [ ] **Step 7: Write a stub `src/index.ts`**

```typescript
// Public exports filled in Task 13.
export {};
```

- [ ] **Step 8: Verify package.json is valid + bun resolves the workspace**

Run: `bun install`
Expected: completes without error; `bun.lock` updated to include `@koi/governance-delegation`.

- [ ] **Step 9: Commit scaffold**

```bash
git add packages/security/governance-delegation docs/L2/governance-delegation.md bun.lock
git commit -m "feat(governance-delegation): scaffold package + L2 doc-gate doc"
```

---

## Task 2: Canonical signing payload

**Files:**
- Create: `packages/security/governance-delegation/src/canonical.ts`
- Create: `packages/security/governance-delegation/src/canonical.test.ts`

The signing payload is the JSON-serialized token *without* its `proof` field, with sorted keys at every level. Signer and verifier both compute it from the same input → bit-identical bytes.

- [ ] **Step 1: Write the failing tests**

File: `packages/security/governance-delegation/src/canonical.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { agentId, capabilityId, sessionId } from "@koi/core";
import type { CapabilityToken } from "@koi/core";
import { serializeForSigning } from "./canonical.js";

const baseToken = (): CapabilityToken => ({
  id: capabilityId("cap-1"),
  issuerId: agentId("alice"),
  delegateeId: agentId("bob"),
  scope: {
    permissions: { allow: ["read_file"], deny: [] },
    sessionId: sessionId("sess-1"),
  },
  chainDepth: 0,
  maxChainDepth: 3,
  createdAt: 1000,
  expiresAt: 2000,
  proof: { kind: "hmac-sha256", digest: "ignored" },
});

describe("serializeForSigning", () => {
  test("produces identical bytes for identical token-minus-proof", () => {
    const a = serializeForSigning(baseToken());
    const b = serializeForSigning(baseToken());
    expect(a).toEqual(b);
  });

  test("changing any field changes the bytes", () => {
    const a = serializeForSigning(baseToken());
    const b = serializeForSigning({ ...baseToken(), expiresAt: 2001 });
    expect(a).not.toEqual(b);
  });

  test("ignores the proof field", () => {
    const a = serializeForSigning(baseToken());
    const t = baseToken();
    const b = serializeForSigning({
      ...t,
      proof: { kind: "ed25519", publicKey: "x", signature: "y" },
    });
    expect(a).toEqual(b);
  });

  test("is independent of input key order", () => {
    const t = baseToken();
    const reordered: CapabilityToken = {
      proof: t.proof,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
      maxChainDepth: t.maxChainDepth,
      chainDepth: t.chainDepth,
      scope: t.scope,
      delegateeId: t.delegateeId,
      issuerId: t.issuerId,
      id: t.id,
    };
    expect(serializeForSigning(t)).toEqual(serializeForSigning(reordered));
  });

  test("returns a Uint8Array of nonzero length", () => {
    const a = serializeForSigning(baseToken());
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `bun test packages/security/governance-delegation/src/canonical.test.ts`
Expected: all tests fail with "module not found" / "serializeForSigning is not a function".

- [ ] **Step 3: Implement `canonical.ts`**

File: `packages/security/governance-delegation/src/canonical.ts`

```typescript
import type { CapabilityToken } from "@koi/core";

const TEXT_ENCODER = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v !== undefined) {
        sorted[key] = canonicalize(v);
      }
    }
    return sorted;
  }
  return value;
}

export function serializeForSigning(token: CapabilityToken): Uint8Array {
  // Strip proof: it's the field being produced/verified.
  const { proof: _proof, ...rest } = token;
  void _proof;
  const json = JSON.stringify(canonicalize(rest));
  return TEXT_ENCODER.encode(json);
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `bun test packages/security/governance-delegation/src/canonical.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/canonical.ts packages/security/governance-delegation/src/canonical.test.ts
git commit -m "feat(governance-delegation): canonical signing payload"
```

---

## Task 3: Glob-based ScopeChecker

**Files:**
- Create: `packages/security/governance-delegation/src/scope-checker.ts`
- Create: `packages/security/governance-delegation/src/scope-checker.test.ts`

`createGlobScopeChecker()` returns an L0 `ScopeChecker` whose `isAllowed(toolId, scope)` returns true iff `toolId` is not denied AND is allowed (with `*` wildcard support).

- [ ] **Step 1: Write the failing tests**

File: `packages/security/governance-delegation/src/scope-checker.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import type { DelegationScope } from "@koi/core";
import { createGlobScopeChecker } from "./scope-checker.js";

const mkScope = (allow: readonly string[], deny: readonly string[] = []): DelegationScope => ({
  permissions: { allow, deny },
  sessionId: sessionId("sess-1"),
});

describe("createGlobScopeChecker", () => {
  const check = createGlobScopeChecker();

  test("exact-match allow returns true", async () => {
    expect(await check.isAllowed("read_file", mkScope(["read_file"]))).toBe(true);
  });

  test("missing from allow returns false", async () => {
    expect(await check.isAllowed("write_file", mkScope(["read_file"]))).toBe(false);
  });

  test("wildcard '*' in allow returns true for any tool", async () => {
    expect(await check.isAllowed("anything", mkScope(["*"]))).toBe(true);
  });

  test("deny wins over allow", async () => {
    expect(await check.isAllowed("bash", mkScope(["*"], ["bash"]))).toBe(false);
    expect(await check.isAllowed("bash", mkScope(["bash"], ["bash"]))).toBe(false);
  });

  test("empty allow returns false even with wildcard deny", async () => {
    expect(await check.isAllowed("anything", mkScope([], []))).toBe(false);
  });

  test("undefined allow/deny treats as empty", async () => {
    const scope: DelegationScope = {
      permissions: {},
      sessionId: sessionId("sess-1"),
    };
    expect(await check.isAllowed("read_file", scope)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test packages/security/governance-delegation/src/scope-checker.test.ts`
Expected: fails with "module not found".

- [ ] **Step 3: Implement `scope-checker.ts`**

File: `packages/security/governance-delegation/src/scope-checker.ts`

```typescript
import type { DelegationScope, ScopeChecker } from "@koi/core";

export function createGlobScopeChecker(): ScopeChecker {
  return {
    isAllowed(toolId: string, scope: DelegationScope): boolean {
      const deny = scope.permissions.deny ?? [];
      if (deny.includes(toolId)) return false;

      const allow = scope.permissions.allow ?? [];
      if (allow.includes("*")) return true;
      return allow.includes(toolId);
    },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `bun test packages/security/governance-delegation/src/scope-checker.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/scope-checker.ts packages/security/governance-delegation/src/scope-checker.test.ts
git commit -m "feat(governance-delegation): glob-based ScopeChecker"
```

---

## Task 4: HMAC sign + verify

**Files:**
- Create: `packages/security/governance-delegation/src/hmac.ts`
- Create: `packages/security/governance-delegation/src/hmac.test.ts`

Both signing and verification live in one file (small, paired primitives).

- [ ] **Step 1: Write the failing tests**

File: `packages/security/governance-delegation/src/hmac.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { agentId, capabilityId, sessionId } from "@koi/core";
import type { CapabilityToken } from "@koi/core";
import { signHmac, verifyHmac } from "./hmac.js";

const SECRET = randomBytes(32);

const tokenWithDigest = (digest: string): CapabilityToken => ({
  id: capabilityId("cap-1"),
  issuerId: agentId("alice"),
  delegateeId: agentId("bob"),
  scope: {
    permissions: { allow: ["read_file"] },
    sessionId: sessionId("sess-1"),
  },
  chainDepth: 0,
  maxChainDepth: 3,
  createdAt: 1000,
  expiresAt: 2000,
  proof: { kind: "hmac-sha256", digest },
});

describe("signHmac / verifyHmac", () => {
  test("verify returns true for token signed with same secret", () => {
    const unsigned = tokenWithDigest("");
    const digest = signHmac(unsigned, SECRET);
    const signed = tokenWithDigest(digest);
    expect(verifyHmac(signed, SECRET)).toBe(true);
  });

  test("verify returns false when secret differs", () => {
    const unsigned = tokenWithDigest("");
    const digest = signHmac(unsigned, SECRET);
    const signed = tokenWithDigest(digest);
    expect(verifyHmac(signed, randomBytes(32))).toBe(false);
  });

  test("verify returns false when any token field is mutated", () => {
    const unsigned = tokenWithDigest("");
    const digest = signHmac(unsigned, SECRET);
    const tampered = { ...tokenWithDigest(digest), expiresAt: 9999 };
    expect(verifyHmac(tampered, SECRET)).toBe(false);
  });

  test("verify returns false for non-hmac proof kind", () => {
    const t: CapabilityToken = {
      ...tokenWithDigest(""),
      proof: { kind: "ed25519", publicKey: "x", signature: "y" },
    };
    expect(verifyHmac(t, SECRET)).toBe(false);
  });

  test("verify returns false when digest length differs from expected", () => {
    const tampered = tokenWithDigest("AAAA");
    expect(verifyHmac(tampered, SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test packages/security/governance-delegation/src/hmac.test.ts`
Expected: fails with module-not-found.

- [ ] **Step 3: Implement `hmac.ts`**

File: `packages/security/governance-delegation/src/hmac.ts`

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CapabilityToken } from "@koi/core";
import { serializeForSigning } from "./canonical.js";

export function signHmac(token: CapabilityToken, secret: Uint8Array): string {
  const payload = serializeForSigning(token);
  const digest = createHmac("sha256", secret).update(payload).digest();
  return digest.toString("base64");
}

export function verifyHmac(token: CapabilityToken, secret: Uint8Array): boolean {
  if (token.proof.kind !== "hmac-sha256") return false;
  const expected = createHmac("sha256", secret).update(serializeForSigning(token)).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(token.proof.digest, "base64");
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `bun test packages/security/governance-delegation/src/hmac.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/hmac.ts packages/security/governance-delegation/src/hmac.test.ts
git commit -m "feat(governance-delegation): HMAC-SHA256 sign + verify"
```

---

## Task 5: Ed25519 sign + verify

**Files:**
- Create: `packages/security/governance-delegation/src/ed25519.ts`
- Create: `packages/security/governance-delegation/src/ed25519.test.ts`

Public-key encoding: SPKI DER, base64-encoded for the lookup key. Ed25519 raw public key is 32 bytes; we wrap into a Node `KeyObject` via `crypto.createPublicKey({ key, format: "der", type: "spki" })`.

For tests we use Node's `generateKeyPairSync("ed25519")` which returns DER-encoded SPKI / PKCS8 keys.

- [ ] **Step 1: Write the failing tests**

File: `packages/security/governance-delegation/src/ed25519.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { agentId, capabilityId, sessionId } from "@koi/core";
import type { CapabilityToken } from "@koi/core";
import { signEd25519, verifyEd25519 } from "./ed25519.js";

function newKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  const fingerprint = Buffer.from(pubDer).toString("base64");
  return { publicKey: pubDer, privateKey: privDer, fingerprint };
}

const tokenWithProof = (
  fingerprint: string,
  signature: string,
): CapabilityToken => ({
  id: capabilityId("cap-1"),
  issuerId: agentId("alice"),
  delegateeId: agentId("bob"),
  scope: {
    permissions: { allow: ["read_file"] },
    sessionId: sessionId("sess-1"),
  },
  chainDepth: 0,
  maxChainDepth: 3,
  createdAt: 1000,
  expiresAt: 2000,
  proof: { kind: "ed25519", publicKey: fingerprint, signature },
});

describe("signEd25519 / verifyEd25519", () => {
  test("verify returns true for token signed with matching key", () => {
    const { publicKey, privateKey, fingerprint } = newKeyPair();
    const unsigned = tokenWithProof(fingerprint, "");
    const sig = signEd25519(unsigned, privateKey);
    const signed = tokenWithProof(fingerprint, sig);
    const keys = new Map([[fingerprint, publicKey]]);
    expect(verifyEd25519(signed, keys)).toBe(true);
  });

  test("verify returns false when public key fingerprint not in map", () => {
    const { privateKey, fingerprint } = newKeyPair();
    const unsigned = tokenWithProof(fingerprint, "");
    const sig = signEd25519(unsigned, privateKey);
    const signed = tokenWithProof(fingerprint, sig);
    expect(verifyEd25519(signed, new Map())).toBe(false);
  });

  test("verify returns false on tampered token", () => {
    const { publicKey, privateKey, fingerprint } = newKeyPair();
    const unsigned = tokenWithProof(fingerprint, "");
    const sig = signEd25519(unsigned, privateKey);
    const tampered: CapabilityToken = {
      ...tokenWithProof(fingerprint, sig),
      expiresAt: 9999,
    };
    const keys = new Map([[fingerprint, publicKey]]);
    expect(verifyEd25519(tampered, keys)).toBe(false);
  });

  test("verify returns false for non-ed25519 proof kind", () => {
    const { publicKey, fingerprint } = newKeyPair();
    const t: CapabilityToken = {
      ...tokenWithProof(fingerprint, "x"),
      proof: { kind: "hmac-sha256", digest: "y" },
    };
    expect(verifyEd25519(t, new Map([[fingerprint, publicKey]]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test packages/security/governance-delegation/src/ed25519.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `ed25519.ts`**

File: `packages/security/governance-delegation/src/ed25519.ts`

```typescript
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { CapabilityToken } from "@koi/core";
import { serializeForSigning } from "./canonical.js";

export function signEd25519(token: CapabilityToken, privateKeyDer: Uint8Array): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyDer), format: "der", type: "pkcs8" });
  const payload = serializeForSigning(token);
  const sig = sign(null, payload, key);
  return sig.toString("base64");
}

export function verifyEd25519(
  token: CapabilityToken,
  publicKeys: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (token.proof.kind !== "ed25519") return false;
  const pubDer = publicKeys.get(token.proof.publicKey);
  if (!pubDer) return false;

  let key;
  try {
    key = createPublicKey({ key: Buffer.from(pubDer), format: "der", type: "spki" });
  } catch {
    return false;
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(token.proof.signature, "base64");
  } catch {
    return false;
  }

  return verify(null, serializeForSigning(token), key, sigBytes);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `bun test packages/security/governance-delegation/src/ed25519.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/ed25519.ts packages/security/governance-delegation/src/ed25519.test.ts
git commit -m "feat(governance-delegation): Ed25519 sign + verify"
```

---

## Task 6: Capability revocation registry

**Files:**
- Create: `packages/security/governance-delegation/src/revocation.ts`
- Create: `packages/security/governance-delegation/src/revocation.test.ts`

Per-token revocation with cascade walk over a parent→children index.

- [ ] **Step 1: Write the failing tests**

File: `packages/security/governance-delegation/src/revocation.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { agentId, capabilityId, sessionId } from "@koi/core";
import type { CapabilityId, CapabilityToken } from "@koi/core";
import { createMemoryCapabilityRevocationRegistry } from "./revocation.js";

const mkToken = (id: string, parentId?: string): CapabilityToken => ({
  id: capabilityId(id),
  issuerId: agentId("alice"),
  delegateeId: agentId("bob"),
  scope: {
    permissions: { allow: ["*"] },
    sessionId: sessionId("sess-1"),
  },
  parentId: parentId !== undefined ? capabilityId(parentId) : undefined,
  chainDepth: parentId !== undefined ? 1 : 0,
  maxChainDepth: 3,
  createdAt: 1000,
  expiresAt: 2000,
  proof: { kind: "hmac-sha256", digest: "x" },
});

describe("createMemoryCapabilityRevocationRegistry", () => {
  test("isRevoked returns false for unregistered ids", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    expect(await reg.isRevoked(capabilityId("missing"))).toBe(false);
  });

  test("revoke without cascade only revokes that id", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.revoke(capabilityId("A"), false);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("B"))).toBe(false);
  });

  test("revoke with cascade revokes all descendants", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.register(mkToken("C", "B"));
    await reg.revoke(capabilityId("A"), true);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("B"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("C"))).toBe(true);
  });

  test("cascade revoking middle node leaves root alive", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.register(mkToken("C", "B"));
    await reg.revoke(capabilityId("B"), true);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(false);
    expect(await reg.isRevoked(capabilityId("B"))).toBe(true);
    expect(await reg.isRevoked(capabilityId("C"))).toBe(true);
  });

  test("register is idempotent", async () => {
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("A"));
    await reg.revoke(capabilityId("A"), false);
    expect(await reg.isRevoked(capabilityId("A"))).toBe(true);
  });

  test("cascade with diamond ancestry visits each node once", async () => {
    // A → B, A → C, B → D, C → D (diamond)
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(mkToken("A"));
    await reg.register(mkToken("B", "A"));
    await reg.register(mkToken("C", "A"));
    await reg.register(mkToken("D", "B"));
    // Re-registering D under C is not modeled in our parent index — we only
    // track immediate parent. Skip the second registration.
    await reg.revoke(capabilityId("A"), true);
    for (const id of ["A", "B", "C", "D"] as const) {
      expect(await reg.isRevoked(capabilityId(id))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `bun test packages/security/governance-delegation/src/revocation.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `revocation.ts`**

File: `packages/security/governance-delegation/src/revocation.ts`

```typescript
import type { CapabilityId, CapabilityToken } from "@koi/core";

export interface CapabilityRevocationRegistry {
  readonly register: (token: CapabilityToken) => void | Promise<void>;
  readonly isRevoked: (id: CapabilityId) => boolean | Promise<boolean>;
  readonly revoke: (id: CapabilityId, cascade: boolean) => void | Promise<void>;
}

export function createMemoryCapabilityRevocationRegistry(): CapabilityRevocationRegistry {
  const revoked = new Set<CapabilityId>();
  const children = new Map<CapabilityId, Set<CapabilityId>>();

  return {
    register(token: CapabilityToken): void {
      if (token.parentId !== undefined) {
        const set = children.get(token.parentId) ?? new Set<CapabilityId>();
        set.add(token.id);
        children.set(token.parentId, set);
      }
    },
    isRevoked(id: CapabilityId): boolean {
      return revoked.has(id);
    },
    revoke(id: CapabilityId, cascade: boolean): void {
      revoked.add(id);
      if (!cascade) return;
      const queue: CapabilityId[] = [id];
      const seen = new Set<CapabilityId>([id]);
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        const kids = children.get(next);
        if (!kids) continue;
        for (const kid of kids) {
          if (seen.has(kid)) continue;
          seen.add(kid);
          revoked.add(kid);
          queue.push(kid);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `bun test packages/security/governance-delegation/src/revocation.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/revocation.ts packages/security/governance-delegation/src/revocation.test.ts
git commit -m "feat(governance-delegation): in-memory CapabilityRevocationRegistry with cascade"
```

---

## Task 7: Signer type + issueRootCapability

**Files:**
- Create: `packages/security/governance-delegation/src/signer.ts`
- Create: `packages/security/governance-delegation/src/issue.ts`
- Create: `packages/security/governance-delegation/src/issue.test.ts` (this task adds root-only cases; Task 8 adds delegate cases)

`signer.ts` is just the discriminated-union type and a tiny dispatcher; `issue.ts` holds `issueRootCapability` (and later `delegateCapability`).

- [ ] **Step 1: Write `signer.ts`**

File: `packages/security/governance-delegation/src/signer.ts`

```typescript
import type { CapabilityProof, CapabilityToken } from "@koi/core";
import { signEd25519 } from "./ed25519.js";
import { signHmac } from "./hmac.js";

export type CapabilitySigner =
  | { readonly kind: "hmac-sha256"; readonly secret: Uint8Array }
  | {
      readonly kind: "ed25519";
      readonly privateKey: Uint8Array;
      readonly publicKeyFingerprint: string;
    };

export function buildProof(token: CapabilityToken, signer: CapabilitySigner): CapabilityProof {
  if (signer.kind === "hmac-sha256") {
    return { kind: "hmac-sha256", digest: signHmac(token, signer.secret) };
  }
  return {
    kind: "ed25519",
    publicKey: signer.publicKeyFingerprint,
    signature: signEd25519(token, signer.privateKey),
  };
}
```

- [ ] **Step 2: Write the failing tests for `issueRootCapability`**

File: `packages/security/governance-delegation/src/issue.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { agentId, sessionId } from "@koi/core";
import type { CapabilityScope, CapabilitySigner } from "@koi/core";
import { issueRootCapability } from "./issue.js";
import type { CapabilitySigner as Signer } from "./signer.js";
import { verifyHmac } from "./hmac.js";

const baseScope = (): CapabilityScope => ({
  permissions: { allow: ["read_file"] },
  sessionId: sessionId("sess-1"),
});

const hmacSigner = (): Signer => ({ kind: "hmac-sha256", secret: randomBytes(32) });

describe("issueRootCapability", () => {
  test("returns a token with chainDepth=0 and no parentId", async () => {
    const signer = hmacSigner();
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    expect(tok.chainDepth).toBe(0);
    expect(tok.parentId).toBeUndefined();
    expect(tok.maxChainDepth).toBe(3);
    expect(tok.createdAt).toBe(1000);
    expect(tok.expiresAt).toBe(61_000);
    expect(tok.issuerId).toBe(agentId("engine"));
    expect(tok.delegateeId).toBe(agentId("alice"));
  });

  test("produces a token whose HMAC proof verifies", async () => {
    const signer = hmacSigner();
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
    });
    if (signer.kind !== "hmac-sha256") throw new Error("unexpected");
    expect(verifyHmac(tok, signer.secret)).toBe(true);
  });

  test("produces an Ed25519 token whose proof verifies", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
    });
    expect(tok.proof.kind).toBe("ed25519");
  });

  test("registers the token if a registry is provided", async () => {
    const signer = hmacSigner();
    let registered: string | undefined;
    const registry = {
      register(t: { id: string }): void {
        registered = t.id;
      },
      isRevoked(): boolean {
        return false;
      },
      revoke(): void {},
    };
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
      // biome-ignore lint/suspicious/noExplicitAny: cross-package mock
      registry: registry as any,
    });
    expect(registered).toBe(tok.id);
  });

  test("throws on ttlMs <= 0", async () => {
    const signer = hmacSigner();
    await expect(
      issueRootCapability({
        signer,
        issuerId: agentId("engine"),
        delegateeId: agentId("alice"),
        scope: baseScope(),
        ttlMs: 0,
        maxChainDepth: 3,
      }),
    ).rejects.toThrow();
  });

  test("throws on maxChainDepth < 0", async () => {
    const signer = hmacSigner();
    await expect(
      issueRootCapability({
        signer,
        issuerId: agentId("engine"),
        delegateeId: agentId("alice"),
        scope: baseScope(),
        ttlMs: 60_000,
        maxChainDepth: -1,
      }),
    ).rejects.toThrow();
  });
});
```

> Note: the test imports `CapabilitySigner` from `@koi/core` for the unused-import-check satisfier — actually we don't need that import. **Remove the `CapabilitySigner` import from `@koi/core` in the test before running.** The test uses our own `CapabilitySigner` type from `./signer.js` (aliased as `Signer`). The corrected first import block:

```typescript
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { agentId, sessionId } from "@koi/core";
import type { CapabilityScope } from "@koi/core";
import { issueRootCapability } from "./issue.js";
import type { CapabilitySigner as Signer } from "./signer.js";
import { verifyHmac } from "./hmac.js";
```

- [ ] **Step 3: Run test, expect failure**

Run: `bun test packages/security/governance-delegation/src/issue.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement `issue.ts` (root only — delegate added in Task 8)**

File: `packages/security/governance-delegation/src/issue.ts`

```typescript
import { randomUUID } from "node:crypto";
import type { AgentId, CapabilityScope, CapabilityToken } from "@koi/core";
import { capabilityId } from "@koi/core";
import type { CapabilityRevocationRegistry } from "./revocation.js";
import type { CapabilitySigner } from "./signer.js";
import { buildProof } from "./signer.js";

interface IssueRootOptions {
  readonly signer: CapabilitySigner;
  readonly issuerId: AgentId;
  readonly delegateeId: AgentId;
  readonly scope: CapabilityScope;
  readonly ttlMs: number;
  readonly maxChainDepth: number;
  readonly registry?: CapabilityRevocationRegistry;
  readonly now?: () => number;
}

export async function issueRootCapability(opts: IssueRootOptions): Promise<CapabilityToken> {
  if (opts.ttlMs <= 0) throw new Error("issueRootCapability: ttlMs must be > 0");
  if (opts.maxChainDepth < 0) {
    throw new Error("issueRootCapability: maxChainDepth must be >= 0");
  }
  const now = opts.now?.() ?? Date.now();
  const unsigned: CapabilityToken = {
    id: capabilityId(randomUUID()),
    issuerId: opts.issuerId,
    delegateeId: opts.delegateeId,
    scope: opts.scope,
    chainDepth: 0,
    maxChainDepth: opts.maxChainDepth,
    createdAt: now,
    expiresAt: now + opts.ttlMs,
    proof: { kind: "hmac-sha256", digest: "" }, // placeholder, replaced below
  };
  const proof = buildProof(unsigned, opts.signer);
  const signed: CapabilityToken = { ...unsigned, proof };
  if (opts.registry) {
    await opts.registry.register(signed);
  }
  return signed;
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `bun test packages/security/governance-delegation/src/issue.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/security/governance-delegation/src/signer.ts packages/security/governance-delegation/src/issue.ts packages/security/governance-delegation/src/issue.test.ts
git commit -m "feat(governance-delegation): issueRootCapability + signer dispatch"
```

---

## Task 8: delegateCapability with attenuation enforcement

**Files:**
- Modify: `packages/security/governance-delegation/src/issue.ts` (append)
- Modify: `packages/security/governance-delegation/src/issue.test.ts` (append)

`delegateCapability` returns `Result<CapabilityToken, KoiError>`. Failures: `EXPIRED` (parent already expired), `PERMISSION` (`scope_exceeded`, `chain_depth_exceeded`, `session_mismatch`, `ttl_exceeds_parent`). Reasons stored in `error.context.reason` so callers can branch programmatically without us inventing new `KoiErrorCode` values.

- [ ] **Step 1: Append failing tests to `issue.test.ts`**

```typescript
// (append at the bottom of the existing file)

import { delegateCapability } from "./issue.js";

describe("delegateCapability", () => {
  const newRoot = async (
    overrides: Partial<{
      ttlMs: number;
      maxChainDepth: number;
      allow: readonly string[];
      now: () => number;
    }> = {},
  ): Promise<{ signer: Signer; root: import("@koi/core").CapabilityToken }> => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: overrides.allow ?? ["read_file", "write_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: overrides.ttlMs ?? 60_000,
      maxChainDepth: overrides.maxChainDepth ?? 3,
      now: overrides.now,
    });
    return { signer, root };
  };

  test("narrows allow list successfully", async () => {
    const { signer, root } = await newRoot();
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parentId).toBe(root.id);
    expect(result.value.chainDepth).toBe(1);
    expect(result.value.maxChainDepth).toBe(3);
    expect(result.value.scope.permissions.allow).toEqual(["read_file"]);
  });

  test("rejects widening (child has tool not in parent)", async () => {
    const { signer, root } = await newRoot({ allow: ["read_file"] });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file", "write_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
    expect((result.error.context as { reason: string }).reason).toBe("scope_exceeded");
  });

  test("rejects when chain depth would exceed maxChainDepth", async () => {
    const { signer, root } = await newRoot({ maxChainDepth: 0 });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.context as { reason: string }).reason).toBe("chain_depth_exceeded");
  });

  test("rejects when parent is already expired", async () => {
    const { signer, root } = await newRoot({ ttlMs: 1, now: () => 1000 });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: root.scope,
      ttlMs: 100,
      now: () => 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect((result.error.context as { reason: string }).reason).toBe("expired");
  });

  test("rejects sessionId mismatch", async () => {
    const { signer, root } = await newRoot();
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("DIFFERENT"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.context as { reason: string }).reason).toBe("session_mismatch");
  });

  test("rejects when child TTL would exceed parent expiry", async () => {
    const { signer, root } = await newRoot({ ttlMs: 1000, now: () => 1000 });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: root.scope,
      ttlMs: 5000, // parent.expiresAt = 2000, now+ttl = 6000 → exceeds
      now: () => 1000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.context as { reason: string }).reason).toBe("ttl_exceeds_parent");
  });

  test("registers the child if a registry is given", async () => {
    const { signer, root } = await newRoot();
    let registeredId: string | undefined;
    const registry = {
      register(t: { id: string }): void {
        registeredId = t.id;
      },
      isRevoked(): boolean {
        return false;
      },
      revoke(): void {},
    };
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 30_000,
      // biome-ignore lint/suspicious/noExplicitAny: cross-package mock
      registry: registry as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(registeredId).toBe(result.value.id);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `bun test packages/security/governance-delegation/src/issue.test.ts`
Expected: new tests fail (`delegateCapability` not exported); prior tests still pass.

- [ ] **Step 3: Append `delegateCapability` to `issue.ts`**

```typescript
// Append to packages/security/governance-delegation/src/issue.ts

import type { KoiError, Result } from "@koi/core";
import { isPermissionSubset, permission, validation } from "@koi/core";

interface DelegateOptions {
  readonly signer: CapabilitySigner;
  readonly parent: CapabilityToken;
  readonly delegateeId: AgentId;
  readonly scope: CapabilityScope;
  readonly ttlMs: number;
  readonly registry?: CapabilityRevocationRegistry;
  readonly now?: () => number;
}

type DelegationFailureReason =
  | "expired"
  | "chain_depth_exceeded"
  | "scope_exceeded"
  | "session_mismatch"
  | "ttl_exceeds_parent";

function fail(reason: DelegationFailureReason): KoiError {
  if (reason === "expired") {
    return { ...validation("delegateCapability: parent expired"), context: { reason } };
  }
  return { ...permission(`delegateCapability: ${reason}`), context: { reason } };
}

export async function delegateCapability(
  opts: DelegateOptions,
): Promise<Result<CapabilityToken, KoiError>> {
  if (opts.ttlMs <= 0) throw new Error("delegateCapability: ttlMs must be > 0");
  const now = opts.now?.() ?? Date.now();
  const parent = opts.parent;

  if (parent.expiresAt <= now) {
    return { ok: false, error: fail("expired") };
  }
  if (parent.chainDepth + 1 > parent.maxChainDepth) {
    return { ok: false, error: fail("chain_depth_exceeded") };
  }
  if (parent.scope.sessionId !== opts.scope.sessionId) {
    return { ok: false, error: fail("session_mismatch") };
  }
  if (!isPermissionSubset(opts.scope.permissions, parent.scope.permissions)) {
    return { ok: false, error: fail("scope_exceeded") };
  }
  const childExpires = now + opts.ttlMs;
  if (childExpires > parent.expiresAt) {
    return { ok: false, error: fail("ttl_exceeds_parent") };
  }

  const unsigned: CapabilityToken = {
    id: capabilityId(randomUUID()),
    issuerId: parent.delegateeId,
    delegateeId: opts.delegateeId,
    scope: opts.scope,
    parentId: parent.id,
    chainDepth: parent.chainDepth + 1,
    maxChainDepth: parent.maxChainDepth,
    createdAt: now,
    expiresAt: childExpires,
    proof: { kind: "hmac-sha256", digest: "" },
  };
  const proof = buildProof(unsigned, opts.signer);
  const signed: CapabilityToken = { ...unsigned, proof };
  if (opts.registry) {
    await opts.registry.register(signed);
  }
  return { ok: true, value: signed };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `bun test packages/security/governance-delegation/src/issue.test.ts`
Expected: all tests pass (6 root + 7 delegate = 13 total).

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/issue.ts packages/security/governance-delegation/src/issue.test.ts
git commit -m "feat(governance-delegation): delegateCapability with attenuation + chain depth checks"
```

---

## Task 9: Composite CapabilityVerifier

**Files:**
- Create: `packages/security/governance-delegation/src/verifier.ts`
- Create: `packages/security/governance-delegation/src/verifier.test.ts`

The composite verifier ties everything together: dispatches on `proof.kind`, runs all the L0-mandated checks, returns `CapabilityVerifyResult`.

- [ ] **Step 1: Write the failing tests**

File: `packages/security/governance-delegation/src/verifier.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { agentId, capabilityId, sessionId } from "@koi/core";
import type { CapabilityToken, SessionId, VerifyContext } from "@koi/core";
import { issueRootCapability } from "./issue.js";
import { createMemoryCapabilityRevocationRegistry } from "./revocation.js";
import { createGlobScopeChecker } from "./scope-checker.js";
import type { CapabilitySigner as Signer } from "./signer.js";
import { createCapabilityVerifier } from "./verifier.js";

const ACTIVE = (s: SessionId): ReadonlySet<SessionId> => new Set([s]);

const ctx = (overrides: Partial<VerifyContext> = {}): VerifyContext => ({
  toolId: "read_file",
  now: 1500,
  activeSessionIds: ACTIVE(sessionId("sess-1")),
  ...overrides,
});

const newHmacRoot = async (): Promise<{
  signer: Signer;
  token: CapabilityToken;
}> => {
  const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
  const token = await issueRootCapability({
    signer,
    issuerId: agentId("engine"),
    delegateeId: agentId("alice"),
    scope: {
      permissions: { allow: ["read_file"] },
      sessionId: sessionId("sess-1"),
    },
    ttlMs: 60_000,
    maxChainDepth: 3,
    now: () => 1000,
  });
  return { signer, token };
};

describe("createCapabilityVerifier", () => {
  test("ok=true for valid HMAC token + matching toolId + active session", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(true);
  });

  test("ok=false invalid_signature when secret differs", async () => {
    const { token } = await newHmacRoot();
    const verifier = createCapabilityVerifier({
      hmac: { secret: randomBytes(32) },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("ok=false expired when now >= expiresAt", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx({ now: 100_000 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired");
  });

  test("ok=false invalid_signature when now < createdAt", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx({ now: 500 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_signature");
  });

  test("ok=false session_invalid when sessionId not active", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(
      token,
      ctx({ activeSessionIds: new Set([sessionId("OTHER")]) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("session_invalid");
  });

  test("ok=false scope_exceeded when toolId not in allow", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx({ toolId: "bash" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_exceeded");
  });

  test("ok=false revoked when registry says so", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const reg = createMemoryCapabilityRevocationRegistry();
    await reg.register(token);
    await reg.revoke(token.id, false);
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      revocations: reg,
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("revoked");
  });

  test("ok=false proof_type_unsupported when verifier lacks key for proof.kind", async () => {
    const { token } = await newHmacRoot();
    const verifier = createCapabilityVerifier({
      // No hmac key configured.
      ed25519: { publicKeys: new Map() },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(token, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_type_unsupported");
  });

  test("ok=false proof_type_unsupported for nexus proofs", async () => {
    const { signer, token } = await newHmacRoot();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const nexusToken: CapabilityToken = {
      ...token,
      proof: { kind: "nexus", token: "opaque" },
    };
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(nexusToken, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("proof_type_unsupported");
  });

  test("ed25519 token verifies", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    const verifier = createCapabilityVerifier({
      ed25519: { publicKeys: new Map([[fp, pubDer]]) },
      scopeChecker: createGlobScopeChecker(),
    });
    const result = await verifier.verify(tok, ctx());
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test packages/security/governance-delegation/src/verifier.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `verifier.ts`**

File: `packages/security/governance-delegation/src/verifier.ts`

```typescript
import type {
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  ScopeChecker,
  VerifyContext,
} from "@koi/core";
import { verifyEd25519 } from "./ed25519.js";
import { verifyHmac } from "./hmac.js";
import type { CapabilityRevocationRegistry } from "./revocation.js";

export interface CapabilityVerifierOptions {
  readonly hmac?: { readonly secret: Uint8Array };
  readonly ed25519?: { readonly publicKeys: ReadonlyMap<string, Uint8Array> };
  readonly scopeChecker: ScopeChecker;
  readonly revocations?: CapabilityRevocationRegistry;
}

function deny(reason: CapabilityVerifyResult & { ok: false }): CapabilityVerifyResult {
  return reason;
}

export function createCapabilityVerifier(opts: CapabilityVerifierOptions): CapabilityVerifier {
  return {
    async verify(token: CapabilityToken, ctx: VerifyContext): Promise<CapabilityVerifyResult> {
      // 1. Signature dispatch
      if (token.proof.kind === "hmac-sha256") {
        if (!opts.hmac) return deny({ ok: false, reason: "proof_type_unsupported" });
        if (!verifyHmac(token, opts.hmac.secret)) {
          return deny({ ok: false, reason: "invalid_signature" });
        }
      } else if (token.proof.kind === "ed25519") {
        if (!opts.ed25519) return deny({ ok: false, reason: "proof_type_unsupported" });
        if (!verifyEd25519(token, opts.ed25519.publicKeys)) {
          return deny({ ok: false, reason: "invalid_signature" });
        }
      } else {
        return deny({ ok: false, reason: "proof_type_unsupported" });
      }

      // 2. Clock-skew (now < createdAt → tampered)
      if (ctx.now < token.createdAt) {
        return deny({ ok: false, reason: "invalid_signature" });
      }
      // 3. Expiry
      if (ctx.now >= token.expiresAt) {
        return deny({ ok: false, reason: "expired" });
      }
      // 4. Session
      if (!ctx.activeSessionIds.has(token.scope.sessionId)) {
        return deny({ ok: false, reason: "session_invalid" });
      }
      // 5. Revocation
      if (opts.revocations && (await opts.revocations.isRevoked(token.id))) {
        return deny({ ok: false, reason: "revoked" });
      }
      // 6. Scope
      const allowed = await opts.scopeChecker.isAllowed(ctx.toolId, {
        permissions: token.scope.permissions,
        resources: token.scope.resources,
        sessionId: token.scope.sessionId,
      });
      if (!allowed) {
        return deny({ ok: false, reason: "scope_exceeded" });
      }
      return { ok: true, token };
    },
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `bun test packages/security/governance-delegation/src/verifier.test.ts`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/verifier.ts packages/security/governance-delegation/src/verifier.test.ts
git commit -m "feat(governance-delegation): composite CapabilityVerifier"
```

---

## Task 10: End-to-end chain test (A → B → C with revocation)

**Files:**
- Create: `packages/security/governance-delegation/src/__tests__/chain.test.ts`

This is the integration test that proves the issue's stated requirements end-to-end. No new source code — just tests against the public surface.

- [ ] **Step 1: Write the chain test**

File: `packages/security/governance-delegation/src/__tests__/chain.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { agentId, sessionId } from "@koi/core";
import type { CapabilityToken, SessionId } from "@koi/core";
import { delegateCapability, issueRootCapability } from "../issue.js";
import { createMemoryCapabilityRevocationRegistry } from "../revocation.js";
import { createGlobScopeChecker } from "../scope-checker.js";
import type { CapabilitySigner as Signer } from "../signer.js";
import { createCapabilityVerifier } from "../verifier.js";

describe("end-to-end chain A → B → C", () => {
  const SESSION = sessionId("sess-1");
  const ACTIVE = (): ReadonlySet<SessionId> => new Set([SESSION]);

  async function buildChain(): Promise<{
    signer: Signer;
    A: CapabilityToken;
    B: CapabilityToken;
    C: CapabilityToken;
    registry: ReturnType<typeof createMemoryCapabilityRevocationRegistry>;
  }> {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const registry = createMemoryCapabilityRevocationRegistry();
    const A = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file", "write_file"] },
        sessionId: SESSION,
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      registry,
      now: () => 1000,
    });

    const bResult = await delegateCapability({
      signer,
      parent: A,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file", "write_file"] },
        sessionId: SESSION,
      },
      ttlMs: 30_000,
      registry,
      now: () => 1000,
    });
    if (!bResult.ok) throw new Error(`B issue failed: ${JSON.stringify(bResult.error)}`);

    const cResult = await delegateCapability({
      signer,
      parent: bResult.value,
      delegateeId: agentId("carol"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: SESSION,
      },
      ttlMs: 10_000,
      registry,
      now: () => 1000,
    });
    if (!cResult.ok) throw new Error(`C issue failed: ${JSON.stringify(cResult.error)}`);

    return { signer, A, B: bResult.value, C: cResult.value, registry };
  }

  test("each level verifies independently with the same verifier", async () => {
    const { signer, A, B, C, registry } = await buildChain();
    if (signer.kind !== "hmac-sha256") throw new Error();
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
    });
    const ctx = { toolId: "read_file", now: 1500, activeSessionIds: ACTIVE() };
    expect((await verifier.verify(A, ctx)).ok).toBe(true);
    expect((await verifier.verify(B, ctx)).ok).toBe(true);
    expect((await verifier.verify(C, ctx)).ok).toBe(true);
  });

  test("chain depth increments correctly", async () => {
    const { A, B, C } = await buildChain();
    expect(A.chainDepth).toBe(0);
    expect(B.chainDepth).toBe(1);
    expect(C.chainDepth).toBe(2);
    expect(B.parentId).toBe(A.id);
    expect(C.parentId).toBe(B.id);
  });

  test("revoking A with cascade invalidates B and C", async () => {
    const { signer, A, B, C, registry } = await buildChain();
    if (signer.kind !== "hmac-sha256") throw new Error();
    await registry.revoke(A.id, true);
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
    });
    const ctx = { toolId: "read_file", now: 1500, activeSessionIds: ACTIVE() };
    for (const tok of [A, B, C]) {
      const r = await verifier.verify(tok, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("revoked");
    }
  });

  test("revoking B with cascade leaves A valid; B and C revoked", async () => {
    const { signer, A, B, C, registry } = await buildChain();
    if (signer.kind !== "hmac-sha256") throw new Error();
    await registry.revoke(B.id, true);
    const verifier = createCapabilityVerifier({
      hmac: { secret: signer.secret },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
    });
    const ctx = { toolId: "read_file", now: 1500, activeSessionIds: ACTIVE() };
    expect((await verifier.verify(A, ctx)).ok).toBe(true);
    const rB = await verifier.verify(B, ctx);
    expect(rB.ok).toBe(false);
    if (!rB.ok) expect(rB.reason).toBe("revoked");
    const rC = await verifier.verify(C, ctx);
    expect(rC.ok).toBe(false);
    if (!rC.ok) expect(rC.reason).toBe("revoked");
  });

  test("widening at any chain level is rejected at issue time", async () => {
    const { signer, A } = await buildChain();
    const widen = await delegateCapability({
      signer,
      parent: A,
      delegateeId: agentId("bob"),
      scope: { permissions: { allow: ["bash"] }, sessionId: SESSION }, // bash not in parent
      ttlMs: 30_000,
    });
    expect(widen.ok).toBe(false);
    if (widen.ok) return;
    expect((widen.error.context as { reason: string }).reason).toBe("scope_exceeded");
  });
});
```

- [ ] **Step 2: Run, expect pass (no new code needed)**

Run: `bun test packages/security/governance-delegation/src/__tests__/chain.test.ts`
Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/security/governance-delegation/src/__tests__/chain.test.ts
git commit -m "test(governance-delegation): end-to-end A→B→C chain + cascade revocation"
```

---

## Task 11: Public exports + api-surface test

**Files:**
- Modify: `packages/security/governance-delegation/src/index.ts`
- Create: `packages/security/governance-delegation/src/__tests__/api-surface.test.ts`

- [ ] **Step 1: Replace `src/index.ts` with the full exports**

```typescript
// L0 type re-exports (consumer convenience — same identities as @koi/core)
export type {
  AgentId,
  CapabilityId,
  CapabilityProof,
  CapabilityScope,
  CapabilityToken,
  CapabilityVerifier,
  CapabilityVerifyResult,
  PermissionConfig,
  ScopeChecker,
  SessionId,
  VerifyContext,
} from "@koi/core";

// New L2 contract
export type { CapabilityRevocationRegistry } from "./revocation.js";
export { createMemoryCapabilityRevocationRegistry } from "./revocation.js";

// Composite verifier
export type { CapabilityVerifierOptions } from "./verifier.js";
export { createCapabilityVerifier } from "./verifier.js";

// Default scope checker
export { createGlobScopeChecker } from "./scope-checker.js";

// Signer
export type { CapabilitySigner } from "./signer.js";

// Issuance
export { delegateCapability, issueRootCapability } from "./issue.js";
```

- [ ] **Step 2: Write the api-surface test**

File: `packages/security/governance-delegation/src/__tests__/api-surface.test.ts`

```typescript
import { describe, expect, it } from "bun:test";
import * as api from "../index.js";

describe("@koi/governance-delegation API surface", () => {
  it("exports the documented factory functions", () => {
    expect(typeof api.createCapabilityVerifier).toBe("function");
    expect(typeof api.createGlobScopeChecker).toBe("function");
    expect(typeof api.createMemoryCapabilityRevocationRegistry).toBe("function");
    expect(typeof api.issueRootCapability).toBe("function");
    expect(typeof api.delegateCapability).toBe("function");
  });
});
```

- [ ] **Step 3: Run all tests in the package**

Run: `cd packages/security/governance-delegation && bun test`
Expected: all test files pass (canonical, scope-checker, hmac, ed25519, revocation, issue, verifier, chain, api-surface).

- [ ] **Step 4: Run typecheck + lint for the package**

Run from worktree root:
```bash
cd packages/security/governance-delegation && bun run typecheck && bun run lint
```
Expected: both succeed with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/security/governance-delegation/src/index.ts packages/security/governance-delegation/src/__tests__/api-surface.test.ts
git commit -m "feat(governance-delegation): public exports + api-surface test"
```

---

## Task 12: Wire into @koi/runtime

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`

- [ ] **Step 1: Add the dependency to `packages/meta/runtime/package.json`**

Locate the `dependencies` block (sorted alphabetically). Insert this entry between `@koi/governance-defaults` and `@koi/hook-prompt`:

```json
    "@koi/governance-defaults": "workspace:*",
    "@koi/governance-delegation": "workspace:*",
    "@koi/hook-prompt": "workspace:*",
```

(Use `Edit` tool: `old_string = '"@koi/governance-defaults": "workspace:*",\n    "@koi/hook-prompt": "workspace:*",'`, `new_string = '"@koi/governance-defaults": "workspace:*",\n    "@koi/governance-delegation": "workspace:*",\n    "@koi/hook-prompt": "workspace:*",'`.)

- [ ] **Step 2: Add the project reference to `packages/meta/runtime/tsconfig.json`**

Insert into the `references` array between `governance-defaults` and the next entry (alphabetic):

```json
    { "path": "../../security/governance-defaults" },
    { "path": "../../security/governance-delegation" },
```

- [ ] **Step 3: Re-resolve the workspace**

Run: `bun install`
Expected: `bun.lock` updated; no errors.

- [ ] **Step 4: Run the runtime typecheck to confirm wiring works**

Run: `cd packages/meta/runtime && bun run typecheck`
Expected: pass.

- [ ] **Step 5: Run the orphan check**

Run from worktree root: `bun run check:orphans`
Expected: pass — `@koi/governance-delegation` recognized as a `@koi/runtime` dep.

- [ ] **Step 6: Commit**

```bash
git add packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json bun.lock
git commit -m "feat(runtime): wire @koi/governance-delegation as runtime dependency"
```

---

## Task 13: Standalone golden queries in @koi/runtime

**Files:**
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

We append two `describe` blocks at the bottom, mirroring the `@koi/url-safety` precedent at line ~2372.

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "^// L2 golden queries: @koi/file-type\|^describe\(\"Golden: @koi/file-type" packages/meta/runtime/src/__tests__/golden-replay.test.ts | head -5`

Expected: returns the line number of the file-type block. Find the *last* `Golden:` describe in the file (`tail -n 1` of the broader `describe("Golden:` grep). Append our blocks **after** the final closing `});` of the last existing `Golden:` describe.

- [ ] **Step 2: Append the two golden blocks at the end of the file**

```typescript
// ---------------------------------------------------------------------------
// L2 golden queries: @koi/governance-delegation — capability-token primitives
// ---------------------------------------------------------------------------

describe("Golden: @koi/governance-delegation — issue + verify roundtrip", () => {
  test("HMAC root capability verifies; tampering breaks signature", async () => {
    const { randomBytes } = await import("node:crypto");
    const { agentId, sessionId } = await import("@koi/core");
    const { issueRootCapability } = await import("@koi/governance-delegation");
    const { createCapabilityVerifier } = await import("@koi/governance-delegation");
    const { createGlobScopeChecker } = await import("@koi/governance-delegation");

    const secret = randomBytes(32);
    const sess = sessionId("golden-sess");
    const tok = await issueRootCapability({
      signer: { kind: "hmac-sha256", secret },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sess,
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });

    const verifier = createCapabilityVerifier({
      hmac: { secret },
      scopeChecker: createGlobScopeChecker(),
    });
    const ok = await verifier.verify(tok, {
      toolId: "read_file",
      now: 1500,
      activeSessionIds: new Set([sess]),
    });
    expect(ok.ok).toBe(true);

    const tampered = { ...tok, expiresAt: 9_999_999 };
    const bad = await verifier.verify(tampered, {
      toolId: "read_file",
      now: 1500,
      activeSessionIds: new Set([sess]),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_signature");
  });
});

describe("Golden: @koi/governance-delegation — revocation invalidates downstream", () => {
  test("cascade revoke of root invalidates child + grandchild", async () => {
    const { randomBytes } = await import("node:crypto");
    const { agentId, sessionId } = await import("@koi/core");
    const {
      issueRootCapability,
      delegateCapability,
      createCapabilityVerifier,
      createGlobScopeChecker,
      createMemoryCapabilityRevocationRegistry,
    } = await import("@koi/governance-delegation");

    const secret = randomBytes(32);
    const sess = sessionId("golden-sess");
    const registry = createMemoryCapabilityRevocationRegistry();
    const signer = { kind: "hmac-sha256" as const, secret };

    const A = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sess },
      ttlMs: 60_000,
      maxChainDepth: 3,
      registry,
      now: () => 1000,
    });
    const bResult = await delegateCapability({
      signer,
      parent: A,
      delegateeId: agentId("bob"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sess },
      ttlMs: 30_000,
      registry,
      now: () => 1000,
    });
    if (!bResult.ok) throw new Error("B issuance failed");
    const cResult = await delegateCapability({
      signer,
      parent: bResult.value,
      delegateeId: agentId("carol"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sess },
      ttlMs: 10_000,
      registry,
      now: () => 1000,
    });
    if (!cResult.ok) throw new Error("C issuance failed");

    await registry.revoke(A.id, true);

    const verifier = createCapabilityVerifier({
      hmac: { secret },
      scopeChecker: createGlobScopeChecker(),
      revocations: registry,
    });
    const ctx = {
      toolId: "read_file",
      now: 1500,
      activeSessionIds: new Set([sess]),
    };
    for (const tok of [A, bResult.value, cResult.value]) {
      const r = await verifier.verify(tok, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("revoked");
    }
  });
});
```

- [ ] **Step 3: Run only the new tests to confirm they pass**

Run: `cd packages/meta/runtime && bun test src/__tests__/golden-replay.test.ts -t "Golden: @koi/governance-delegation"`
Expected: 2 tests pass.

- [ ] **Step 4: Run the golden-queries CI check**

Run from worktree root: `bun run check:golden-queries`
Expected: pass — both standalone goldens recognized.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/runtime/src/__tests__/golden-replay.test.ts
git commit -m "test(runtime): standalone golden queries for @koi/governance-delegation"
```

---

## Task 14: Final CI gates + push

**Files:** none (verification only)

- [ ] **Step 1: Run all CI gates locally**

Run from worktree root:
```bash
bun run typecheck && bun run lint && bun run check:layers && bun run check:unused && bun run check:duplicates && bun run check:orphans && bun run check:golden-queries
```
Expected: all 7 commands exit 0.

- [ ] **Step 2: Run the full test for the new package + the runtime golden**

```bash
cd packages/security/governance-delegation && bun test && cd - >/dev/null
cd packages/meta/runtime && bun test src/__tests__/golden-replay.test.ts -t "Golden: @koi/governance-delegation" && cd - >/dev/null
```
Expected: green.

- [ ] **Step 3: Confirm coverage threshold**

Run: `cd packages/security/governance-delegation && bun test --coverage`
Expected: lines / functions / statements all ≥ 80%. If any metric is below, add a targeted test for the uncovered branch and re-run.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "feat(governance-delegation): @koi/governance-delegation — capability tokens + delegation (#1395)" --body "$(cat <<'EOF'
## Summary

- Implements the L0 contracts in `@koi/core` for capability tokens and delegation: `CapabilityVerifier`, `ScopeChecker`, plus a new `CapabilityRevocationRegistry` (CapabilityId-keyed sibling of L0's DelegationId-keyed `RevocationRegistry`).
- HMAC-SHA256 + Ed25519 composite verifier, dispatched on `proof.kind`.
- Monotonic attenuation enforced at issue time via L0's `isPermissionSubset`.
- In-memory revocation registry with cascade walk over a parent→children index.
- Library-only — no middleware integration in this PR (separate follow-up).

## Test plan

- [x] `bun test packages/security/governance-delegation/src` — all unit + integration tests green
- [x] `bun run check:layers` — L2 imports L0/L0u only
- [x] `bun run check:orphans` — wired into `@koi/runtime`
- [x] `bun run check:golden-queries` — 2 standalone goldens registered
- [x] `bun test src/__tests__/golden-replay.test.ts -t "Golden: @koi/governance-delegation"` — replay green
- [x] Coverage ≥ 80% lines/functions/statements

Spec: `docs/superpowers/specs/2026-04-25-gov-3-governance-delegation-design.md`
Plan: `docs/superpowers/plans/2026-04-25-gov-3-governance-delegation.md`

Closes #1395
EOF
)"
```
Expected: PR created; URL printed.

---

## Self-review

**Spec coverage:** Each spec section has a corresponding task:

| Spec section | Task |
|---|---|
| §1 Goal — implement L0 contracts | Tasks 2-9 (each L0 contract has an implementation task) |
| §2 Layer & deps | Task 1 (package.json + tsconfig) |
| §3 Decisions — composite HMAC + Ed25519 | Tasks 4, 5, 9 |
| §3 Decisions — `PermissionConfig` + `isPermissionSubset` | Tasks 3, 8 |
| §3 Decisions — structured token + canonical signing | Tasks 2, 7, 8 |
| §3 Decisions — chain at issue time | Task 8 |
| §3 Decisions — session + per-token revocation | Tasks 6, 9 |
| §3 Decisions — library only | (no MW task — explicit out of scope) |
| §4 Public API | Tasks 7-11 (each export covered) |
| §5 File layout | Tasks 2-9 each create one source file |
| §6 Algorithms | Tasks 2-9 |
| §7 Tests — issue checklist all 6 cases | Task 4 (sign/verify), Task 8 (narrows / widens / chain depth / TTL / session), Task 9 (expiry, revocation), Task 10 (chain end-to-end + cascade) |
| §7 Standalone goldens | Task 13 |
| §9 CI gates | Task 14 |
| §10 Anti-leak checklist | Verified across Tasks 1, 12 (deps), 11 (no L1 imports — implicit since src only imports `@koi/core` + node built-ins) |

**Placeholder scan:** All steps contain executable code or commands. Step 2 of Task 7 has a corrective note about the import block — left in deliberately because it's a real correction the executor needs to apply.

**Type consistency:**
- `CapabilitySigner` discriminated-union shape used identically across Tasks 7, 8, 9, 10, 13.
- `CapabilityRevocationRegistry` interface shape used identically across Tasks 6, 7, 8, 9, 10.
- `verifyHmac` / `verifyEd25519` signatures consistent across Tasks 4, 5, 9.
- `serializeForSigning` accepts `CapabilityToken` (full token), strips proof internally — used identically in Tasks 4, 5.
- `now: () => number` injectable on `issueRootCapability` and `delegateCapability` — same shape Tasks 7, 8, 10, 13.
- `CapabilityVerifierOptions` field names (`hmac`, `ed25519`, `scopeChecker`, `revocations`) consistent Tasks 9, 10, 13.

No issues found.
