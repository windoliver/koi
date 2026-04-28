# Permissions-Nexus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Nexus-backed permission persistence, audit trail, and cross-node synchronization via three new packages (`@koi/nexus-client`, `@koi/permissions-nexus`, `@koi/audit-sink-nexus`) plus one modification to `@koi/fs-nexus`.

**Architecture:** Local-first — `check()` always delegates to an in-process `PermissionBackend`; Nexus is used only for policy write-through on construction and periodic polling to sync policy changes across nodes. If Nexus is unreachable the agent runs on its last-known local rules.

**Tech Stack:** Bun 1.3.x, TypeScript 6, `bun:test`, tsup ESM-only builds. No external test dependencies — all Nexus calls mocked via injected `NexusTransport`.

---

## File Map

```
packages/lib/nexus-client/
  src/
    types.ts                    NexusTransport interface + NexusTransportConfig
    errors.ts                   Generic mapNexusError (HTTP/network/RPC)
    transport.ts                createHttpTransport (HTTP JSON-RPC 2.0)
    index.ts                    Public exports
    transport.test.ts           Unit tests

packages/security/permissions-nexus/
  src/
    types.ts                    RelationshipTuple, NexusVersionTag
    config.ts                   NexusPermissionsConfig + validate fn
    nexus-permission-backend.ts createNexusPermissionBackend (write-through + poll)
    nexus-revocation-registry.ts createNexusRevocationRegistry (fail-closed)
    nexus-delegation-hooks.ts   createNexusDelegationHooks (onGrant/onRevoke)
    index.ts                    Public exports
    config.test.ts
    nexus-permission-backend.test.ts
    nexus-revocation-registry.test.ts
    nexus-delegation-hooks.test.ts

packages/security/audit-sink-nexus/
  src/
    config.ts                   NexusAuditSinkConfig + validate fn
    nexus-sink.ts               createNexusAuditSink (batched writes, queryable)
    index.ts                    Public exports
    config.test.ts
    nexus-sink.test.ts

Modified:
  packages/lib/fs-nexus/src/transport.ts     Import createHttpTransport from @koi/nexus-client
  packages/lib/fs-nexus/package.json         Add @koi/nexus-client dep
  packages/lib/fs-nexus/tsconfig.json        Add nexus-client reference
  scripts/layers.ts                           Register 3 new packages
  packages/meta/runtime/package.json         Add new packages as deps
  packages/meta/runtime/tsconfig.json        Add references
  packages/meta/runtime/src/__tests__/golden-replay.test.ts  4 new golden queries

Docs (written FIRST per CLAUDE.md):
  docs/L2/nexus-client.md
  docs/L2/permissions-nexus.md
  docs/L2/audit-sink-nexus.md
```

---

## Task 1: Write L2 docs (Doc gate — required before any code)

**Files:**
- Create: `docs/L2/nexus-client.md`
- Create: `docs/L2/permissions-nexus.md`
- Create: `docs/L2/audit-sink-nexus.md`

- [ ] **Step 1: Write `docs/L2/nexus-client.md`**

```markdown
# @koi/nexus-client

**Layer:** L0u  
**Package:** `packages/lib/nexus-client`

Shared JSON-RPC 2.0 HTTP transport for all Nexus server communication.
Extracted from `@koi/fs-nexus` when `@koi/permissions-nexus` became the second consumer.

## Purpose

Provides `createHttpTransport` — a typed, retrying, deadline-aware HTTP client
for Nexus JSON-RPC endpoints. All Nexus calls use the pattern:

```
POST {url}/api/nfs/{method}
Content-Type: application/json
Authorization: Bearer {apiKey}   (optional)

{ "jsonrpc": "2.0", "id": N, "method": "...", "params": {...} }
```

## API

```typescript
import { createHttpTransport } from "@koi/nexus-client";

const transport = createHttpTransport({
  url: "http://localhost:3100",
  apiKey: "secret",
  deadlineMs: 45_000,   // total budget including retries; default 45s
  retries: 2,           // retry count for safe methods; default 2
});

const result = await transport.call<string>("read", { path: "koi/policy.json" });
if (result.ok) {
  console.log(result.value);
}

transport.close(); // abort in-flight requests
```

## NexusTransport interface

```typescript
interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  readonly close: () => void;
}
```

## Retry policy

Read-only methods (`read`, `list`, `grep`, `search`, `stat`, `exists`, `glob`,
`is_directory`, `permissions.check`, `permissions.checkBatch`, `revocations.check`,
`revocations.checkBatch`, `version`) are retried up to `retries` times with
exponential backoff + 20% jitter. Write methods are not retried (non-idempotent).

## Error semantics

Returns `Result<T, KoiError>` — never throws. Network timeouts map to
`code: "TIMEOUT"`, HTTP 5xx to `code: "INTERNAL"`, HTTP 4xx to `code: "EXTERNAL"`,
JSON-RPC errors to their mapped code. All errors carry `retryable` flag.
```

- [ ] **Step 2: Write `docs/L2/permissions-nexus.md`**

```markdown
# @koi/permissions-nexus

**Layer:** L2  
**Package:** `packages/security/permissions-nexus`  
**Issue:** #1399

Nexus-backed permission persistence, cross-node synchronization, and delegation
hooks for the Koi permission system.

## Design: local-first

`check()` ALWAYS delegates to an in-process `PermissionBackend`. Nexus is
never on the hot path. On construction, the current policy is written to
Nexus (write-through). A background poller syncs policy changes from Nexus
at a configurable interval (default 30s). If Nexus is down, the agent runs
on its last-known local rules — no decisions are ever blocked.

## API

```typescript
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createPermissionBackend } from "@koi/permissions";
import { createHttpTransport } from "@koi/nexus-client";

const rules = loadMyRules(); // SourcedRule[]
const transport = createHttpTransport({ url: "http://nexus:3100" });

const backend = createNexusPermissionBackend({
  transport,
  localBackend: createPermissionBackend({ mode: "default", rules }),
  getCurrentPolicy: () => rules,
  rebuildBackend: (policy) =>
    createPermissionBackend({ mode: "default", rules: policy as SourcedRule[] }),
  syncIntervalMs: 30_000,   // 0 = disable polling
  policyPath: "koi/permissions",
});

// Hot path — always local, always fast
const decision = await backend.check({ principal, action, resource });

// Cleanup
backend.dispose();
```

## Config

```typescript
interface NexusPermissionsConfig {
  readonly transport: NexusTransport;
  readonly localBackend: PermissionBackend;       // evaluated on every check()
  readonly getCurrentPolicy: () => unknown;        // serialize current rules to JSON
  readonly rebuildBackend: (p: unknown) => PermissionBackend; // reconstruct from Nexus policy
  readonly syncIntervalMs?: number;               // default: 30_000; 0 = disabled
  readonly policyPath?: string;                   // default: "koi/permissions"
}
```

## Nexus storage layout

```
{policyPath}/policy.json        — serialized policy (getCurrentPolicy() output)
{policyPath}/version.json       — { version: number, updatedAt: number }
{policyPath}/tuples/{id}.json   — RelationshipTuple[] for delegation grants
{policyPath}/revocations/{id}.json — { revoked: true, cascade: boolean }
```

## RevocationRegistry

```typescript
const registry = createNexusRevocationRegistry({ transport });
await registry.isRevoked(id);       // fail-closed: error → true
await registry.isRevokedBatch(ids); // parallel reads, fail-closed
await registry.revoke(id, cascade); // writes revocation record
```

## Delegation hooks

```typescript
const hooks = createNexusDelegationHooks({ transport });
// onGrant — fail-closed: throws on Nexus write failure (grant rolled back)
// onRevoke — best-effort: silently swallows failures
```

## Fallback behavior

| Scenario | Result |
|----------|--------|
| Nexus unreachable at startup | Warn, run local-only |
| Nexus write-through failure | Log, non-fatal |
| Poll read failure | Log, keep local rules |
| `isRevoked` error | Return `true` (fail-closed) |
| `onGrant` failure | Throw (grant rolled back) |
| `onRevoke` failure | Swallow |
```

- [ ] **Step 3: Write `docs/L2/audit-sink-nexus.md`**

```markdown
# @koi/audit-sink-nexus

**Layer:** L2  
**Package:** `packages/security/audit-sink-nexus`  
**Issue:** #1399

Nexus-backed `AuditSink` — batched writes with interval + size triggers,
and a `query()` method that reads entries back from Nexus NFS.

## API

```typescript
import { createNexusAuditSink } from "@koi/audit-sink-nexus";
import { createHttpTransport } from "@koi/nexus-client";

