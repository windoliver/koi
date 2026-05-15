# Issue 1414 Remote Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the isolated `@koi/remote` primitives for JWT auth, trusted devices, permission bridging, hybrid transport policy, and encryption enforcement.

**Architecture:** Add a new L2 network package at `packages/net/remote`. Keep it independent from session spawning and bridge lifecycle so issue 1412 can consume it later without cross-package leakage. Expected failures return typed deny results; only unexpected crypto/runtime faults throw through tests.

**Tech Stack:** Bun 1.3, `bun:test`, TypeScript 6 strict ESM, Web Crypto via Bun globals, `@koi/core` types only.

---

## File Structure

- Create `packages/net/remote/package.json`: workspace metadata, scripts, dependency on `@koi/core`.
- Create `packages/net/remote/tsconfig.json`: extend root config, `rootDir: src`, `outDir: dist`.
- Create `packages/net/remote/tsup.config.ts`: ESM build matching existing net packages.
- Create `packages/net/remote/src/types.ts`: shared readonly result/config types.
- Create `packages/net/remote/src/jwt.ts`: HS256 compact JWT verification.
- Create `packages/net/remote/src/jwt.test.ts`: JWT verifier coverage.
- Create `packages/net/remote/src/trusted-device.ts`: in-memory device registry.
- Create `packages/net/remote/src/trusted-device.test.ts`: register/revoke coverage.
- Create `packages/net/remote/src/permission-bridge.ts`: remote permission mapping.
- Create `packages/net/remote/src/permission-bridge.test.ts`: mapping and reject coverage.
- Create `packages/net/remote/src/transport-policy.ts`: transport operation and encryption checks.
- Create `packages/net/remote/src/transport-policy.test.ts`: hybrid transport and encryption coverage.
- Create `packages/net/remote/src/authenticator.ts`: compose verifier, registry, permission bridge, and transport checks.
- Create `packages/net/remote/src/authenticator.test.ts`: end-to-end remote auth decisions.
- Create `packages/net/remote/src/index.ts`: public exports.
- Modify `scripts/add-descriptions.ts`: add `@koi/remote` description if the description check requires it.

### Task 1: Package Skeleton

**Files:**
- Create: `packages/net/remote/package.json`
- Create: `packages/net/remote/tsconfig.json`
- Create: `packages/net/remote/tsup.config.ts`
- Create: `packages/net/remote/src/index.ts`
- Modify if needed: `scripts/add-descriptions.ts`

- [ ] **Step 1: Create package files**

`packages/net/remote/package.json`:

```json
{
  "name": "@koi/remote",
  "description": "Authenticate remote Koi clients with JWTs, trusted devices, permission bridging, and transport policy",
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
    "build": "bun ../../../scripts/run-tsup.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  }
}
```

`packages/net/remote/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

`packages/net/remote/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  treeshake: true,
  target: "node22",
});
```

`packages/net/remote/src/index.ts`:

```ts
export {};
```

- [ ] **Step 2: Verify package is discovered**

Run: `bun --filter @koi/remote test`

Expected: package command runs with no tests yet and exits successfully.

- [ ] **Step 3: Commit skeleton**

```bash
git add packages/net/remote scripts/add-descriptions.ts
git commit -m "feat: add remote auth package skeleton"
```

### Task 2: JWT Verification

**Files:**
- Create: `packages/net/remote/src/types.ts`
- Create: `packages/net/remote/src/jwt.ts`
- Create: `packages/net/remote/src/jwt.test.ts`
- Modify: `packages/net/remote/src/index.ts`

- [ ] **Step 1: Write failing JWT tests**

Create tests for these exact behaviors in `jwt.test.ts`: valid HS256 token verifies, expired token rejects with `expired`, malformed compact JWT rejects with `malformed`, wrong issuer/audience rejects, and `alg: none` rejects with `unsupported_alg`.

Use a local helper:

```ts
async function sign(payload: Record<string, unknown>, secret = "secret"): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun --filter @koi/remote test src/jwt.test.ts`

Expected: FAIL because `verifyRemoteJwt` is not exported.

- [ ] **Step 3: Implement JWT verifier**

Implement:

```ts
export type RemoteJwtRejectReason =
  | "malformed"
  | "unsupported_alg"
  | "invalid_signature"
  | "expired"
  | "not_before"
  | "invalid_issuer"
  | "invalid_audience"
  | "missing_subject"
  | "missing_device";