const sink = createNexusAuditSink({
  transport: createHttpTransport({ url: "http://nexus:3100" }),
  basePath: "koi/audit",      // default
  batchSize: 20,              // default — flush when buffer reaches this size
  flushIntervalMs: 5_000,     // default — flush every 5s
});

await sink.log(entry);        // buffered, fire-and-forget
await sink.flush();           // explicit flush, propagates write errors
const entries = await sink.query("session-id"); // flush then read from Nexus
```

## Storage layout

Each entry is written to:
```
{basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}-{seq}.json
```

`query()` lists the session directory, reads all files, and sorts by
`(timestamp, turnIndex)`. Malformed files are silently skipped.

## Error semantics

- `log()` — fire-and-forget; write errors re-enqueue failed entries for retry on next flush
- `flush()` — propagates write errors to caller; caller (middleware) applies its own error policy
- `query()` — flushes first, then reads; list/read errors return empty for that file
```

- [ ] **Step 4: Commit docs**

```bash
git add docs/L2/nexus-client.md docs/L2/permissions-nexus.md docs/L2/audit-sink-nexus.md
git commit -m "docs: L2 docs for nexus-client, permissions-nexus, audit-sink-nexus (#1399)"
```

---

## Task 2: Scaffold `@koi/nexus-client`

**Files:**
- Create: `packages/lib/nexus-client/package.json`
- Create: `packages/lib/nexus-client/tsconfig.json`
- Create: `packages/lib/nexus-client/tsup.config.ts`
- Create: `packages/lib/nexus-client/src/types.ts`
- Create: `packages/lib/nexus-client/src/errors.ts`
- Create: `packages/lib/nexus-client/src/transport.ts`
- Create: `packages/lib/nexus-client/src/index.ts`

- [ ] **Step 1: Create `packages/lib/nexus-client/package.json`**

```json
{
  "name": "@koi/nexus-client",
  "description": "Shared JSON-RPC 2.0 HTTP transport for Nexus server communication",
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
    "test": "bun test"
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/lib/nexus-client/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../kernel/core" }]
}
```

- [ ] **Step 3: Create `packages/lib/nexus-client/tsup.config.ts`**

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

- [ ] **Step 4: Create `packages/lib/nexus-client/src/types.ts`**

```typescript
import type { KoiError, Result } from "@koi/core";

export interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  readonly close: () => void;
}

export interface NexusTransportConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly deadlineMs?: number | undefined;
  readonly retries?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface JsonRpcResponse<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}
```

- [ ] **Step 5: Create `packages/lib/nexus-client/src/errors.ts`**

```typescript
import type { KoiError } from "@koi/core";

export function mapNexusError(error: unknown, operation: string): KoiError {
  if (isAbortError(error)) {
    const msg = error instanceof Error ? error.message : String(error);
    return { code: "TIMEOUT", message: `Network timeout during ${operation}: ${msg}`, retryable: true, cause: error };
  }
  if (isRpcError(error)) {
    return {
      code: "EXTERNAL",
      message: error.message,
      retryable: false,
      cause: error,
      context: { operation, rpcCode: error.code },
    };
  }
  if (isHttpError(error)) {
    if (error.status === 429) {
      return { code: "RATE_LIMIT", message: `Rate limited during ${operation}`, retryable: true, cause: error };
    }
    if (error.status >= 500) {
      return { code: "INTERNAL", message: `Server error ${String(error.status)} during ${operation}`, retryable: true, cause: error };
    }
    return { code: "EXTERNAL", message: `HTTP ${String(error.status)} during ${operation}`, retryable: false, cause: error };
  }
  if (error instanceof TypeError) {
    return { code: "TIMEOUT", message: `Network error during ${operation}: ${error.message}`, retryable: true, cause: error };
  }
  if (error instanceof Error) {
    return { code: "EXTERNAL", message: `${operation}: ${error.message}`, retryable: true, cause: error };
  }
  return { code: "EXTERNAL", message: `${operation}: ${String(error)}`, retryable: false, cause: error };
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function isRpcError(e: unknown): e is { readonly code: number; readonly message: string } {
  return (
    typeof e === "object" && e !== null &&
    "code" in e && typeof (e as Record<string, unknown>).code === "number" &&
    "message" in e && typeof (e as Record<string, unknown>).message === "string"
  );
}

function isHttpError(e: unknown): e is { readonly status: number; readonly statusText: string } {
  return (
    typeof e === "object" && e !== null &&
    "status" in e && typeof (e as Record<string, unknown>).status === "number"
  );
}
```

- [ ] **Step 6: Create `packages/lib/nexus-client/src/transport.ts`**

```typescript
import type { KoiError, Result } from "@koi/core";
import { mapNexusError } from "./errors.js";
import type { JsonRpcResponse, NexusTransport, NexusTransportConfig } from "./types.js";

const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

/** Read-only / idempotent methods safe to retry on transient failure. */
const RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  "read", "list", "grep", "search", "stat", "exists", "glob", "is_directory",
  "permissions.check", "permissions.checkBatch",
  "revocations.check", "revocations.checkBatch",
  "version",
]);

export function createHttpTransport(config: NexusTransportConfig): NexusTransport {
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  const fetchFn = config.fetch ?? globalThis.fetch;
  const abortController = new AbortController();
  // let justified: monotonic counter for JSON-RPC request IDs
  let nextId = 1;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    const deadline = Date.now() + deadlineMs;
    const effectiveRetries = RETRYABLE_METHODS.has(method) ? maxRetries : 0;
    let lastError: KoiError | undefined;

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, error: lastError ?? mapNexusError(new Error("deadline exceeded"), method) };
      }

      if (attempt > 0) {
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * backoff * 0.2;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(backoff + jitter, remaining)));
      }

      try {
        const id = nextId++;
        const timeoutSignal = AbortSignal.timeout(Math.min(remaining, deadlineMs));
        const signal = AbortSignal.any([abortController.signal, timeoutSignal]);

        const response = await fetchFn(
          `${config.url}/api/nfs/${encodeURIComponent(method)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
            signal,
          },
        );

        if (!response.ok) {
          const error = mapNexusError(
            { status: response.status, statusText: response.statusText },
            method,
          );
          if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
          lastError = error;
          continue;
        }

        const body = (await response.json()) as JsonRpcResponse<T>;
        if (body.error !== undefined) {
          const error = mapNexusError(body.error, method);
          if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
          lastError = error;
          continue;
        }

        return { ok: true, value: body.result as T };
      } catch (e: unknown) {
        const error = mapNexusError(e, method);
        if (!error.retryable || attempt >= maxRetries) return { ok: false, error };
        lastError = error;
      }
    }

    return { ok: false, error: lastError ?? mapNexusError(new Error("exhausted retries"), method) };
  }

  function close(): void {
    abortController.abort();
  }

  return { call, close };
}
```

- [ ] **Step 7: Create `packages/lib/nexus-client/src/index.ts`**

```typescript
export { mapNexusError } from "./errors.js";
export { createHttpTransport } from "./transport.js";
export type { JsonRpcResponse, NexusTransport, NexusTransportConfig } from "./types.js";
```

- [ ] **Step 8: Install the package into the workspace**

```bash
bun install
```

Expected: bun.lock updated with `@koi/nexus-client` workspace reference.

---

## Task 3: Test and verify `@koi/nexus-client`

**Files:**
- Create: `packages/lib/nexus-client/src/transport.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/lib/nexus-client/src/transport.test.ts
import { describe, expect, test } from "bun:test";
import { createHttpTransport } from "./transport.js";

function makeFetchThatReturns(body: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("createHttpTransport", () => {
  test("returns result value on success", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetchThatReturns({ jsonrpc: "2.0", id: 1, result: "hello" }),
    });
    const result = await transport.call<string>("read", { path: "foo" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
    transport.close();
  });

  test("returns error on JSON-RPC error response", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetchThatReturns({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "not found" },
      }),
    });
    const result = await transport.call<string>("read", { path: "missing" });
    expect(result.ok).toBe(false);
    transport.close();
  });

  test("returns EXTERNAL error on HTTP 4xx", async () => {
    const transport = createHttpTransport({
      url: "http://nexus.test",
      fetch: makeFetchThatReturns({ error: "forbidden" }, 403),
    });
    const result = await transport.call<string>("read", { path: "secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXTERNAL");
    transport.close();
  });

  test("sends Authorization header when apiKey provided", async () => {
    let capturedAuth: string | null = null;
    const fetchSpy: typeof fetch = async (input, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"] ?? null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const transport = createHttpTransport({ url: "http://nexus.test", apiKey: "sk-test", fetch: fetchSpy });
    await transport.call("read", { path: "x" });
    expect(capturedAuth).toBe("Bearer sk-test");
    transport.close();
  });

  test("close() aborts in-flight requests", async () => {
    let resolveRequest!: () => void;
    const hangFetch: typeof fetch = () =>
      new Promise((_, reject) => {
        resolveRequest = () => reject(new DOMException("AbortError", "AbortError"));
      });
    const transport = createHttpTransport({ url: "http://nexus.test", fetch: hangFetch });
    const callPromise = transport.call("read", { path: "x" });
    transport.close();
    resolveRequest();
    const result = await callPromise;
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail (package not built yet)**

```bash
bun test packages/lib/nexus-client/src/transport.test.ts
```

Expected: Tests run (bun runs TS natively). They may pass immediately since implementation is already written in Task 2.

- [ ] **Step 3: Run full package tests**

```bash
bun run test --filter=@koi/nexus-client
```

Expected: All tests pass.

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck --filter=@koi/nexus-client
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/nexus-client/
git commit -m "feat(nexus-client): extract shared JSON-RPC transport from @koi/fs-nexus (#1399)"
```

---

## Task 4: Update `@koi/fs-nexus` to use `@koi/nexus-client`

**Files:**
- Modify: `packages/lib/fs-nexus/src/transport.ts`
- Modify: `packages/lib/fs-nexus/package.json`
- Modify: `packages/lib/fs-nexus/tsconfig.json`

- [ ] **Step 1: Add `@koi/nexus-client` to `packages/lib/fs-nexus/package.json`**

Add to `dependencies`:
```json
"@koi/nexus-client": "workspace:*"
```

- [ ] **Step 2: Add reference to `packages/lib/fs-nexus/tsconfig.json`**

Add to `references`:
```json
{ "path": "../nexus-client" }
```

- [ ] **Step 3: Replace the inline HTTP logic in `packages/lib/fs-nexus/src/transport.ts`**

The new file delegates to `@koi/nexus-client` and adds the fs-nexus-specific `subscribe`/`submitAuthCode` methods:

```typescript
/**
 * HTTP JSON-RPC transport for @koi/fs-nexus.
 * Delegates core HTTP logic to @koi/nexus-client and adds
 * the bridge-notification interface (no-ops for HTTP transport).
 */
import { createHttpTransport as createBaseTransport } from "@koi/nexus-client";
import type { NexusFileSystemConfig, NexusTransport } from "./types.js";

export function createHttpTransport(config: NexusFileSystemConfig): NexusTransport {
  const base = createBaseTransport({
    url: config.url,
    apiKey: config.apiKey,
    deadlineMs: config.deadlineMs,
    retries: config.retries,
  });

  return {
    call: base.call,
    close: base.close,
    // HTTP transport has no bridge subprocess — notifications are local-only.
    subscribe: () => () => {},
    submitAuthCode: () => {},
  };
}
```

- [ ] **Step 4: Run fs-nexus tests to verify no regression**

```bash
bun run test --filter=@koi/fs-nexus
```

Expected: All existing tests pass.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck --filter=@koi/fs-nexus
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/fs-nexus/
git commit -m "refactor(fs-nexus): delegate HTTP transport to @koi/nexus-client (#1399)"
```

---

## Task 5: Scaffold `@koi/permissions-nexus` — types, config, failing tests

**Files:**
- Create: `packages/security/permissions-nexus/package.json`
- Create: `packages/security/permissions-nexus/tsconfig.json`
- Create: `packages/security/permissions-nexus/tsup.config.ts`
- Create: `packages/security/permissions-nexus/src/types.ts`
- Create: `packages/security/permissions-nexus/src/config.ts`
- Create: `packages/security/permissions-nexus/src/config.test.ts`

- [ ] **Step 1: Create `packages/security/permissions-nexus/package.json`**

```json
{
  "name": "@koi/permissions-nexus",
  "description": "Nexus-backed permission persistence, cross-node sync, and delegation hooks",
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
    "test": "bun test"
  },
  "koi": { "optional": true },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/security/permissions-nexus/tsconfig.json`**

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
    { "path": "../../lib/nexus-client" }
  ]
}
```

- [ ] **Step 3: Create `packages/security/permissions-nexus/tsup.config.ts`**

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

- [ ] **Step 4: Create `packages/security/permissions-nexus/src/types.ts`**

```typescript
/** Zanzibar-style relationship tuple for ReBAC delegation. */
export interface RelationshipTuple {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
}

/** Nexus policy version tag for cheap poll comparison. */
export interface NexusVersionTag {
  readonly version: number;
  readonly updatedAt: number;
}
```

- [ ] **Step 5: Create `packages/security/permissions-nexus/src/config.ts`**

```typescript
import type { KoiError, PermissionBackend, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPermissionsConfig {
  readonly transport: NexusTransport;
  /** Current local backend — used for all check() calls. */
  readonly localBackend: PermissionBackend;
  /** Serialize current policy to a JSON-storable object. */
  readonly getCurrentPolicy: () => unknown;
  /** Reconstruct a PermissionBackend from a Nexus-loaded policy. */
  readonly rebuildBackend: (policy: unknown) => PermissionBackend;
  /** Poll interval in ms. Default: 30_000. Set 0 to disable. */
  readonly syncIntervalMs?: number | undefined;
  /** Nexus NFS path prefix. Default: "koi/permissions". */
  readonly policyPath?: string | undefined;
}

export function validateNexusPermissionsConfig(
  raw: unknown,
): Result<NexusPermissionsConfig, KoiError> {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config must be a non-null object", retryable: false },
    };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj["transport"] !== "object" || obj["transport"] === null) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.transport must be provided", retryable: false },
    };
  }
  if (typeof obj["localBackend"] !== "object" || obj["localBackend"] === null) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.localBackend must be provided", retryable: false },
    };
  }
  if (typeof obj["getCurrentPolicy"] !== "function") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.getCurrentPolicy must be a function", retryable: false },
    };
  }
  if (typeof obj["rebuildBackend"] !== "function") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.rebuildBackend must be a function", retryable: false },
    };
  }
  if (
    obj["syncIntervalMs"] !== undefined &&
    (typeof obj["syncIntervalMs"] !== "number" || obj["syncIntervalMs"] < 0)
  ) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.syncIntervalMs must be a non-negative number", retryable: false },
    };
  }

  return { ok: true, value: raw as NexusPermissionsConfig };
}
```

- [ ] **Step 6: Write `packages/security/permissions-nexus/src/config.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { validateNexusPermissionsConfig } from "./config.js";

const validConfig = {
  transport: { call: async () => ({ ok: true, value: null }), close: () => {} },
  localBackend: { check: () => ({ effect: "allow" as const }) },
  getCurrentPolicy: () => [],
  rebuildBackend: () => ({ check: () => ({ effect: "allow" as const }) }),
};