export interface RemoteJwtClaims {
  readonly subject: string;
  readonly deviceId: string;
  readonly agentId?: string | undefined;
  readonly permissions: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RemoteJwtVerifierOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowMs?: () => number;
  readonly clockSkewSeconds?: number;
}

export async function verifyRemoteJwt(
  token: string,
  options: RemoteJwtVerifierOptions,
): Promise<
  | { readonly ok: true; readonly claims: RemoteJwtClaims }
  | { readonly ok: false; readonly reason: RemoteJwtRejectReason }
> {
  // Split into exactly 3 parts, parse JSON header/payload, require alg HS256,
  // verify signature over "header.payload", then validate iss/aud/exp/nbf/sub/device_id.
  // Return permissions from payload.permissions only when it is string[]; otherwise [].
}
```

Implementation details:
- Use `crypto.subtle.importKey` and `crypto.subtle.verify`.
- Decode base64url by replacing `-` with `+`, `_` with `/`, and adding padding.
- Reject parse failures as `malformed`.
- Treat `sub` as subject and `device_id` as device id.
- Treat `permissions` as empty unless it is a readonly string array.
- Treat `metadata` as empty unless it is a non-null object.

- [ ] **Step 4: Verify GREEN**

Run: `bun --filter @koi/remote test src/jwt.test.ts`

Expected: all JWT tests pass.

### Task 3: Trusted Device Registry

**Files:**
- Create: `packages/net/remote/src/trusted-device.ts`
- Create: `packages/net/remote/src/trusted-device.test.ts`
- Modify: `packages/net/remote/src/index.ts`

- [ ] **Step 1: Write failing registry tests**

Test that a newly registered `(subject, deviceId)` is trusted, a revoked device is not trusted, revocation wins if called repeatedly, and another subject cannot reuse the same device id.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun --filter @koi/remote test src/trusted-device.test.ts`

Expected: FAIL because `createInMemoryTrustedDeviceRegistry` is not exported.

- [ ] **Step 3: Implement registry**

Implement:

```ts
export interface TrustedDeviceRecord {
  readonly subject: string;
  readonly deviceId: string;
  readonly registeredAt: number;
  readonly revokedAt?: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TrustedDeviceRegistry {
  readonly register: (record: TrustedDeviceRecord) => void;
  readonly revoke: (subject: string, deviceId: string, revokedAt: number) => void;
  readonly lookup: (subject: string, deviceId: string) => TrustedDeviceRecord | undefined;
  readonly isTrusted: (subject: string, deviceId: string) => boolean;
}
```

Use a `Map<string, TrustedDeviceRecord>` keyed by `${subject}\0${deviceId}`. `register` must preserve a later `revokedAt` if the existing device was already revoked.

- [ ] **Step 4: Verify GREEN**

Run: `bun --filter @koi/remote test src/trusted-device.test.ts`

Expected: all registry tests pass.

### Task 4: Permission Bridge

**Files:**
- Create: `packages/net/remote/src/permission-bridge.ts`
- Create: `packages/net/remote/src/permission-bridge.test.ts`
- Modify: `packages/net/remote/src/index.ts`

- [ ] **Step 1: Write failing permission tests**

Test that configured remote permissions map to `PermissionQuery` objects and unknown remote permissions reject with `unknown_permission`.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun --filter @koi/remote test src/permission-bridge.test.ts`

Expected: FAIL because `mapRemotePermissions` is not exported.

- [ ] **Step 3: Implement bridge**

Implement:

```ts
import type { PermissionQuery } from "@koi/core";

export interface RemotePermissionMapping {
  readonly remote: string;
  readonly action: string;
  readonly resource?: string | undefined;
}

export function mapRemotePermissions(
  claims: readonly string[],
  mappings: readonly RemotePermissionMapping[],
): { readonly ok: true; readonly queries: readonly PermissionQuery[] } | {
  readonly ok: false;
  readonly reason: "unknown_permission";
  readonly permission: string;
} {
  // Create one PermissionQuery per claim by exact remote string match.
  // Reject the first claim that has no mapping.
}
```

Create each `PermissionQuery` with `principal: "remote"`, `action: mapping.action`,
`resource: mapping.resource ?? "*"`, and `context: { remotePermission: claim }`.

- [ ] **Step 4: Verify GREEN**

Run: `bun --filter @koi/remote test src/permission-bridge.test.ts`

Expected: all permission bridge tests pass.

### Task 5: Transport Policy

**Files:**
- Create: `packages/net/remote/src/transport-policy.ts`
- Create: `packages/net/remote/src/transport-policy.test.ts`
- Modify: `packages/net/remote/src/index.ts`

- [ ] **Step 1: Write failing transport tests**

Test:
- WebSocket allows `read` and `stream`, rejects `write`.
- HTTP POST allows `write`, rejects `read` and `stream`.
- `http://example.com` rejects as insecure.
- `http://127.0.0.1:1234` is allowed only when `allowInsecureLocalhost` is true.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun --filter @koi/remote test src/transport-policy.test.ts`

Expected: FAIL because transport policy exports do not exist.

- [ ] **Step 3: Implement policy**

Implement:

```ts
export type RemoteTransportKind = "websocket" | "http-post";
export type RemoteOperationKind = "read" | "stream" | "write";

export interface RemoteTransportPolicyInput {
  readonly transport: RemoteTransportKind;
  readonly operation: RemoteOperationKind;
  readonly url: string;
  readonly allowInsecureLocalhost?: boolean | undefined;
}

export function enforceRemoteTransportPolicy(
  input: RemoteTransportPolicyInput,
): { readonly ok: true } | { readonly ok: false; readonly reason: "wrong_transport" | "insecure_transport" } {
  // Enforce hybrid route rules first, then URL scheme/loopback security.
}
```

Loopback hosts are exactly `localhost`, `127.0.0.1`, and `::1`.

- [ ] **Step 4: Verify GREEN**

Run: `bun --filter @koi/remote test src/transport-policy.test.ts`

Expected: all transport tests pass.

### Task 6: Composed Authenticator

**Files:**
- Create: `packages/net/remote/src/authenticator.ts`
- Create: `packages/net/remote/src/authenticator.test.ts`
- Modify: `packages/net/remote/src/index.ts`

- [ ] **Step 1: Write failing authenticator tests**

Test that a valid token, trusted device, known permission, and correct transport authenticates. Also test expired JWT, revoked device, unknown permission, wrong transport, and insecure transport all deny.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun --filter @koi/remote test src/authenticator.test.ts`

Expected: FAIL because `authenticateRemoteRequest` is not exported.

- [ ] **Step 3: Implement authenticator**

Implement:

```ts
export interface RemoteAuthRequest {
  readonly bearerToken: string;
  readonly transport: RemoteTransportKind;
  readonly operation: RemoteOperationKind;
  readonly url: string;
}

export async function authenticateRemoteRequest(
  request: RemoteAuthRequest,
  options: RemoteAuthenticatorOptions,
): Promise<
  | { readonly ok: true; readonly subject: string; readonly deviceId: string; readonly permissions: readonly PermissionQuery[] }
  | { readonly ok: false; readonly reason: RemoteAuthRejectReason }
> {
  // Strip optional "Bearer " prefix, verify JWT, check trusted device,
  // map permissions, enforce transport policy, then return auth context.
}
```

Map lower-level reasons into stable `RemoteAuthRejectReason` values:
`jwt_rejected`, `untrusted_device`, `permission_rejected`, and `transport_rejected`.

- [ ] **Step 4: Verify GREEN**

Run: `bun --filter @koi/remote test src/authenticator.test.ts`

Expected: all authenticator tests pass.

### Task 7: Package Verification

**Files:**
- Modify only files needed for formatting or description checks.

- [ ] **Step 1: Run package tests**

Run: `bun --filter @koi/remote test`

Expected: all tests pass.

- [ ] **Step 2: Run package typecheck**

Run: `bun --filter @koi/remote typecheck`

Expected: no TypeScript errors.

- [ ] **Step 3: Run package build**

Run: `bun --filter @koi/remote build`

Expected: ESM and DTS build succeeds.

- [ ] **Step 4: Run repo checks relevant to package registration**

Run: `bun run check:descriptions`

Expected: no missing package description for `@koi/remote`.

- [ ] **Step 5: Final commit**

```bash
git add packages/net/remote scripts/add-descriptions.ts docs/superpowers/specs/2026-05-15-issue-1414-remote-auth-design.md docs/superpowers/plans/2026-05-15-issue-1414-remote-auth.md
git commit -m "feat: add remote auth primitives"
```

## Self-Review

Spec coverage:
- JWT validation: Task 2.
- Trusted device register/revoke: Task 3.
- Permission bridging: Task 4.
- Hybrid transport: Task 5.
- Encryption enforcement: Task 5.
- Composed fail-closed remote authentication: Task 6.

Placeholder scan:
- This plan intentionally contains no placeholder markers or incomplete steps.

Type consistency:
- Lower-level modules return typed result unions.
- `authenticator.ts` composes the exact exported names from Tasks 2-5.
- `index.ts` exports all public types and factories.