describe("validateNexusPermissionsConfig", () => {
  test("returns ok for valid config", () => {
    const result = validateNexusPermissionsConfig(validConfig);
    expect(result.ok).toBe(true);
  });

  test("rejects null", () => {
    const result = validateNexusPermissionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects missing transport", () => {
    const result = validateNexusPermissionsConfig({ ...validConfig, transport: null });
    expect(result.ok).toBe(false);
  });

  test("rejects missing getCurrentPolicy", () => {
    const result = validateNexusPermissionsConfig({ ...validConfig, getCurrentPolicy: "not-a-fn" });
    expect(result.ok).toBe(false);
  });

  test("rejects negative syncIntervalMs", () => {
    const result = validateNexusPermissionsConfig({ ...validConfig, syncIntervalMs: -1 });
    expect(result.ok).toBe(false);
  });

  test("accepts syncIntervalMs: 0 (polling disabled)", () => {
    const result = validateNexusPermissionsConfig({ ...validConfig, syncIntervalMs: 0 });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 7: Run config tests (should pass)**

```bash
bun test packages/security/permissions-nexus/src/config.test.ts
```

Expected: All pass.

- [ ] **Step 8: Commit scaffold**

```bash
git add packages/security/permissions-nexus/
git commit -m "feat(permissions-nexus): package scaffold, types, config (#1399)"
```

---

## Task 6: Implement `createNexusRevocationRegistry`

**Files:**
- Create: `packages/security/permissions-nexus/src/nexus-revocation-registry.ts`
- Create: `packages/security/permissions-nexus/src/nexus-revocation-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/security/permissions-nexus/src/nexus-revocation-registry.test.ts
import { describe, expect, test } from "bun:test";
import { delegationId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { KoiError, Result } from "@koi/core";
import { createNexusRevocationRegistry } from "./nexus-revocation-registry.js";

function makeTransport(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusTransport {
  return {
    call: handler as NexusTransport["call"],
    close: () => {},
  };
}

describe("createNexusRevocationRegistry", () => {
  test("isRevoked returns false when file not found", async () => {
    const transport = makeTransport(async () => ({
      ok: false,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    }));
    const registry = createNexusRevocationRegistry({ transport });
    expect(await registry.isRevoked(delegationId("g1"))).toBe(false);
  });

  test("isRevoked returns true when revocation record exists", async () => {
    const transport = makeTransport(async () => ({
      ok: true,
      value: JSON.stringify({ revoked: true, cascade: false }),
    }));
    const registry = createNexusRevocationRegistry({ transport });
    expect(await registry.isRevoked(delegationId("g1"))).toBe(true);
  });

  test("isRevoked returns false when revocation record has revoked: false", async () => {
    const transport = makeTransport(async () => ({
      ok: true,
      value: JSON.stringify({ revoked: false, cascade: false }),
    }));
    const registry = createNexusRevocationRegistry({ transport });
    expect(await registry.isRevoked(delegationId("g1"))).toBe(false);
  });

  test("isRevoked returns true (fail-closed) on transport error", async () => {
    const transport = makeTransport(async () => ({
      ok: false,
      error: { code: "TIMEOUT" as const, message: "timeout", retryable: true },
    }));
    const registry = createNexusRevocationRegistry({ transport });
    expect(await registry.isRevoked(delegationId("g1"))).toBe(true);
  });

  test("isRevoked returns true (fail-closed) on malformed JSON", async () => {
    const transport = makeTransport(async () => ({ ok: true, value: "not-json{{" }));
    const registry = createNexusRevocationRegistry({ transport });
    expect(await registry.isRevoked(delegationId("g1"))).toBe(true);
  });

  test("isRevokedBatch returns map with correct results", async () => {
    const data: Record<string, boolean> = { g1: true, g2: false };
    const transport = makeTransport(async (_method, params) => {
      const id = (params as { path: string }).path.split("/").pop()?.replace(".json", "") ?? "";
      const revoked = data[id];
      if (revoked === undefined) {
        return { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
      }
      return { ok: true, value: JSON.stringify({ revoked, cascade: false }) };
    });
    const registry = createNexusRevocationRegistry({ transport });
    const map = await registry.isRevokedBatch([delegationId("g1"), delegationId("g2")]);
    expect(map.get(delegationId("g1"))).toBe(true);
    expect(map.get(delegationId("g2"))).toBe(false);
  });

  test("revoke writes revocation record", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const transport = makeTransport(async (_method, params) => {
      writes.push(params as { path: string; content: string });
      return { ok: true, value: undefined };
    });
    const registry = createNexusRevocationRegistry({ transport });
    await registry.revoke(delegationId("g1"), true);
    expect(writes).toHaveLength(1);
    const body = JSON.parse(writes[0]!.content) as { revoked: boolean; cascade: boolean };
    expect(body.revoked).toBe(true);
    expect(body.cascade).toBe(true);
  });

  test("revoke uses custom policyPath", async () => {
    const paths: string[] = [];
    const transport = makeTransport(async (_method, params) => {
      paths.push((params as { path: string }).path);
      return { ok: true, value: undefined };
    });
    const registry = createNexusRevocationRegistry({ transport, policyPath: "custom/path" });
    await registry.revoke(delegationId("g1"), false);
    expect(paths[0]).toBe("custom/path/revocations/g1.json");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail (module not yet created)**

```bash
bun test packages/security/permissions-nexus/src/nexus-revocation-registry.test.ts
```

Expected: Import error for `./nexus-revocation-registry.js`.

- [ ] **Step 3: Write `packages/security/permissions-nexus/src/nexus-revocation-registry.ts`**

```typescript
import type { DelegationId, RevocationRegistry } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusRevocationRegistryConfig {
  readonly transport: NexusTransport;
  readonly policyPath?: string | undefined;
}

const DEFAULT_POLICY_PATH = "koi/permissions";

export function createNexusRevocationRegistry(
  config: NexusRevocationRegistryConfig,
): Required<RevocationRegistry> {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const isRevoked = async (id: DelegationId): Promise<boolean> => {
    const result = await config.transport.call<string>("read", {
      path: `${policyPath}/revocations/${id}.json`,
    });
    if (!result.ok) {
      return result.error.code !== "NOT_FOUND"; // NOT_FOUND = not revoked; else fail-closed
    }
    try {
      const data = JSON.parse(result.value) as { readonly revoked: boolean };
      return data.revoked;
    } catch {
      return true; // Malformed = fail-closed
    }
  };

  const isRevokedBatch = async (
    ids: readonly DelegationId[],
  ): Promise<ReadonlyMap<DelegationId, boolean>> => {
    const results = await Promise.allSettled(ids.map((id) => isRevoked(id)));
    const map = new Map<DelegationId, boolean>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const r = results[i];
      if (id === undefined || r === undefined) continue;
      map.set(id, r.status === "rejected" ? true : r.value);
    }
    return map;
  };

  const revoke = async (id: DelegationId, cascade: boolean): Promise<void> => {
    await config.transport.call("write", {
      path: `${policyPath}/revocations/${id}.json`,
      content: JSON.stringify({ revoked: true, cascade }),
    });
  };

  return { isRevoked, isRevokedBatch, revoke };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
bun test packages/security/permissions-nexus/src/nexus-revocation-registry.test.ts
```

Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/permissions-nexus/src/nexus-revocation-registry.ts \
        packages/security/permissions-nexus/src/nexus-revocation-registry.test.ts
git commit -m "feat(permissions-nexus): NexusRevocationRegistry, fail-closed semantics (#1399)"
```

---

## Task 7: Implement `createNexusDelegationHooks`

**Files:**
- Create: `packages/security/permissions-nexus/src/nexus-delegation-hooks.ts`
- Create: `packages/security/permissions-nexus/src/nexus-delegation-hooks.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/security/permissions-nexus/src/nexus-delegation-hooks.test.ts
import { describe, expect, test } from "bun:test";
import { agentId, delegationId } from "@koi/core";
import type { DelegationGrant } from "@koi/core";
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusDelegationHooks } from "./nexus-delegation-hooks.js";

function makeTransport(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusTransport {
  return { call: handler as NexusTransport["call"], close: () => {} };
}

const grant: DelegationGrant = {
  id: delegationId("grant-1"),
  issuerId: agentId("issuer"),
  delegateeId: agentId("delegatee"),
  scope: {
    permissions: { allow: ["read_file", "list_files"], deny: [] },
    resources: ["/workspace/src/**"],
  },
  chainDepth: 0,
};

describe("createNexusDelegationHooks", () => {
  test("onGrant writes tuple file to Nexus", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const transport = makeTransport(async (_m, params) => {
      writes.push(params as { path: string; content: string });
      return { ok: true, value: undefined };
    });
    const hooks = createNexusDelegationHooks({ transport });
    await hooks.onGrant(grant);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("koi/permissions/tuples/grant-1.json");
    const tuples = JSON.parse(writes[0]!.content) as unknown[];
    expect(tuples.length).toBeGreaterThan(0);
  });

  test("onGrant throws (fail-closed) on Nexus write failure", async () => {
    const transport = makeTransport(async () => ({
      ok: false,
      error: { code: "TIMEOUT" as const, message: "timeout", retryable: true },
    }));
    const hooks = createNexusDelegationHooks({ transport });
    await expect(hooks.onGrant(grant)).rejects.toThrow("Nexus tuple write failed");
  });

  test("onGrant does nothing when grant has no permissions", async () => {
    const writes: unknown[] = [];
    const transport = makeTransport(async (_m, params) => {
      writes.push(params);
      return { ok: true, value: undefined };
    });
    const emptyGrant: DelegationGrant = {
      ...grant,
      scope: { permissions: { allow: [], deny: [] } },
    };
    const hooks = createNexusDelegationHooks({ transport });
    await hooks.onGrant(emptyGrant);
    expect(writes).toHaveLength(0);
  });

  test("onRevoke deletes tuple file (best-effort)", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const transport = makeTransport(async (method, params) => {
      calls.push({ method, path: (params as { path: string }).path });
      return { ok: true, value: undefined };
    });
    const hooks = createNexusDelegationHooks({ transport });
    await hooks.onRevoke(delegationId("grant-1"), false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("koi/permissions/tuples/grant-1.json");
  });

  test("onRevoke does NOT throw on Nexus failure (best-effort)", async () => {
    const transport = makeTransport(async () => ({
      ok: false,
      error: { code: "TIMEOUT" as const, message: "timeout", retryable: true },
    }));
    const hooks = createNexusDelegationHooks({ transport });
    await expect(hooks.onRevoke(delegationId("grant-1"), false)).resolves.toBeUndefined();
  });

  test("uses custom policyPath", async () => {
    const paths: string[] = [];
    const transport = makeTransport(async (_m, params) => {
      paths.push((params as { path: string }).path);
      return { ok: true, value: undefined };
    });
    const hooks = createNexusDelegationHooks({ transport, policyPath: "custom" });
    await hooks.onGrant(grant);
    expect(paths[0]).toMatch(/^custom\/tuples\//);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun test packages/security/permissions-nexus/src/nexus-delegation-hooks.test.ts
```

Expected: Import error.

- [ ] **Step 3: Write `packages/security/permissions-nexus/src/nexus-delegation-hooks.ts`**

```typescript
import type { DelegationGrant, DelegationId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { RelationshipTuple } from "./types.js";

export interface NexusDelegationHooksConfig {
  readonly transport: NexusTransport;
  readonly policyPath?: string | undefined;
}

export interface NexusDelegationHooks {
  readonly onGrant: (grant: DelegationGrant) => Promise<void>;
  readonly onRevoke: (grantId: DelegationId, cascade: boolean) => Promise<void>;
}

const DEFAULT_POLICY_PATH = "koi/permissions";

function mapGrantToTuples(grant: DelegationGrant): readonly RelationshipTuple[] {
  const permissions = grant.scope.permissions.allow ?? [];
  const resources = grant.scope.resources;
  const subject = `agent:${grant.delegateeId}`;

  if (resources !== undefined && resources.length > 0) {
    return permissions.flatMap((permission) =>
      resources.map((resource) => ({ subject, relation: permission, object: resource })),
    );
  }
  return permissions.map((permission) => ({
    subject,
    relation: permission,
    object: `delegation:${grant.id}`,
  }));
}

export function createNexusDelegationHooks(
  config: NexusDelegationHooksConfig,
): NexusDelegationHooks {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;

  const onGrant = async (grant: DelegationGrant): Promise<void> => {
    const tuples = mapGrantToTuples(grant);
    if (tuples.length === 0) return;

    const result = await config.transport.call("write", {
      path: `${policyPath}/tuples/${grant.id}.json`,
      content: JSON.stringify(tuples),
    });

    if (!result.ok) {
      throw new Error(
        `Nexus tuple write failed for grant ${grant.id}: ${result.error.message}`,
        { cause: result.error },
      );
    }
  };

  const onRevoke = async (grantId: DelegationId, _cascade: boolean): Promise<void> => {
    // Best-effort — silently swallow (revocation is the safety operation)
    await config.transport
      .call("delete", { path: `${policyPath}/tuples/${grantId}.json` })
      .catch(() => {});
  };

  return { onGrant, onRevoke };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
bun test packages/security/permissions-nexus/src/nexus-delegation-hooks.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/security/permissions-nexus/src/nexus-delegation-hooks.ts \
        packages/security/permissions-nexus/src/nexus-delegation-hooks.test.ts
git commit -m "feat(permissions-nexus): NexusDelegationHooks, fail-closed onGrant, best-effort onRevoke (#1399)"
```

---

## Task 8: Implement `createNexusPermissionBackend`

**Files:**
- Create: `packages/security/permissions-nexus/src/nexus-permission-backend.ts`
- Create: `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts`
- Create: `packages/security/permissions-nexus/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/security/permissions-nexus/src/nexus-permission-backend.test.ts
import { describe, expect, test } from "bun:test";
import type { KoiError, PermissionBackend, PermissionDecision, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "./nexus-permission-backend.js";

/** Flush the microtask queue so fire-and-forget initializePolicy completes. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeLocalBackend(effect: "allow" | "deny" = "allow"): PermissionBackend {
  return {
    check: () => (effect === "allow" ? { effect: "allow" } : { effect: "deny", reason: "denied" }),
    checkBatch: (queries) =>
      queries.map((): PermissionDecision =>
        effect === "allow" ? { effect: "allow" } : { effect: "deny", reason: "denied" },
      ),
    dispose: () => {},
    supportsDefaultDenyMarker: true,
  };
}

function makeTransport(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusTransport {
  return { call: handler as NexusTransport["call"], close: () => {} };
}

const nexusDown = makeTransport(async () => ({
  ok: false,
  error: { code: "TIMEOUT" as const, message: "down", retryable: true },
}));

describe("createNexusPermissionBackend", () => {
  test("check() delegates to local backend — never calls Nexus", async () => {
    const nexusCalls: string[] = [];
    const transport = makeTransport(async (method) => {
      nexusCalls.push(method);
      return { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
    });
    const local = makeLocalBackend("allow");
    const backend = createNexusPermissionBackend({
      transport,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: () => local,
      syncIntervalMs: 0,
    });

    const decision = await Promise.resolve(
      backend.check({ principal: "agent", action: "execute", resource: "tool:bash" }),
    );
    expect(decision.effect).toBe("allow");

    const checkCalls = nexusCalls.filter((m) => m === "permissions.check");
    expect(checkCalls).toHaveLength(0);
    backend.dispose();
  });

  test("checkBatch() delegates to local backend", async () => {
    const local = makeLocalBackend("deny");
    const backend = createNexusPermissionBackend({
      transport: nexusDown,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: () => local,
      syncIntervalMs: 0,
    });
    const decisions = await Promise.resolve(
      backend.checkBatch?.([
        { principal: "a", action: "x", resource: "r1" },
        { principal: "a", action: "x", resource: "r2" },
      ]) ?? [],
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.effect).toBe("deny");
    backend.dispose();
  });

  test("writes policy to Nexus on construction when Nexus has no policy", async () => {
    const writes: Array<{ path: string }> = [];
    const transport = makeTransport(async (method, params) => {
      if (method === "read") {
        return { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
      }
      if (method === "write") {
        writes.push(params as { path: string });
      }
      return { ok: true, value: undefined };
    });
    const local = makeLocalBackend();
    const backend = createNexusPermissionBackend({
      transport,
      localBackend: local,
      getCurrentPolicy: () => [{ pattern: "*", effect: "allow" }],
      rebuildBackend: () => local,
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    const policyWrite = writes.find((w) => w.path.endsWith("policy.json"));
    expect(policyWrite).toBeDefined();
    backend.dispose();
  });

  test("loads policy from Nexus on construction when Nexus policy exists", async () => {
    const nexusPolicy = [{ pattern: "tool:safe_*", effect: "allow" }];
    let rebuildCalled = false;
    const transport = makeTransport(async (method, params) => {
      const path = (params as { path: string }).path;
      if (method === "read" && path.endsWith("version.json")) {
        return { ok: true, value: JSON.stringify({ version: 1, updatedAt: Date.now() }) };
      }
      if (method === "read" && path.endsWith("policy.json")) {
        return { ok: true, value: JSON.stringify(nexusPolicy) };
      }
      return { ok: true, value: undefined };
    });
    const local = makeLocalBackend("deny");
    const backend = createNexusPermissionBackend({
      transport,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: (p) => {
        rebuildCalled = true;
        expect(p).toEqual(nexusPolicy);
        return makeLocalBackend("allow");
      },
      syncIntervalMs: 0,
    });

    await flushMicrotasks();
    expect(rebuildCalled).toBe(true);
    // After loading from Nexus the rebuilt backend returns "allow"
    const decision = await Promise.resolve(
      backend.check({ principal: "a", action: "x", resource: "r" }),
    );
    expect(decision.effect).toBe("allow");
    backend.dispose();
  });

  test("runs on local rules when Nexus unreachable at startup", async () => {
    const local = makeLocalBackend("allow");
    const backend = createNexusPermissionBackend({
      transport: nexusDown,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: () => local,
      syncIntervalMs: 0,
    });
    await flushMicrotasks();
    const decision = await Promise.resolve(
      backend.check({ principal: "a", action: "x", resource: "r" }),
    );
    expect(decision.effect).toBe("allow");
    backend.dispose();
  });

  test("poll skips rebuild when version unchanged", async () => {
    let rebuildCount = 0;
    const transport = makeTransport(async (method, params) => {
      const path = (params as { path: string }).path;
      if (method === "read" && path.endsWith("version.json")) {
        return { ok: true, value: JSON.stringify({ version: 5, updatedAt: 0 }) };
      }
      return { ok: true, value: undefined };
    });
    const local = makeLocalBackend();
    const backend = createNexusPermissionBackend({
      transport,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: () => {
        rebuildCount++;
        return local;
      },
      syncIntervalMs: 0,
    });
    // Manually trigger two polls — version is always 5 after initial load
    await flushMicrotasks(); // init (reads version=5, loads policy, rebuilds once)
    const countAfterInit = rebuildCount;
    // Simulate a poll tick — version still 5
    await (backend as unknown as { _poll?: () => Promise<void> })._poll?.();
    expect(rebuildCount).toBe(countAfterInit); // no additional rebuild
    backend.dispose();
  });

  test("dispose() cancels polling interval", () => {
    const local = makeLocalBackend();
    const backend = createNexusPermissionBackend({
      transport: nexusDown,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: () => local,
      syncIntervalMs: 100,
    });
    // Should not throw
    expect(() => backend.dispose()).not.toThrow();
  });
});
```

Note: The `_poll` test uses an internal escape hatch; if the implementation doesn't expose `_poll`, that specific assertion can be skipped and the `syncIntervalMs` behavior is covered by integration via the timer.

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun test packages/security/permissions-nexus/src/nexus-permission-backend.test.ts
```

Expected: Import error.

- [ ] **Step 3: Write `packages/security/permissions-nexus/src/nexus-permission-backend.ts`**

```typescript
import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { NexusVersionTag } from "./types.js";

export interface NexusPermissionBackendConfig {
  readonly transport: NexusTransport;
  readonly localBackend: PermissionBackend;
  readonly getCurrentPolicy: () => unknown;
  readonly rebuildBackend: (policy: unknown) => PermissionBackend;
  readonly syncIntervalMs?: number | undefined;
  readonly policyPath?: string | undefined;
}

export interface NexusPermissionBackend extends PermissionBackend {
  readonly dispose: () => void;
  /** @internal Exposed for testing poll logic without real timers. */
  readonly _poll: () => Promise<void>;
}

const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_POLICY_PATH = "koi/permissions";

export function createNexusPermissionBackend(
  config: NexusPermissionBackendConfig,
): NexusPermissionBackend {
  const policyPath = config.policyPath ?? DEFAULT_POLICY_PATH;
  const syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;

  // let justified: mutable local backend — replaced atomically on sync
  let localBackend = config.localBackend;
  // let justified: last-seen version tag for cheap poll comparison
  let lastSeenVersion = -1;
  // let justified: lifecycle flags
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  async function writeCurrentPolicy(): Promise<void> {
    const policy = config.getCurrentPolicy();
    await config.transport.call("write", {
      path: `${policyPath}/policy.json`,
      content: JSON.stringify(policy),
    });
    const newVersion = lastSeenVersion + 1;
    await config.transport.call("write", {
      path: `${policyPath}/version.json`,
      content: JSON.stringify({ version: newVersion, updatedAt: Date.now() } satisfies NexusVersionTag),
    });
    lastSeenVersion = newVersion;
  }

  async function initializePolicy(): Promise<void> {
    const versionResult = await config.transport.call<string>("read", {
      path: `${policyPath}/version.json`,
    });

    if (!versionResult.ok) {
      // Nexus unreachable or no policy — write current local policy (best-effort)
      await writeCurrentPolicy().catch(() => {});
      return;
    }

    const policyResult = await config.transport.call<string>("read", {
      path: `${policyPath}/policy.json`,
    });
    if (!policyResult.ok) return;

    try {
      const tag = JSON.parse(versionResult.value) as NexusVersionTag;
      const policy: unknown = JSON.parse(policyResult.value);
      localBackend = config.rebuildBackend(policy);
      lastSeenVersion = tag.version;
    } catch {
      console.warn("[permissions-nexus] malformed Nexus policy on startup, using local rules");
    }
  }

  async function poll(): Promise<void> {
    const versionResult = await config.transport.call<string>("read", {
      path: `${policyPath}/version.json`,
    });
    if (!versionResult.ok) return;

    let tag: NexusVersionTag;
    try {
      tag = JSON.parse(versionResult.value) as NexusVersionTag;
    } catch {
      return;
    }
    if (tag.version === lastSeenVersion) return;

    const policyResult = await config.transport.call<string>("read", {
      path: `${policyPath}/policy.json`,
    });
    if (!policyResult.ok) return;

    try {
      const policy: unknown = JSON.parse(policyResult.value);
      localBackend = config.rebuildBackend(policy);
      lastSeenVersion = tag.version;
    } catch {
      console.warn("[permissions-nexus] malformed Nexus policy during sync, skipping update");
    }
  }

  function startPolling(): void {
    if (syncIntervalMs === 0 || disposed) return;
    timer = setInterval(() => {
      void poll().catch(() => {}); // non-fatal
    }, syncIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  // Fire-and-forget startup: init then start polling
  void initializePolicy()
    .catch(() => {
      console.warn("[permissions-nexus] startup Nexus sync failed, running on local rules");
    })
    .finally(() => {
      if (!disposed) startPolling();
    });

  function check(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision> {
    return localBackend.check(query);
  }

  function checkBatch(
    queries: readonly PermissionQuery[],
  ): Promise<readonly PermissionDecision[]> {
    if (localBackend.checkBatch !== undefined) {
      return Promise.resolve(localBackend.checkBatch(queries));
    }
    return Promise.all(queries.map((q) => Promise.resolve(localBackend.check(q))));
  }

  function dispose(): void {
    disposed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    void localBackend.dispose?.();
  }

  return {
    check,
    checkBatch,
    dispose,
    supportsDefaultDenyMarker: config.localBackend.supportsDefaultDenyMarker,
    _poll: poll,
  };
}
```

- [ ] **Step 4: Create `packages/security/permissions-nexus/src/index.ts`**

```typescript
export type { NexusPermissionsConfig } from "./config.js";
export { validateNexusPermissionsConfig } from "./config.js";
export type { NexusDelegationHooks, NexusDelegationHooksConfig } from "./nexus-delegation-hooks.js";
export { createNexusDelegationHooks } from "./nexus-delegation-hooks.js";
export type {
  NexusPermissionBackend,
  NexusPermissionBackendConfig,
} from "./nexus-permission-backend.js";
export { createNexusPermissionBackend } from "./nexus-permission-backend.js";
export type { NexusRevocationRegistryConfig } from "./nexus-revocation-registry.js";
export { createNexusRevocationRegistry } from "./nexus-revocation-registry.js";
export type { NexusVersionTag, RelationshipTuple } from "./types.js";
```

- [ ] **Step 5: Run all permissions-nexus tests**

```bash
bun run test --filter=@koi/permissions-nexus
```

Expected: All tests pass. The `_poll` test may be skipped if implementation doesn't expose it — that's acceptable.

- [ ] **Step 6: Typecheck**

```bash
bun run typecheck --filter=@koi/permissions-nexus
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/security/permissions-nexus/src/nexus-permission-backend.ts \
        packages/security/permissions-nexus/src/nexus-permission-backend.test.ts \
        packages/security/permissions-nexus/src/index.ts
git commit -m "feat(permissions-nexus): NexusPermissionBackend — local-first, write-through, polling sync (#1399)"
```

---

## Task 9: Implement `@koi/audit-sink-nexus`

**Files:**
- Create: `packages/security/audit-sink-nexus/package.json`
- Create: `packages/security/audit-sink-nexus/tsconfig.json`
- Create: `packages/security/audit-sink-nexus/tsup.config.ts`
- Create: `packages/security/audit-sink-nexus/src/config.ts`
- Create: `packages/security/audit-sink-nexus/src/nexus-sink.ts`
- Create: `packages/security/audit-sink-nexus/src/index.ts`
- Create: `packages/security/audit-sink-nexus/src/config.test.ts`
- Create: `packages/security/audit-sink-nexus/src/nexus-sink.test.ts`

- [ ] **Step 1: Create `packages/security/audit-sink-nexus/package.json`**

```json
{
  "name": "@koi/audit-sink-nexus",
  "description": "Nexus-backed AuditSink — batched writes with interval and size triggers",
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
    "test": "bun test"
  },
  "koi": { "optional": true },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/security/audit-sink-nexus/tsconfig.json`**

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
    { "path": "../../lib/nexus-client" }
  ]
}
```

- [ ] **Step 3: Create `packages/security/audit-sink-nexus/tsup.config.ts`**

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

- [ ] **Step 4: Create `packages/security/audit-sink-nexus/src/config.ts`**

```typescript
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusAuditSinkConfig {
  readonly transport: NexusTransport;
  readonly basePath?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly flushIntervalMs?: number | undefined;
}

export const DEFAULT_BASE_PATH = "koi/audit";
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export function validateNexusAuditSinkConfig(
  raw: unknown,
): Result<NexusAuditSinkConfig, KoiError> {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config must be a non-null object", retryable: false },
    };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["transport"] !== "object" || obj["transport"] === null) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.transport must be provided", retryable: false },
    };
  }
  if (
    obj["batchSize"] !== undefined &&
    (typeof obj["batchSize"] !== "number" || obj["batchSize"] < 1)
  ) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "config.batchSize must be a positive number", retryable: false },
    };
  }
  return { ok: true, value: raw as NexusAuditSinkConfig };
}
```

- [ ] **Step 5: Write failing tests for `nexus-sink.ts`**

```typescript
// packages/security/audit-sink-nexus/src/nexus-sink.test.ts
import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@koi/core";
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusAuditSink } from "./nexus-sink.js";

function makeTransport(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusTransport {
  return { call: handler as NexusTransport["call"], close: () => {} };
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    schema_version: 1,
    timestamp: 1000,
    sessionId: "session-1",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "tool_call",
    durationMs: 5,
    ...overrides,
  };
}

describe("createNexusAuditSink", () => {
  test("log + flush writes entries to Nexus", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const transport = makeTransport(async (_m, params) => {
      writes.push(params as { path: string; content: string });
      return { ok: true, value: undefined };
    });
    const sink = createNexusAuditSink({ transport, batchSize: 100 });
    await sink.log(makeEntry({ turnIndex: 0 }));
    await sink.log(makeEntry({ turnIndex: 1 }));
    await sink.flush?.();
    expect(writes).toHaveLength(2);
  });

  test("flush triggers when batchSize reached", async () => {
    const writes: Array<{ path: string }> = [];
    const transport = makeTransport(async (_m, params) => {
      writes.push(params as { path: string });
      return { ok: true, value: undefined };
    });
    const sink = createNexusAuditSink({ transport, batchSize: 2 });
    await sink.log(makeEntry({ turnIndex: 0 }));
    await sink.log(makeEntry({ turnIndex: 1 })); // triggers flush
    // Give the async flush a tick to complete
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  test("entry paths include sessionId and kind", async () => {
    const paths: string[] = [];
    const transport = makeTransport(async (_m, params) => {
      paths.push((params as { path: string }).path);
      return { ok: true, value: undefined };
    });
    const sink = createNexusAuditSink({ transport, basePath: "test/audit", batchSize: 100 });
    await sink.log(makeEntry({ sessionId: "sess-abc", kind: "model_call", timestamp: 500 }));
    await sink.flush?.();
    expect(paths[0]).toMatch(/^test\/audit\/sess-abc\//);
    expect(paths[0]).toMatch(/model_call/);
  });

  test("query flushes then returns sorted entries", async () => {
    const store = new Map<string, string>();
    const transport = makeTransport(async (method, params) => {
      const p = (params as { path: string }).path;
      if (method === "write") {
        store.set(p, (params as { content: string }).content);
        return { ok: true, value: undefined };
      }
      if (method === "list") {
        const prefix = p + "/";
        const files = [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ path: k }));
        return { ok: true, value: files };
      }
      if (method === "read") {
        const v = store.get(p);
        return v !== undefined
          ? { ok: true, value: v }
          : { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
      }
      return { ok: true, value: undefined };
    });

    const sink = createNexusAuditSink({ transport, batchSize: 100 });
    await sink.log(makeEntry({ sessionId: "sess-1", timestamp: 200, turnIndex: 1 }));
    await sink.log(makeEntry({ sessionId: "sess-1", timestamp: 100, turnIndex: 0 }));
    const entries = await sink.query?.("sess-1") ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.timestamp).toBe(100);  // sorted by timestamp
    expect(entries[1]?.timestamp).toBe(200);
  });

  test("flush propagates write error", async () => {
    const transport = makeTransport(async () => ({
      ok: false,
      error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
    }));
    const sink = createNexusAuditSink({ transport, batchSize: 100 });
    await sink.log(makeEntry());
    await expect(sink.flush?.()).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run tests — verify they fail**

```bash
bun test packages/security/audit-sink-nexus/src/nexus-sink.test.ts
```

Expected: Import error.

- [ ] **Step 7: Write `packages/security/audit-sink-nexus/src/nexus-sink.ts`**

```typescript
import type { AuditEntry, AuditSink } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import {
  DEFAULT_BASE_PATH,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  type NexusAuditSinkConfig,
} from "./config.js";

export function createNexusAuditSink(config: NexusAuditSinkConfig): AuditSink {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  // let justified: mutable buffer swapped atomically on flush
  let buffer: AuditEntry[] = [];
  // let justified: lifecycle state
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let entrySeq = 0;

  function computePath(entry: AuditEntry): string {
    const safeSession = entry.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${basePath}/${safeSession}/${entry.timestamp}-${entry.turnIndex}-${entry.kind}-${entrySeq++}.json`;
  }

  async function writeEntry(transport: NexusTransport, entry: AuditEntry): Promise<void> {
    const result = await transport.call("write", {
      path: computePath(entry),
      content: JSON.stringify(entry),
    });
    if (!result.ok) {
      throw new Error(result.error.message, { cause: result.error });
    }
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0 || flushing) return;

    flushing = true;
    const batch = buffer;
    buffer = [];

    try {
      const results = await Promise.allSettled(
        batch.map((entry) => writeEntry(config.transport, entry)),
      );

      const failed = batch.filter((_, i) => results[i]?.status === "rejected");
      if (failed.length > 0) {
        buffer = [...failed, ...buffer]; // re-enqueue for next flush
      }

      const firstFailed = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (firstFailed !== undefined) {
        throw new Error("Failed to write audit entry", { cause: firstFailed.reason });
      }
    } finally {
      flushing = false;
    }
  }

  function ensureTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void flushBuffer().catch(() => {}); // fire-and-forget on interval
    }, flushIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  const log = async (entry: AuditEntry): Promise<void> => {
    buffer = [...buffer, entry];
    ensureTimer();
    if (buffer.length >= batchSize) {
      void flushBuffer().catch(() => {}); // fire-and-forget
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    await flushBuffer();
  };

  const query = async (sessionId: string): Promise<readonly AuditEntry[]> => {
    await flush();

    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const listResult = await config.transport.call<readonly { readonly path: string }[]>(
      "list",
      { path: `${basePath}/${safeSession}` },
    );
    if (!listResult.ok) return [];

    const entries: AuditEntry[] = [];
    for (const file of listResult.value) {
      const readResult = await config.transport.call<string>("read", { path: file.path });
      if (readResult.ok) {
        try {
          entries.push(JSON.parse(readResult.value) as AuditEntry);
        } catch {
          // Skip malformed entries
        }
      }
    }

    return entries.sort((a, b) =>
      a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.turnIndex - b.turnIndex,
    );
  };

  return { log, flush, query };
}
```

- [ ] **Step 8: Create `packages/security/audit-sink-nexus/src/index.ts`**

```typescript
export type { NexusAuditSinkConfig } from "./config.js";
export {
  DEFAULT_BASE_PATH,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  validateNexusAuditSinkConfig,
} from "./config.js";
export { createNexusAuditSink } from "./nexus-sink.js";
```

- [ ] **Step 9: Run all audit-sink-nexus tests**

```bash
bun run test --filter=@koi/audit-sink-nexus
```

Expected: All tests pass.

- [ ] **Step 10: Typecheck**

```bash
bun run typecheck --filter=@koi/audit-sink-nexus
```

Expected: No errors.

- [ ] **Step 11: Commit**

```bash
git add packages/security/audit-sink-nexus/
git commit -m "feat(audit-sink-nexus): Nexus-backed AuditSink — batched writes, queryable (#1399)"
```

---

## Task 10: Register packages in `scripts/layers.ts`

**Files:**
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Add `@koi/nexus-client` to `L0U_PACKAGES`**

In `scripts/layers.ts`, add to the `L0U_PACKAGES` set (alphabetical order, near `@koi/memory`):

```typescript
"@koi/nexus-client",
```

- [ ] **Step 2: Add `@koi/permissions-nexus` and `@koi/audit-sink-nexus` to `L2_PACKAGES`**

In `scripts/layers.ts`, add to the `L2_PACKAGES` set (alphabetical order):

```typescript
"@koi/audit-sink-nexus",
// ...
"@koi/permissions-nexus",
```

- [ ] **Step 3: Run layer check**

```bash
bun run check:layers
```

Expected: No violations. If the check flags `@koi/nexus-client` as unknown, ensure the set entry is present.

- [ ] **Step 4: Commit**

```bash
git add scripts/layers.ts
git commit -m "chore: register nexus-client (L0u), permissions-nexus, audit-sink-nexus (L2) in layers (#1399)"
```

---

## Task 11: Runtime wiring and golden queries

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Add deps to `packages/meta/runtime/package.json`**

Add to `dependencies`:
```json
"@koi/audit-sink-nexus": "workspace:*",
"@koi/permissions-nexus": "workspace:*"
```

- [ ] **Step 2: Add references to `packages/meta/runtime/tsconfig.json`**

Add to `references` (the path convention follows existing entries):
```json
{ "path": "../../security/audit-sink-nexus" },
{ "path": "../../security/permissions-nexus" }
```

- [ ] **Step 3: Add 4 standalone golden queries to `golden-replay.test.ts`**

Append before the last closing brace of the file:

```typescript
// ---------------------------------------------------------------------------
// L2 golden queries: @koi/permissions-nexus (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/permissions-nexus", () => {
  test("local-first: check() passes through to local backend when Nexus is down", async () => {
    const { createNexusPermissionBackend } = await import("@koi/permissions-nexus");

    const nexusDown: import("@koi/nexus-client").NexusTransport = {
      call: async () => ({
        ok: false,
        error: { code: "TIMEOUT" as const, message: "nexus unreachable", retryable: true },
      }),
      close: () => {},
    };

    const local: import("@koi/core").PermissionBackend = {
      check: () => ({ effect: "allow" as const }),
      dispose: () => {},
      supportsDefaultDenyMarker: true,
    };

    const backend = createNexusPermissionBackend({
      transport: nexusDown,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: () => local,
      syncIntervalMs: 0,
    });

    const decision = await Promise.resolve(
      backend.check({ principal: "agent", action: "execute", resource: "tool:bash" }),
    );
    expect(decision.effect).toBe("allow");
    backend.dispose();
  });

  test("sync: rebuilt backend is used after Nexus returns updated policy", async () => {
    const { createNexusPermissionBackend } = await import("@koi/permissions-nexus");

    const policy = [{ pattern: "*", effect: "allow" }];
    let rebuildCalledWith: unknown = null;

    const transport: import("@koi/nexus-client").NexusTransport = {
      call: async (method, params) => {
        const path = (params as { path: string }).path;
        if (method === "read" && path.endsWith("version.json")) {
          return { ok: true, value: JSON.stringify({ version: 1, updatedAt: Date.now() }) };
        }
        if (method === "read" && path.endsWith("policy.json")) {
          return { ok: true, value: JSON.stringify(policy) };
        }
        return { ok: true, value: undefined };
      },
      close: () => {},
    };

    const local: import("@koi/core").PermissionBackend = {
      check: () => ({ effect: "deny" as const, reason: "local deny" }),
      supportsDefaultDenyMarker: true,
    };

    const backend = createNexusPermissionBackend({
      transport,
      localBackend: local,
      getCurrentPolicy: () => [],
      rebuildBackend: (p) => {
        rebuildCalledWith = p;
        return { check: () => ({ effect: "allow" as const }), supportsDefaultDenyMarker: true };
      },
      syncIntervalMs: 0,
    });

    await new Promise<void>((r) => setTimeout(r, 0)); // flush init
    expect(rebuildCalledWith).toEqual(policy);
    const decision = await Promise.resolve(
      backend.check({ principal: "agent", action: "execute", resource: "tool:bash" }),
    );
    expect(decision.effect).toBe("allow");
    backend.dispose();
  });
});

// ---------------------------------------------------------------------------
// L2 golden queries: @koi/audit-sink-nexus (2 queries)
// ---------------------------------------------------------------------------

describe("Golden: @koi/audit-sink-nexus", () => {
  test("log and flush writes entries to Nexus transport", async () => {
    const { createNexusAuditSink } = await import("@koi/audit-sink-nexus");
    type AuditEntry = import("@koi/core").AuditEntry;

    const written: string[] = [];
    const transport: import("@koi/nexus-client").NexusTransport = {
      call: async (_method, params) => {
        written.push((params as { path: string }).path);
        return { ok: true, value: undefined };
      },
      close: () => {},
    };

    const entry: AuditEntry = {
      schema_version: 1,
      timestamp: Date.now(),
      sessionId: "golden-session",
      agentId: "agent-1",
      turnIndex: 0,
      kind: "tool_call",
      durationMs: 10,
    };

    const sink = createNexusAuditSink({ transport, batchSize: 100 });
    await sink.log(entry);
    await sink.flush?.();
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/^koi\/audit\/golden-session\//);
  });

  test("query returns entries sorted by timestamp", async () => {
    const { createNexusAuditSink } = await import("@koi/audit-sink-nexus");
    type AuditEntry = import("@koi/core").AuditEntry;

    const store = new Map<string, string>();
    const transport: import("@koi/nexus-client").NexusTransport = {
      call: async (method, params) => {
        const p = (params as { path: string }).path;
        if (method === "write") {
          store.set(p, (params as { content: string }).content);
          return { ok: true, value: undefined };
        }
        if (method === "list") {
          const prefix = p + "/";
          return {
            ok: true,
            value: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k })),
          };
        }
        if (method === "read") {
          const v = store.get(p);
          return v !== undefined
            ? { ok: true, value: v }
            : { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
        }
        return { ok: true, value: undefined };
      },
      close: () => {},
    };

    const base: Omit<AuditEntry, "timestamp" | "turnIndex"> = {
      schema_version: 1,
      sessionId: "golden-q",
      agentId: "a",
      kind: "model_call",
      durationMs: 5,
    };

    const sink = createNexusAuditSink({ transport, batchSize: 100 });
    await sink.log({ ...base, timestamp: 200, turnIndex: 1 });
    await sink.log({ ...base, timestamp: 100, turnIndex: 0 });
    const entries = await sink.query?.("golden-q") ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.timestamp).toBe(100);
    expect(entries[1]?.timestamp).toBe(200);
  });
});
```

- [ ] **Step 4: Run runtime golden tests**

```bash
bun run test --filter=@koi/runtime
```

Expected: All existing golden tests pass plus the 4 new ones.

- [ ] **Step 5: Typecheck runtime**

```bash
bun run typecheck --filter=@koi/runtime
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/meta/runtime/
git commit -m "feat(runtime): wire @koi/permissions-nexus and @koi/audit-sink-nexus with golden queries (#1399)"
```

---

## Task 12: CI gate verification

- [ ] **Step 1: Full test suite**

```bash
bun run test
```

Expected: All tests pass. Coverage ≥ 80%.

- [ ] **Step 2: Typecheck all packages**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: No lint errors.

- [ ] **Step 4: Layer check**

```bash
bun run check:layers
```

Expected: No violations. Confirms:
- `@koi/nexus-client` (L0u) only imports `@koi/core`
- `@koi/permissions-nexus` (L2) only imports `@koi/core` + `@koi/nexus-client` (L0u)
- `@koi/audit-sink-nexus` (L2) only imports `@koi/core` + `@koi/nexus-client` (L0u)

- [ ] **Step 5: Orphan check**

```bash
bun run check:orphans
```

Expected: No orphaned L2 packages (both new L2s are in `@koi/runtime` deps).

- [ ] **Step 6: Golden query check**

```bash
bun run check:golden-queries
```

Expected: Both `@koi/permissions-nexus` and `@koi/audit-sink-nexus` have ≥ 2 golden query assertions.

- [ ] **Step 7: Duplicate check**

```bash
bun run check:duplicates
```

Expected: No copy-paste blocks detected.

- [ ] **Step 8: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore(permissions-nexus): CI gate cleanup (#1399)"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] `@koi/nexus-client` imports only `@koi/core` — zero vendor deps
- [ ] `@koi/permissions-nexus` `check()` is never async-blocked by Nexus
- [ ] `dispose()` cancels the polling interval — no timer leaks in tests
- [ ] `isRevoked` returns `true` on any non-`NOT_FOUND` error (fail-closed)
- [ ] `onGrant` throws on Nexus failure (fail-closed)
- [ ] `onRevoke` never throws (best-effort)
- [ ] `audit-sink-nexus` `flush()` propagates write errors
- [ ] `audit-sink-nexus` `query()` sorts by `(timestamp, turnIndex)`
- [ ] No `@koi/permissions` import in `@koi/permissions-nexus` source (layer violation)
- [ ] All files < 400 lines, all functions < 50 lines
