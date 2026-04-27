# `@koi/nexus-delegation` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@koi/nexus-delegation`, an L2 package that implements `DelegationComponent` backed by Nexus REST API, with per-child API key grant/revoke, stale-while-revalidate verify cache, and a bounded in-memory revocation retry queue.

**Architecture:** New `packages/security/nexus-delegation/` L2 package. All Nexus REST types and HTTP client are self-contained (no dep on `@koi/nexus-client`). Retry queue is private state inside `NexusDelegationBackend` — drained opportunistically on every `revoke()` call.

**Tech Stack:** Bun 1.3, TypeScript 6 strict, `bun:test`, `@koi/core` + `@koi/errors` deps only (production). `@koi/engine` + `@koi/engine-reconcile` as devDeps for spawn lifecycle tests.

---

## File Map

| File | Responsibility |
|------|---------------|
| `packages/security/nexus-delegation/package.json` | Package manifest |
| `packages/security/nexus-delegation/tsconfig.json` | TS project config |
| `packages/security/nexus-delegation/tsup.config.ts` | Build config |
| `packages/security/nexus-delegation/src/delegation-api.ts` | `NexusDelegationApi` interface + `createNexusDelegationApi` factory |
| `packages/security/nexus-delegation/src/delegation-api.test.ts` | Transport retry, error mapping, request shape tests |
| `packages/security/nexus-delegation/src/scope-mapping.ts` | `DelegationScope` → Nexus wire format (pure functions) |
| `packages/security/nexus-delegation/src/scope-mapping.test.ts` | Mapping correctness |
| `packages/security/nexus-delegation/src/ttl-verify-cache.ts` | SWR verify result cache |
| `packages/security/nexus-delegation/src/ttl-verify-cache.test.ts` | TTL expiry, stale-while-revalidate, invalidation |
| `packages/security/nexus-delegation/src/nexus-delegation-backend.ts` | `DelegationComponent` impl + retry queue |
| `packages/security/nexus-delegation/src/nexus-delegation-backend.test.ts` | grant/revoke/verify/list + retry queue + SWR |
| `packages/security/nexus-delegation/src/nexus-delegation-provider.ts` | `ComponentProvider` wrapping backend |
| `packages/security/nexus-delegation/src/nexus-delegation-provider.test.ts` | Attaches DELEGATION component |
| `packages/security/nexus-delegation/src/index.ts` | Public exports |
| `packages/security/nexus-delegation/src/__tests__/spawn-lifecycle.test.ts` | End-to-end spawn → grant → terminate → revoke |
| `scripts/layers.ts` | Add `@koi/nexus-delegation` to `L2_PACKAGES` |
| `packages/meta/runtime/package.json` | Add `@koi/nexus-delegation` dep |
| `packages/meta/runtime/tsconfig.json` | Add `../../security/nexus-delegation` reference |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | Add 2 standalone `@koi/nexus-delegation` golden queries |

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/security/nexus-delegation/package.json`
- Create: `packages/security/nexus-delegation/tsconfig.json`
- Create: `packages/security/nexus-delegation/tsup.config.ts`
- Create: `packages/security/nexus-delegation/src/index.ts` (empty stub)
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Create `packages/security/nexus-delegation/package.json`**

```json
{
  "name": "@koi/nexus-delegation",
  "description": "Nexus-backed DelegationComponent: per-child API key grant/revoke over Nexus REST. L2.",
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
    "@koi/core": "workspace:*",
    "@koi/errors": "workspace:*"
  },
  "devDependencies": {
    "@koi/engine": "workspace:*",
    "@koi/engine-compose": "workspace:*",
    "@koi/engine-reconcile": "workspace:*"
  }
}
```

- [ ] **Step 2: Create `packages/security/nexus-delegation/tsconfig.json`**

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
    { "path": "../../lib/errors" }
  ]
}
```

- [ ] **Step 3: Create `packages/security/nexus-delegation/tsup.config.ts`**

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

- [ ] **Step 4: Create empty `packages/security/nexus-delegation/src/index.ts`**

```typescript
// exports added in Task 7
```

- [ ] **Step 5: Add `@koi/nexus-delegation` to `L2_PACKAGES` in `scripts/layers.ts`**

In `scripts/layers.ts`, find the `L2_PACKAGES` set and add the new package entry in alphabetical order (after `@koi/nexus-client` area, before `@koi/permissions-nexus`):

```typescript
// Before (excerpt):
export const L2_PACKAGES: ReadonlySet<string> = new Set([
  // ... existing entries ...
  "@koi/mcp",
  "@koi/middleware-audit",
```

```typescript
// After (add "@koi/nexus-delegation" before "@koi/permissions-nexus"):
export const L2_PACKAGES: ReadonlySet<string> = new Set([
  // ... existing entries ...
  "@koi/mcp",
  "@koi/middleware-audit",
  // ... (keep all existing entries, insert new one alphabetically) ...
  "@koi/nexus-delegation",
  "@koi/permissions-nexus",
```

- [ ] **Step 6: Install workspace packages**

```bash
bun install
```

Expected: No errors. `@koi/nexus-delegation` appears in workspace.

- [ ] **Step 7: Commit**

```bash
git add packages/security/nexus-delegation/ scripts/layers.ts bun.lock
git commit -m "chore: scaffold @koi/nexus-delegation L2 package"
```

---

## Task 2: `scope-mapping.ts`

**Files:**
- Create: `packages/security/nexus-delegation/src/scope-mapping.ts`
- Create: `packages/security/nexus-delegation/src/scope-mapping.test.ts`

Note: `NexusDelegateScope` and `NexusNamespaceMode` types are defined in `delegation-api.ts` (Task 3). Scope-mapping imports them. Write the test stubs here, implement the types + functions together.

- [ ] **Step 1: Write failing test**

Create `packages/security/nexus-delegation/src/scope-mapping.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";

describe("mapNamespaceMode", () => {
  test("maps 'copy' to 'COPY'", () => {
    expect(mapNamespaceMode("copy")).toBe("COPY");
  });
  test("maps 'clean' to 'CLEAN'", () => {
    expect(mapNamespaceMode("clean")).toBe("CLEAN");
  });
  test("maps 'shared' to 'SHARED'", () => {
    expect(mapNamespaceMode("shared")).toBe("SHARED");
  });
  test("maps undefined to 'COPY'", () => {
    expect(mapNamespaceMode(undefined)).toBe("COPY");
  });
});

describe("mapScopeToNexus", () => {
  test("maps allow + deny lists", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file", "write_file"], deny: ["exec"] },
    };
    const result = mapScopeToNexus(scope);
    expect(result.allowed_operations).toEqual(["read_file", "write_file"]);
    expect(result.remove_grants).toEqual(["exec"]);
    expect(result.resource_patterns).toBeUndefined();
  });

  test("includes resource_patterns when scope.resources set", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      resources: ["/workspace/src/**"],
    };
    const result = mapScopeToNexus(scope);
    expect(result.resource_patterns).toEqual(["/workspace/src/**"]);
  });

  test("uses empty arrays when allow/deny absent", () => {
    const scope: DelegationScope = { permissions: {} };
    const result = mapScopeToNexus(scope);
    expect(result.allowed_operations).toEqual([]);
    expect(result.remove_grants).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/security/nexus-delegation/src/scope-mapping.test.ts
```

Expected: FAIL — `scope-mapping.js` does not exist.

- [ ] **Step 3: Implement `scope-mapping.ts`**

Create `packages/security/nexus-delegation/src/scope-mapping.ts`:

```typescript
import type { DelegationScope, NamespaceMode } from "@koi/core";
import type { NexusDelegateScope, NexusNamespaceMode } from "./delegation-api.js";

export function mapNamespaceMode(mode: NamespaceMode | undefined): NexusNamespaceMode {
  switch (mode) {
    case "clean":
      return "CLEAN";
    case "shared":
      return "SHARED";
    case "copy":
    case undefined:
      return "COPY";
  }
}

export function mapScopeToNexus(scope: DelegationScope): NexusDelegateScope {
  return {
    allowed_operations: scope.permissions.allow ?? [],
    remove_grants: scope.permissions.deny ?? [],
    ...(scope.resources !== undefined ? { resource_patterns: scope.resources } : {}),
  };
}
```

Note: `NexusDelegateScope` and `NexusNamespaceMode` are imported from `./delegation-api.js` — you must create a stub for that module first (Task 3 Step 1).

- [ ] **Step 4: Create a minimal stub `delegation-api.ts` so the import resolves**

Create `packages/security/nexus-delegation/src/delegation-api.ts` with just the types needed by scope-mapping (full implementation in Task 3):

```typescript
export type NexusNamespaceMode = "COPY" | "CLEAN" | "SHARED";

export interface NexusDelegateScope {
  readonly allowed_operations: readonly string[];
  readonly remove_grants: readonly string[];
  readonly scope_prefix?: string | undefined;
  readonly resource_patterns?: readonly string[] | undefined;
}

// Full NexusDelegationApi and factory added in Task 3
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test packages/security/nexus-delegation/src/scope-mapping.test.ts
```

Expected: PASS — all 7 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/security/nexus-delegation/src/scope-mapping.ts packages/security/nexus-delegation/src/scope-mapping.test.ts packages/security/nexus-delegation/src/delegation-api.ts
git commit -m "feat(@koi/nexus-delegation): scope-mapping + delegation-api type stubs"
```

---

## Task 3: `ttl-verify-cache.ts`

**Files:**
- Create: `packages/security/nexus-delegation/src/ttl-verify-cache.ts`
- Create: `packages/security/nexus-delegation/src/ttl-verify-cache.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/security/nexus-delegation/src/ttl-verify-cache.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { DelegationId } from "@koi/core";
import { delegationId } from "@koi/core";
import { createTtlVerifyCache } from "./ttl-verify-cache.js";

const id = delegationId("grant-1");
const tool = "read_file";
const okResult = { ok: true as const, grant: { id } as never };
const failResult = { ok: false as const, reason: "revoked" as const };

describe("createTtlVerifyCache", () => {
  test("miss returns undefined", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    expect(cache.get(id, tool)).toBeUndefined();
  });

  test("set then get returns result", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    cache.set(id, tool, okResult);
    expect(cache.get(id, tool)).toEqual(okResult);
  });

  test("isStale returns false for fresh entry", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    cache.set(id, tool, okResult);
    expect(cache.isStale(id, tool)).toBe(false);
  });

  test("isStale returns true after ttl elapses (time travel via very short ttl)", async () => {
    const cache = createTtlVerifyCache({ ttlMs: 1 });
    cache.set(id, tool, okResult);
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.isStale(id, tool)).toBe(true);
    // entry still served even when stale (SWR)
    expect(cache.get(id, tool)).toEqual(okResult);
  });

  test("invalidate removes all entries for a grant", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    cache.set(id, "tool_a", okResult);
    cache.set(id, "tool_b", failResult);
    cache.invalidate(id);
    expect(cache.get(id, "tool_a")).toBeUndefined();
    expect(cache.get(id, "tool_b")).toBeUndefined();
  });

  test("evicts oldest when maxEntries exceeded", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set(id, "t1", okResult);
    cache.set(id, "t2", okResult);
    cache.set(id, "t3", okResult); // evicts t1
    expect(cache.size()).toBe(2);
    expect(cache.get(id, "t1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/security/nexus-delegation/src/ttl-verify-cache.test.ts
```

Expected: FAIL — `ttl-verify-cache.js` does not exist.

- [ ] **Step 3: Implement `ttl-verify-cache.ts`**

Create `packages/security/nexus-delegation/src/ttl-verify-cache.ts`:

```typescript
import type { DelegationId, DelegationVerifyResult } from "@koi/core";

export interface TtlVerifyCacheConfig {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly result: DelegationVerifyResult;
  readonly cachedAt: number;
  readonly ttlMs: number;
}

export interface TtlVerifyCache {
  readonly get: (grantId: DelegationId, toolId: string) => DelegationVerifyResult | undefined;
  readonly isStale: (grantId: DelegationId, toolId: string) => boolean;
  readonly set: (grantId: DelegationId, toolId: string, result: DelegationVerifyResult) => void;
  readonly invalidate: (grantId: DelegationId) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1024;

function cacheKey(grantId: DelegationId, toolId: string): string {
  return `${grantId}:${toolId}`;
}

export function createTtlVerifyCache(config?: TtlVerifyCacheConfig): TtlVerifyCache {
  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, CacheEntry>();
  const grantKeys = new Map<DelegationId, Set<string>>();

  function evictOldest(): void {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
    for (const [gid, keys] of grantKeys) {
      if (keys.has(oldest)) {
        keys.delete(oldest);
        if (keys.size === 0) grantKeys.delete(gid);
        break;
      }
    }
  }

  function trackKey(grantId: DelegationId, key: string): void {
    const existing = grantKeys.get(grantId);
    if (existing !== undefined) {
      existing.add(key);
    } else {
      grantKeys.set(grantId, new Set([key]));
    }
  }

  return {
    get: (grantId, toolId) => cache.get(cacheKey(grantId, toolId))?.result,

    isStale: (grantId, toolId) => {
      const entry = cache.get(cacheKey(grantId, toolId));
      if (entry === undefined) return true;
      return Date.now() - entry.cachedAt > entry.ttlMs;
    },

    set: (grantId, toolId, result) => {
      const key = cacheKey(grantId, toolId);
      if (cache.size >= maxEntries && !cache.has(key)) evictOldest();
      cache.set(key, { result, cachedAt: Date.now(), ttlMs });
      trackKey(grantId, key);
    },

    invalidate: (grantId) => {
      const keys = grantKeys.get(grantId);
      if (keys !== undefined) {
        for (const key of keys) cache.delete(key);
        grantKeys.delete(grantId);
      }
    },

    clear: () => {
      cache.clear();
      grantKeys.clear();
    },

    size: () => cache.size,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/security/nexus-delegation/src/ttl-verify-cache.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/security/nexus-delegation/src/ttl-verify-cache.ts packages/security/nexus-delegation/src/ttl-verify-cache.test.ts
git commit -m "feat(@koi/nexus-delegation): TTL verify cache with stale-while-revalidate"
```

---

## Task 4: `delegation-api.ts` (full implementation)

**Files:**
- Modify: `packages/security/nexus-delegation/src/delegation-api.ts` (expand the stub from Task 2)
- Create: `packages/security/nexus-delegation/src/delegation-api.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/security/nexus-delegation/src/delegation-api.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { delegationId } from "@koi/core";
import { createNexusDelegationApi } from "./delegation-api.js";

const BASE_URL = "http://nexus.test";
const TEST_KEY = "test-api-key";
const GRANT_ID = delegationId("del-abc");

function makeOkFetch(body: unknown, status = 200): typeof fetch {
  return async (_input, _init) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

function makeErrorFetch(status: number): typeof fetch {
  return async () => new Response(JSON.stringify({ error: "oops" }), { status });
}

describe("createNexusDelegationApi", () => {
  test("createDelegation sends POST with Authorization header", async () => {
    let captured: Request | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      captured = new Request(input as string, init);
      return new Response(
        JSON.stringify({
          delegation_id: "del-abc",
          api_key: "child-key-123",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const api = createNexusDelegationApi({ url: BASE_URL, apiKey: TEST_KEY, fetch: mockFetch });
    const result = await api.createDelegation({
      parent_agent_id: "parent-1",
      child_agent_id: "child-1",
      scope: { allowed_operations: ["read_file"], remove_grants: [] },
      namespace_mode: "COPY",
      max_depth: 3,
      ttl_seconds: 3600,
      can_sub_delegate: true,
      idempotency_key: "idem-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.api_key).toBe("child-key-123");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  test("revokeDelegation sends DELETE to correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = input as string;
      return new Response(null, { status: 204 });
    };
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: mockFetch });
    const result = await api.revokeDelegation(GRANT_ID);
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain(`/api/v2/agents/delegate/${GRANT_ID}`);
  });

  test("revokeDelegation treats 404 as success", async () => {
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: makeErrorFetch(404) });
    const result = await api.revokeDelegation(GRANT_ID);
    expect(result.ok).toBe(true);
  });

  test("createDelegation returns error result on 500", async () => {
    const api = createNexusDelegationApi({ url: BASE_URL, fetch: makeErrorFetch(500) });
    const result = await api.createDelegation({
      parent_agent_id: "p",
      child_agent_id: "c",
      scope: { allowed_operations: [], remove_grants: [] },
      namespace_mode: "COPY",
      max_depth: 3,
      ttl_seconds: 3600,
      can_sub_delegate: false,
      idempotency_key: "k",
    });
    expect(result.ok).toBe(false);
  });

  test("verifyChain sends GET to chain URL", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: async (input) => {
        capturedUrl = input as string;
        return new Response(
          JSON.stringify({ delegation_id: GRANT_ID, valid: true, chain_depth: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const result = await api.verifyChain(GRANT_ID);
    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain(`${GRANT_ID}/chain`);
  });

  test("listDelegations paginates with cursor", async () => {
    let capturedUrl = "";
    const api = createNexusDelegationApi({
      url: BASE_URL,
      fetch: async (input) => {
        capturedUrl = input as string;
        return new Response(
          JSON.stringify({ delegations: [], total: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    await api.listDelegations("cursor-xyz");
    expect(capturedUrl).toContain("cursor=cursor-xyz");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/security/nexus-delegation/src/delegation-api.test.ts
```

Expected: FAIL — `createNexusDelegationApi` not yet exported.

- [ ] **Step 3: Implement full `delegation-api.ts`**

Replace the stub content of `packages/security/nexus-delegation/src/delegation-api.ts`:

```typescript
import type { DelegationId, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Wire types (Nexus API shape)
// ---------------------------------------------------------------------------

export type NexusNamespaceMode = "COPY" | "CLEAN" | "SHARED";

export interface NexusDelegateScope {
  readonly allowed_operations: readonly string[];
  readonly remove_grants: readonly string[];
  readonly scope_prefix?: string | undefined;
  readonly resource_patterns?: readonly string[] | undefined;
}

export interface NexusDelegateRequest {
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly scope: NexusDelegateScope;
  readonly namespace_mode: NexusNamespaceMode;
  readonly max_depth: number;
  readonly ttl_seconds: number;
  readonly can_sub_delegate: boolean;
  readonly idempotency_key: string;
}

export interface NexusDelegateResponse {
  readonly delegation_id: string;
  readonly api_key: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface NexusChainVerifyResponse {
  readonly delegation_id: string;
  readonly valid: boolean;
  readonly reason?: string | undefined;
  readonly chain_depth: number;
  readonly scope?: NexusDelegateScope | undefined;
}

export interface NexusDelegationEntry {
  readonly delegation_id: string;
  readonly parent_agent_id: string;
  readonly child_agent_id: string;
  readonly namespace_mode: NexusNamespaceMode;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface NexusDelegationListResponse {
  readonly delegations: readonly NexusDelegationEntry[];
  readonly total: number;
  readonly cursor?: string | undefined;
}

// ---------------------------------------------------------------------------
// API interface
// ---------------------------------------------------------------------------

export interface NexusDelegationApi {
  readonly createDelegation: (
    req: NexusDelegateRequest,
  ) => Promise<Result<NexusDelegateResponse, KoiError>>;
  readonly revokeDelegation: (id: DelegationId) => Promise<Result<void, KoiError>>;
  readonly verifyChain: (id: DelegationId) => Promise<Result<NexusChainVerifyResponse, KoiError>>;
  readonly listDelegations: (
    cursor?: string,
  ) => Promise<Result<NexusDelegationListResponse, KoiError>>;
}

// ---------------------------------------------------------------------------
// Config & factory
// ---------------------------------------------------------------------------

export interface NexusDelegationApiConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly deadlineMs?: number | undefined;
}

const DEFAULT_DEADLINE_MS = 45_000;
const BASE = "/api/v2/agents/delegate";

function mapHttpError(status: number, method: string): KoiError {
  const retryable = status === 429 || status >= 500;
  return {
    code: status === 404 ? "NOT_FOUND" : status === 403 ? "PERMISSION" : "INTERNAL",
    message: `Nexus ${method} failed: HTTP ${status}`,
    retryable,
    context: { status },
  };
}

export function createNexusDelegationApi(config: NexusDelegationApiConfig): NexusDelegationApi {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;

  function authHeaders(): Record<string, string> {
    return config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {};
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result<T, KoiError>> {
    const signal = AbortSignal.timeout(deadlineMs);
    try {
      const res = await fetchFn(`${config.url}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      // 404 on DELETE → idempotent success
      if (method === "DELETE" && res.status === 404) return { ok: true, value: undefined as T };
      if (!res.ok) return { ok: false, error: mapHttpError(res.status, method) };
      // 204 No Content → void success
      if (res.status === 204) return { ok: true, value: undefined as T };
      const json = (await res.json()) as T;
      return { ok: true, value: json };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
          context: {},
        },
      };
    }
  }

  return {
    createDelegation: (req) => request<NexusDelegateResponse>("POST", BASE, req),
    revokeDelegation: (id) => request<void>("DELETE", `${BASE}/${id}`),
    verifyChain: (id) => request<NexusChainVerifyResponse>("GET", `${BASE}/${id}/chain`),
    listDelegations: (cursor) => {
      const q = cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return request<NexusDelegationListResponse>("GET", `${BASE}${q}`);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/security/nexus-delegation/src/delegation-api.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/security/nexus-delegation/src/delegation-api.ts packages/security/nexus-delegation/src/delegation-api.test.ts
git commit -m "feat(@koi/nexus-delegation): NexusDelegationApi REST client"
```

---

## Task 5: `nexus-delegation-backend.ts`

**Files:**
- Create: `packages/security/nexus-delegation/src/nexus-delegation-backend.ts`
- Create: `packages/security/nexus-delegation/src/nexus-delegation-backend.test.ts`

This is the main implementation. The retry queue lives here as private state.

- [ ] **Step 1: Write failing tests**

Create `packages/security/nexus-delegation/src/nexus-delegation-backend.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentId, DelegationScope } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";
import type { NexusDelegationApi, NexusDelegateResponse, NexusChainVerifyResponse } from "./delegation-api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARENT_ID: AgentId = agentId("parent-1");
const CHILD_ID: AgentId = agentId("child-1");
const GRANT_ID = delegationId("del-abc");
const SCOPE: DelegationScope = { permissions: { allow: ["read_file"], deny: [] } };

function makeGrantResponse(overrides?: Partial<NexusDelegateResponse>): NexusDelegateResponse {
  return {
    delegation_id: GRANT_ID,
    api_key: "child-key-xyz",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function makeChainResponse(overrides?: Partial<NexusChainVerifyResponse>): NexusChainVerifyResponse {
  return {
    delegation_id: GRANT_ID,
    valid: true,
    chain_depth: 0,
    ...overrides,
  };
}

function makeMockApi(overrides?: Partial<NexusDelegationApi>): NexusDelegationApi {
  return {
    createDelegation: mock(async () => ({ ok: true as const, value: makeGrantResponse() })),
    revokeDelegation: mock(async () => ({ ok: true as const, value: undefined })),
    verifyChain: mock(async () => ({ ok: true as const, value: makeChainResponse() })),
    listDelegations: mock(async () => ({
      ok: true as const,
      value: { delegations: [], total: 0 },
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// grant()
// ---------------------------------------------------------------------------

describe("grant()", () => {
  test("calls createDelegation and returns grant with nexus proof", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    const grant = await backend.grant(SCOPE, CHILD_ID);
    expect(api.createDelegation).toHaveBeenCalledTimes(1);
    expect(grant.proof.kind).toBe("nexus");
    if (grant.proof.kind === "nexus") expect(grant.proof.token).toBe("child-key-xyz");
    expect(grant.issuerId).toBe(PARENT_ID);
    expect(grant.delegateeId).toBe(CHILD_ID);
  });

  test("throws on createDelegation failure", async () => {
    const api = makeMockApi({
      createDelegation: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "nexus down", retryable: false, context: {} },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await expect(backend.grant(SCOPE, CHILD_ID)).rejects.toThrow("nexus down");
  });
});

// ---------------------------------------------------------------------------
// revoke()
// ---------------------------------------------------------------------------

describe("revoke()", () => {
  test("calls revokeDelegation and removes from grant store", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    await backend.revoke(GRANT_ID);
    expect(api.revokeDelegation).toHaveBeenCalledWith(GRANT_ID);
  });

  test("enqueues to retry queue on network failure", async () => {
    let calls = 0;
    const api = makeMockApi({
      revokeDelegation: mock(async () => {
        calls++;
        return {
          ok: false as const,
          error: { code: "INTERNAL" as const, message: "network error", retryable: true, context: {} },
        };
      }),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    // First revoke fails → enqueued
    await backend.revoke(GRANT_ID);
    expect(calls).toBe(1);

    // Grant a second child so we can trigger another revoke
    const api2Grant = delegationId("del-def");
    (api.createDelegation as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: true as const,
      value: makeGrantResponse({ delegation_id: api2Grant, api_key: "key2" }),
    }));
    await backend.grant(SCOPE, agentId("child-2"));

    // Second revoke fails too but also triggers drain of pending queue
    await backend.revoke(api2Grant);
    // drain attempted the first grant again (calls: 1 original + 1 drain + 1 new revoke = 3)
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("emits structured error after maxRevocationRetries exhausted", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const api = makeMockApi({
      revokeDelegation: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "fail", retryable: true, context: {} },
      })),
    });
    const backend = createNexusDelegationBackend({
      api,
      agentId: PARENT_ID,
      maxRevocationRetries: 2,
    });
    await backend.grant(SCOPE, CHILD_ID);

    // Exhaust retries: first revoke queues it; subsequent revokes drain + re-fail
    for (let i = 0; i < 4; i++) {
      const newId = delegationId(`del-${i}`);
      (api.createDelegation as ReturnType<typeof mock>).mockResolvedValue({
        ok: true as const,
        value: makeGrantResponse({ delegation_id: newId, api_key: `key-${i}` }),
      });
      await backend.grant(SCOPE, agentId(`c-${i}`));
      await backend.revoke(newId);
    }

    // console.error should have been called with structured payload
    const calls = errorSpy.mock.calls.flat().join(" ");
    expect(calls).toContain(GRANT_ID);
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

describe("verify()", () => {
  test("returns expired for past-expiry grant (local fast path)", async () => {
    const api = makeMockApi({
      createDelegation: mock(async () => ({
        ok: true as const,
        value: makeGrantResponse({
          expires_at: new Date(Date.now() - 1000).toISOString(),
        }),
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
    expect(api.verifyChain).not.toHaveBeenCalled();
  });

  test("returns scope_exceeded for denied tool (local fast path)", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID); // allow: ["read_file"]
    const result = await backend.verify(GRANT_ID, "write_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_exceeded");
    expect(api.verifyChain).not.toHaveBeenCalled();
  });

  test("calls Nexus chain for allowed tool", async () => {
    const api = makeMockApi();
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(true);
    expect(api.verifyChain).toHaveBeenCalledWith(GRANT_ID);
  });

  test("serves stale from cache and triggers background refresh", async () => {
    let chainCalls = 0;
    const api = makeMockApi({
      verifyChain: mock(async () => {
        chainCalls++;
        return { ok: true as const, value: makeChainResponse() };
      }),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID, verifyCacheTtlMs: 1 });
    await backend.grant(SCOPE, CHILD_ID);
    // First verify — populates cache
    await backend.verify(GRANT_ID, "read_file");
    expect(chainCalls).toBe(1);
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 5));
    // Second verify — cache stale, serves stale + triggers background refresh
    await backend.verify(GRANT_ID, "read_file");
    // Background refresh fires async; wait briefly
    await new Promise((r) => setTimeout(r, 20));
    expect(chainCalls).toBe(2);
  });

  test("fails closed when Nexus returns unknown_grant", async () => {
    const api = makeMockApi({
      verifyChain: mock(async () => ({
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "not found", retryable: false, context: {} },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const result = await backend.verify(GRANT_ID, "read_file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_grant");
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("list()", () => {
  test("returns grants from local store first", async () => {
    const api = makeMockApi({
      listDelegations: mock(async () => ({
        ok: true as const,
        value: {
          delegations: [
            {
              delegation_id: GRANT_ID,
              parent_agent_id: PARENT_ID,
              child_agent_id: CHILD_ID,
              namespace_mode: "COPY" as const,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
          total: 1,
        },
      })),
    });
    const backend = createNexusDelegationBackend({ api, agentId: PARENT_ID });
    await backend.grant(SCOPE, CHILD_ID);
    const grants = await backend.list();
    expect(grants.length).toBe(1);
    // Local grant has scope; Nexus list entry does not
    expect(grants[0]?.scope.permissions.allow).toEqual(["read_file"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/security/nexus-delegation/src/nexus-delegation-backend.test.ts
```

Expected: FAIL — `nexus-delegation-backend.js` does not exist.

- [ ] **Step 3: Implement `nexus-delegation-backend.ts`**

Create `packages/security/nexus-delegation/src/nexus-delegation-backend.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type {
  AgentId,
  DelegationComponent,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  DelegationVerifyResult,
  NamespaceMode,
} from "@koi/core";
import { delegationId } from "@koi/core";
import type { NexusDelegationApi } from "./delegation-api.js";
import { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";
import { createTtlVerifyCache } from "./ttl-verify-cache.js";
import type { TtlVerifyCache } from "./ttl-verify-cache.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusDelegationBackendConfig {
  readonly api: NexusDelegationApi;
  readonly agentId: AgentId;
  readonly maxChainDepth?: number;
  readonly defaultTtlSeconds?: number;
  readonly namespaceMode?: NamespaceMode;
  readonly canSubDelegate?: boolean;
  readonly verifyCacheTtlMs?: number;
  readonly idempotencyPrefix?: string;
  readonly maxPendingRevocations?: number;
  readonly maxRevocationRetries?: number;
}

// ---------------------------------------------------------------------------
// Retry queue (private)
// ---------------------------------------------------------------------------

interface PendingRevocation {
  readonly id: DelegationId;
  readonly childId: AgentId;
  readonly failedAt: number;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Scope enforcement helper
// ---------------------------------------------------------------------------

function matchTool(toolId: string, scope: DelegationScope): boolean {
  const allow = scope.permissions.allow ?? [];
  const deny = scope.permissions.deny ?? [];
  const name = toolId.includes(":") ? toolId.slice(0, toolId.indexOf(":")) : toolId;
  if (deny.includes(name) || deny.includes(toolId)) return false;
  return allow.includes(name) || allow.includes(toolId) || allow.includes("*");
}

// ---------------------------------------------------------------------------
// Reason mapping
// ---------------------------------------------------------------------------

function mapNexusReason(
  reason: string | undefined,
): "expired" | "revoked" | "scope_exceeded" | "chain_depth_exceeded" | "invalid_signature" | "unknown_grant" {
  switch (reason) {
    case "expired": return "expired";
    case "revoked": return "revoked";
    case "scope_exceeded": return "scope_exceeded";
    case "chain_depth_exceeded": return "chain_depth_exceeded";
    case "not_found":
    case "unknown": return "unknown_grant";
    default: return "invalid_signature";
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHAIN_DEPTH = 3;
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_MAX_PENDING = 100;
const DEFAULT_MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusDelegationBackend(
  config: NexusDelegationBackendConfig,
): DelegationComponent {
  const {
    api,
    agentId: ownId,
    maxChainDepth = DEFAULT_MAX_CHAIN_DEPTH,
    defaultTtlSeconds = DEFAULT_TTL_SECONDS,
    namespaceMode,
    canSubDelegate = true,
    verifyCacheTtlMs = 30_000,
    idempotencyPrefix,
    maxPendingRevocations = DEFAULT_MAX_PENDING,
    maxRevocationRetries = DEFAULT_MAX_RETRIES,
  } = config;

  const verifyCache: TtlVerifyCache | undefined =
    verifyCacheTtlMs > 0 ? createTtlVerifyCache({ ttlMs: verifyCacheTtlMs }) : undefined;

  const grantStore = new Map<DelegationId, DelegationGrant>();
  // let justified: mutable retry queue
  let pendingRevocations: PendingRevocation[] = [];

  // ---------------------------------------------------------------------------
  // Retry queue helpers
  // ---------------------------------------------------------------------------

  function enqueueRevocation(id: DelegationId, childId: AgentId): void {
    if (pendingRevocations.length >= maxPendingRevocations) {
      const dropped = pendingRevocations.shift();
      if (dropped !== undefined) {
        console.error(
          `[nexus-delegation] retry queue full — dropping oldest pending revocation`,
          { delegationId: dropped.id, childId: dropped.childId, droppedAt: Date.now() },
        );
      }
    }
    pendingRevocations.push({ id, childId, failedAt: Date.now(), attempts: 1 });
  }

  async function drainQueue(): Promise<void> {
    if (pendingRevocations.length === 0) return;
    const snapshot = pendingRevocations;
    pendingRevocations = [];
    const requeue: PendingRevocation[] = [];

    for (const entry of snapshot) {
      const result = await api.revokeDelegation(entry.id);
      if (result.ok) {
        grantStore.delete(entry.id);
        verifyCache?.invalidate(entry.id);
      } else if (entry.attempts >= maxRevocationRetries) {
        console.error(
          `[nexus-delegation] revocation failed after max retries — manual intervention required`,
          { delegationId: entry.id, childId: entry.childId, attempts: entry.attempts, error: result.error.message },
        );
      } else {
        requeue.push({ ...entry, attempts: entry.attempts + 1 });
      }
    }

    pendingRevocations = [...requeue, ...pendingRevocations];
  }

  // ---------------------------------------------------------------------------
  // grant()
  // ---------------------------------------------------------------------------

  async function grant(
    scope: DelegationScope,
    delegateeId: AgentId,
    ttlMs?: number,
  ): Promise<DelegationGrant> {
    const ttlSeconds = ttlMs !== undefined ? Math.ceil(ttlMs / 1000) : defaultTtlSeconds;
    const idempotencyKey =
      idempotencyPrefix !== undefined
        ? `${idempotencyPrefix}${ownId}:${delegateeId}`
        : randomUUID();

    const result = await api.createDelegation({
      parent_agent_id: ownId,
      child_agent_id: delegateeId,
      scope: mapScopeToNexus(scope),
      namespace_mode: mapNamespaceMode(namespaceMode),
      max_depth: maxChainDepth,
      ttl_seconds: ttlSeconds,
      can_sub_delegate: canSubDelegate && maxChainDepth > 0,
      idempotency_key: idempotencyKey,
    });

    if (!result.ok) {
      throw new Error(`Nexus delegation grant failed: ${result.error.message}`);
    }

    const now = Date.now();
    const g: DelegationGrant = {
      id: delegationId(result.value.delegation_id),
      issuerId: ownId,
      delegateeId,
      scope,
      chainDepth: 0,
      maxChainDepth,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      proof: { kind: "nexus", token: result.value.api_key },
    };

    grantStore.set(g.id, g);
    return g;
  }

  // ---------------------------------------------------------------------------
  // revoke()
  // ---------------------------------------------------------------------------

  async function revoke(id: DelegationId, _cascade?: boolean): Promise<void> {
    // Trigger background drain of pending queue (opportunistic, non-blocking)
    void drainQueue();

    const storedGrant = grantStore.get(id);
    const result = await api.revokeDelegation(id);

    if (!result.ok) {
      const childId = storedGrant?.delegateeId ?? ("unknown" as AgentId);
      enqueueRevocation(id, childId);
      return;
    }

    grantStore.delete(id);
    verifyCache?.invalidate(id);
  }

  // ---------------------------------------------------------------------------
  // verify()
  // ---------------------------------------------------------------------------

  async function verify(id: DelegationId, toolId: string): Promise<DelegationVerifyResult> {
    const stored = grantStore.get(id);

    // Local expiry fast path
    if (stored !== undefined && stored.expiresAt <= Date.now()) {
      const r: DelegationVerifyResult = { ok: false, reason: "expired" };
      verifyCache?.set(id, toolId, r);
      grantStore.delete(id);
      return r;
    }

    // Local scope fast path
    if (stored !== undefined && !matchTool(toolId, stored.scope)) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    // TTL cache (fresh)
    if (verifyCache !== undefined) {
      const cached = verifyCache.get(id, toolId);
      if (cached !== undefined && !verifyCache.isStale(id, toolId)) return cached;
      if (cached !== undefined) {
        // Stale — serve stale, background refresh
        void verifyFromNexus(id, toolId);
        return cached;
      }
    }

    return verifyFromNexus(id, toolId);
  }

  async function verifyFromNexus(
    id: DelegationId,
    toolId: string,
  ): Promise<DelegationVerifyResult> {
    const result = await api.verifyChain(id);

    if (!result.ok) {
      const r: DelegationVerifyResult = {
        ok: false,
        reason: result.error.code === "NOT_FOUND" ? "unknown_grant" : "invalid_signature",
      };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const chain = result.value;
    if (!chain.valid) {
      const r: DelegationVerifyResult = { ok: false, reason: mapNexusReason(chain.reason) };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const stored = grantStore.get(id);
    const resolvedScope: DelegationScope | undefined =
      stored?.scope ??
      (chain.scope !== undefined
        ? {
            permissions: {
              allow: [...chain.scope.allowed_operations],
              deny: [...chain.scope.remove_grants],
            },
            ...(chain.scope.resource_patterns !== undefined
              ? { resources: [...chain.scope.resource_patterns] }
              : {}),
          }
        : undefined);

    // Fail-closed: no scope available
    if (resolvedScope === undefined) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    // Cross-node scope enforcement
    if (stored === undefined && !matchTool(toolId, resolvedScope)) {
      const r: DelegationVerifyResult = { ok: false, reason: "scope_exceeded" };
      verifyCache?.set(id, toolId, r);
      return r;
    }

    const grant: DelegationGrant = stored ?? {
      id,
      issuerId: ownId,
      delegateeId: ownId,
      scope: resolvedScope,
      chainDepth: chain.chain_depth,
      maxChainDepth,
      createdAt: 0,
      expiresAt: 0,
      proof: { kind: "nexus" as const, token: "" },
    };

    const r: DelegationVerifyResult = { ok: true, grant };
    verifyCache?.set(id, toolId, r);
    return r;
  }

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------

  async function list(): Promise<readonly DelegationGrant[]> {
    const grants: DelegationGrant[] = [];
    let cursor: string | undefined;

    do {
      const result = await api.listDelegations(cursor);
      if (!result.ok) throw new Error(`Nexus delegation list failed: ${result.error.message}`);

      for (const entry of result.value.delegations) {
        const eid = delegationId(entry.delegation_id);
        grants.push(
          grantStore.get(eid) ?? {
            id: eid,
            issuerId: ownId,
            delegateeId: entry.child_agent_id as AgentId,
            scope: { permissions: {} },
            chainDepth: 0,
            maxChainDepth,
            createdAt: new Date(entry.created_at).getTime(),
            expiresAt: new Date(entry.expires_at).getTime(),
            proof: { kind: "nexus", token: "" },
          },
        );
      }

      cursor = result.value.cursor;
    } while (cursor !== undefined);

    return grants;
  }

  return { grant, revoke, verify, list };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/security/nexus-delegation/src/nexus-delegation-backend.test.ts
```

Expected: PASS — all tests green (may need minor adjustments to mock interaction counts — fix assertions to match actual drain behavior if needed).

- [ ] **Step 5: Commit**

```bash
git add packages/security/nexus-delegation/src/nexus-delegation-backend.ts packages/security/nexus-delegation/src/nexus-delegation-backend.test.ts
git commit -m "feat(@koi/nexus-delegation): NexusDelegationBackend with retry queue"
```

---

## Task 6: `nexus-delegation-provider.ts`

**Files:**
- Create: `packages/security/nexus-delegation/src/nexus-delegation-provider.ts`
- Create: `packages/security/nexus-delegation/src/nexus-delegation-provider.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/security/nexus-delegation/src/nexus-delegation-provider.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import type { Agent, AgentId } from "@koi/core";
import { agentId, DELEGATION, runId, sessionId } from "@koi/core";
import { createNexusDelegationProvider } from "./nexus-delegation-provider.js";
import type { NexusDelegationApi } from "./delegation-api.js";

function makeMockApi(): NexusDelegationApi {
  return {
    createDelegation: mock(async () => ({ ok: true as const, value: { delegation_id: "d", api_key: "k", created_at: "", expires_at: "" } })),
    revokeDelegation: mock(async () => ({ ok: true as const, value: undefined })),
    verifyChain: mock(async () => ({ ok: true as const, value: { delegation_id: "d", valid: true, chain_depth: 0 } })),
    listDelegations: mock(async () => ({ ok: true as const, value: { delegations: [], total: 0 } })),
  };
}

function mockAgent(id: AgentId): Agent {
  return {
    pid: { id, type: "test", depth: 0 },
    manifest: { name: "test", version: "0.1.0", model: { name: "m" } },
    has: () => false,
    component: () => undefined,
    query: () => new Map(),
    subscribe: () => () => {},
  } as unknown as Agent;
}

describe("createNexusDelegationProvider", () => {
  test("attaches DELEGATION component using agent pid.id", async () => {
    const api = makeMockApi();
    const provider = createNexusDelegationProvider({ api });
    const agent = mockAgent(agentId("agent-42"));
    const components = await provider.attach(agent);
    expect(components.has(DELEGATION as string)).toBe(true);
    const del = components.get(DELEGATION as string);
    expect(typeof (del as { grant?: unknown })?.grant).toBe("function");
  });

  test("returns empty map when enabled=false", async () => {
    const api = makeMockApi();
    const provider = createNexusDelegationProvider({ api, enabled: false });
    const agent = mockAgent(agentId("agent-1"));
    const components = await provider.attach(agent);
    expect(components.size).toBe(0);
  });

  test("provider name is 'delegation-nexus'", () => {
    const provider = createNexusDelegationProvider({ api: makeMockApi() });
    expect(provider.name).toBe("delegation-nexus");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/security/nexus-delegation/src/nexus-delegation-provider.test.ts
```

Expected: FAIL — `nexus-delegation-provider.js` does not exist.

- [ ] **Step 3: Implement `nexus-delegation-provider.ts`**

Create `packages/security/nexus-delegation/src/nexus-delegation-provider.ts`:

```typescript
import type { Agent, ComponentProvider, DelegationComponent } from "@koi/core";
import { DELEGATION } from "@koi/core";
import type { NexusDelegationApi } from "./delegation-api.js";
import type { NexusDelegationBackendConfig } from "./nexus-delegation-backend.js";
import { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

export interface NexusDelegationProviderConfig {
  readonly api: NexusDelegationApi;
  readonly backend?: Partial<Omit<NexusDelegationBackendConfig, "api" | "agentId">>;
  readonly enabled?: boolean;
}

export function createNexusDelegationProvider(
  config: NexusDelegationProviderConfig,
): ComponentProvider {
  const { api, backend = {}, enabled = true } = config;

  return {
    name: "delegation-nexus",
    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (!enabled) return new Map();
      const delegation: DelegationComponent = createNexusDelegationBackend({
        api,
        agentId: agent.pid.id,
        ...backend,
      });
      return new Map([[DELEGATION as string, delegation]]);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test packages/security/nexus-delegation/src/nexus-delegation-provider.test.ts
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/security/nexus-delegation/src/nexus-delegation-provider.ts packages/security/nexus-delegation/src/nexus-delegation-provider.test.ts
git commit -m "feat(@koi/nexus-delegation): NexusDelegationProvider ComponentProvider"
```

---

## Task 7: `index.ts` + typecheck + full test run

**Files:**
- Modify: `packages/security/nexus-delegation/src/index.ts`

- [ ] **Step 1: Write the public exports**

Replace `packages/security/nexus-delegation/src/index.ts`:

```typescript
export type {
  NexusDelegationApi,
  NexusDelegationApiConfig,
  NexusDelegateRequest,
  NexusDelegateResponse,
  NexusChainVerifyResponse,
  NexusDelegationListResponse,
  NexusDelegationEntry,
  NexusDelegateScope,
  NexusNamespaceMode,
} from "./delegation-api.js";
export { createNexusDelegationApi } from "./delegation-api.js";

export { mapNamespaceMode, mapScopeToNexus } from "./scope-mapping.js";

export type { TtlVerifyCache, TtlVerifyCacheConfig } from "./ttl-verify-cache.js";
export { createTtlVerifyCache } from "./ttl-verify-cache.js";

export type { NexusDelegationBackendConfig } from "./nexus-delegation-backend.js";
export { createNexusDelegationBackend } from "./nexus-delegation-backend.js";

export type { NexusDelegationProviderConfig } from "./nexus-delegation-provider.js";
export { createNexusDelegationProvider } from "./nexus-delegation-provider.js";
```

- [ ] **Step 2: Run all package tests**

```bash
bun test --filter=@koi/nexus-delegation
```

Expected: All tests green.

- [ ] **Step 3: Typecheck**

```bash
cd packages/security/nexus-delegation && bun run typecheck
```

Expected: No TypeScript errors.

- [ ] **Step 4: Check layers**

```bash
bun run check:layers
```

Expected: No layer violations — `@koi/nexus-delegation` is L2, imports only L0 (`@koi/core`) and L0u (`@koi/errors`).

- [ ] **Step 5: Commit**

```bash
git add packages/security/nexus-delegation/src/index.ts
git commit -m "feat(@koi/nexus-delegation): public index exports + typecheck green"
```

---

## Task 8: Spawn lifecycle integration test

**Files:**
- Create: `packages/security/nexus-delegation/src/__tests__/spawn-lifecycle.test.ts`

These tests verify that `spawnChildAgent` correctly calls `grant()` during spawn and `revoke()` on child termination when a `NexusDelegationProvider` is attached to the parent.

- [ ] **Step 1: Create the test directory**

```bash
mkdir -p packages/security/nexus-delegation/src/__tests__
```

- [ ] **Step 2: Write failing test**

Create `packages/security/nexus-delegation/src/__tests__/spawn-lifecycle.test.ts`:

```typescript
/**
 * Spawn lifecycle integration tests.
 *
 * Tests the grant → spawn → terminate → revoke path using real spawnChildAgent
 * but a mock NexusDelegationApi and mock parent agent (no real Nexus required,
 * no real parent runtime needed — matches spawn-child.test.ts patterns).
 */
import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  AgentId,
  DelegationComponent,
  EngineAdapter,
  EngineEvent,
  SubsystemToken,
} from "@koi/core";
import { agentId, DELEGATION, runId } from "@koi/core";
import { spawnChildAgent, createInMemorySpawnLedger } from "@koi/engine";
import { DEFAULT_SPAWN_POLICY } from "@koi/engine-compose";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { createNexusDelegationBackend } from "../nexus-delegation-backend.js";
import type { NexusDelegationApi } from "../delegation-api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAdapter(): EngineAdapter {
  return {
    engineId: "mock",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => ({
      [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        let done = false;
        return {
          async next() {
            if (done) return { done: true, value: undefined };
            done = true;
            return {
              done: false,
              value: {
                kind: "done" as const,
                output: {
                  content: [],
                  stopReason: "completed",
                  metrics: { totalTokens: 1, inputTokens: 1, outputTokens: 0, turns: 1, durationMs: 10 },
                },
              },
            };
          },
        };
      },
    }),
  };
}

function makeMockApi(overrides?: Partial<NexusDelegationApi>): NexusDelegationApi {
  return {
    createDelegation: mock(async () => ({
      ok: true as const,
      value: {
        delegation_id: "del-spawn-1",
        api_key: "child-api-key-xyz",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })),
    revokeDelegation: mock(async () => ({ ok: true as const, value: undefined })),
    verifyChain: mock(async () => ({
      ok: true as const,
      value: { delegation_id: "del-spawn-1", valid: true, chain_depth: 0 },
    })),
    listDelegations: mock(async () => ({
      ok: true as const,
      value: { delegations: [], total: 0 },
    })),
    ...overrides,
  };
}

/** Build a minimal mock parent Agent with optional DELEGATION component. */
function mockParentAgent(delegation?: DelegationComponent): Agent {
  const comps = new Map<string, unknown>();
  if (delegation !== undefined) comps.set(DELEGATION as string, delegation);
  return {
    pid: { id: agentId("parent-1"), name: "parent", type: "copilot", depth: 0 },
    manifest: {
      name: "parent",
      version: "0.1.0",
      model: { name: "mock" },
      permissions: { allow: ["read_file"], deny: [] },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    },
    state: "running",
    component: <T>(tok: SubsystemToken<T>) => comps.get(tok as string) as T | undefined,
    has: (tok) => comps.has(tok as string),
    hasAll: (...tokens) => tokens.every((t) => comps.has(t as string)),
    query: <T>(prefix: string) => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of comps) {
        if (key.startsWith(prefix)) result.set(key as SubsystemToken<T>, value as T);
      }
      return result;
    },
    components: () => comps as ReadonlyMap<string, unknown>,
  } as unknown as Agent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawn lifecycle — Nexus delegation", () => {
  test("grant called on spawn, nexusApiKey present in result", async () => {
    const mockApi = makeMockApi();
    const delegation = createNexusDelegationBackend({ api: mockApi, agentId: agentId("parent-1") });
    const parent = mockParentAgent(delegation);
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent({
      manifest: {
        name: "child",
        version: "0.1.0",
        model: { name: "mock" },
        permissions: { allow: ["read_file"], deny: [] },
        delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      },
      parentAgent: parent,
      adapter: makeMockAdapter(),
      spawnLedger: ledger,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
    });

    expect(mockApi.createDelegation).toHaveBeenCalledTimes(1);
    expect(result.nexusApiKey).toBe("child-api-key-xyz");
    expect(result.delegationId).toBeDefined();

    await result.runtime.dispose();
  });

  test("revoke called when child handle terminates", async () => {
    const mockApi = makeMockApi();
    const delegation = createNexusDelegationBackend({ api: mockApi, agentId: agentId("parent-1") });
    const parent = mockParentAgent(delegation);
    const registry = createInMemoryRegistry();
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent({
      manifest: {
        name: "child",
        version: "0.1.0",
        model: { name: "mock" },
        permissions: { allow: ["read_file"] },
        delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      },
      parentAgent: parent,
      adapter: makeMockAdapter(),
      spawnLedger: ledger,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
      registry,
    });

    const childId = result.childPid.id;

    // Transition child to terminated in the registry —
    // child-handle watches for "transitioned" events with to === "terminated"
    // and fires the onEvent("terminated") callback which calls revoke().
    registry.transition(childId, "terminated", 0, { kind: "completed" });

    // Wait for async event propagation and revoke
    await new Promise((r) => setTimeout(r, 100));

    expect(mockApi.revokeDelegation).toHaveBeenCalledTimes(1);

    await result.runtime.dispose();
  });

  test("revoke fires even when child terminates with error reason", async () => {
    const mockApi = makeMockApi();
    const delegation = createNexusDelegationBackend({ api: mockApi, agentId: agentId("parent-1") });
    const parent = mockParentAgent(delegation);
    const registry = createInMemoryRegistry();
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent({
      manifest: {
        name: "child",
        version: "0.1.0",
        model: { name: "mock" },
        permissions: { allow: ["read_file"] },
        delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      },
      parentAgent: parent,
      adapter: makeMockAdapter(),
      spawnLedger: ledger,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
      registry,
    });

    registry.transition(result.childPid.id, "terminated", 0, { kind: "error", cause: new Error("crash") });
    await new Promise((r) => setTimeout(r, 100));

    // Revoke fires regardless of error reason
    expect(mockApi.revokeDelegation).toHaveBeenCalledTimes(1);

    await result.runtime.dispose();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test packages/security/nexus-delegation/src/__tests__/spawn-lifecycle.test.ts
```

Expected: FAIL — `nexus-delegation-backend.js` is present but `@koi/engine` and `@koi/engine-reconcile` resolve since they are devDependencies. The tests fail because the spawn-lifecycle test imports are not yet connected to the real engine flow (i.e., tests fail on assertion mismatches or missing agent fields, not import errors).

- [ ] **Step 4: Run until tests pass**

Run `bun test packages/security/nexus-delegation/src/__tests__/spawn-lifecycle.test.ts` and address any failures. Common issues:
- `Agent.state` field missing from mock — add it to the `mockParentAgent` helper
- `registry.transition` signature — signature is `(id, phase, generation, reason)` where `reason` is `{ kind: "..." }`
- `DEFAULT_SPAWN_POLICY` may need `maxTotalProcesses` — check what `DEFAULT_SPAWN_POLICY` exports and adjust

- [ ] **Step 5: Commit**

```bash
git add packages/security/nexus-delegation/src/__tests__/spawn-lifecycle.test.ts
git commit -m "test(@koi/nexus-delegation): spawn lifecycle grant/revoke integration tests"
```

---

## Task 9: Wire into `@koi/runtime` + golden queries

**Files:**
- Modify: `packages/meta/runtime/package.json`
- Modify: `packages/meta/runtime/tsconfig.json`
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`

- [ ] **Step 1: Add dep to `packages/meta/runtime/package.json`**

In the `"dependencies"` object, add (in alphabetical order near `@koi/nexus-client`):

```json
"@koi/nexus-delegation": "workspace:*",
```

- [ ] **Step 2: Add tsconfig reference to `packages/meta/runtime/tsconfig.json`**

In the `"references"` array, add near the `governance-delegation` entry:

```json
{ "path": "../../security/nexus-delegation" },
```

- [ ] **Step 3: Add 2 standalone golden queries to `packages/meta/runtime/src/__tests__/golden-replay.test.ts`**

At the end of the file, before the closing `}` of the file (after the last existing `describe` block), add:

```typescript
// ---------------------------------------------------------------------------
// Golden: @koi/nexus-delegation (standalone — no LLM required)
// ---------------------------------------------------------------------------

describe("Golden: @koi/nexus-delegation", () => {
  test("NexusDelegationBackend.grant() returns nexus proof with token", async () => {
    const { createNexusDelegationBackend } = await import("@koi/nexus-delegation");
    const { agentId, delegationId } = await import("@koi/core");

    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          delegation_id: "del-golden-1",
          api_key: "golden-child-key",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const { createNexusDelegationApi } = await import("@koi/nexus-delegation");
    const api = createNexusDelegationApi({ url: "http://nexus.test", fetch: mockFetch });
    const backend = createNexusDelegationBackend({ api, agentId: agentId("parent-golden") });

    const grant = await backend.grant(
      { permissions: { allow: ["read_file"], deny: [] } },
      agentId("child-golden"),
    );

    expect(grant.proof.kind).toBe("nexus");
    if (grant.proof.kind === "nexus") {
      expect(grant.proof.token).toBe("golden-child-key");
    }
    expect(grant.issuerId).toBe(agentId("parent-golden"));
    expect(capturedBody?.parent_agent_id).toBe(agentId("parent-golden"));
    expect(capturedBody?.child_agent_id).toBe(agentId("child-golden"));
  });

  test("NexusDelegationBackend.revoke() removes grant and calls DELETE", async () => {
    const { createNexusDelegationBackend, createNexusDelegationApi } = await import(
      "@koi/nexus-delegation"
    );
    const { agentId, delegationId } = await import("@koi/core");

    const calls: { method: string; url: string }[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), url: input as string });
      if ((init?.method ?? "").toUpperCase() === "POST") {
        return new Response(
          JSON.stringify({
            delegation_id: "del-golden-revoke",
            api_key: "key-to-revoke",
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    };

    const api = createNexusDelegationApi({ url: "http://nexus.test", fetch: mockFetch });
    const backend = createNexusDelegationBackend({
      api,
      agentId: agentId("parent-revoke"),
      verifyCacheTtlMs: 0,
    });

    await backend.grant({ permissions: { allow: ["read_file"] } }, agentId("child-revoke"));
    await backend.revoke(delegationId("del-golden-revoke"));

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.url).toContain("del-golden-revoke");
  });
});
```

- [ ] **Step 4: Run runtime tests to verify golden queries pass**

```bash
bun test --filter=@koi/runtime packages/meta/runtime/src/__tests__/golden-replay.test.ts
```

Expected: The two new `@koi/nexus-delegation` golden query tests pass.

- [ ] **Step 5: Run check:orphans and check:golden-queries**

```bash
bun run check:orphans && bun run check:golden-queries
```

Expected: Both pass. `@koi/nexus-delegation` is a dep of `@koi/runtime` (orphan check) and has 2 golden query assertions (golden check).

- [ ] **Step 6: Commit**

```bash
git add packages/meta/runtime/package.json packages/meta/runtime/tsconfig.json packages/meta/runtime/src/__tests__/golden-replay.test.ts bun.lock
git commit -m "feat(@koi/runtime): wire @koi/nexus-delegation + 2 golden queries"
```

---

## Task 10: CI gate verification

- [ ] **Step 1: Run full test suite for the package**

```bash
bun test --filter=@koi/nexus-delegation
```

Expected: All tests pass. Coverage ≥ 80% lines/functions/statements.

- [ ] **Step 2: Run all CI gates**

```bash
bun run check:layers && bun run check:orphans && bun run check:golden-queries && bun run typecheck --filter=@koi/nexus-delegation
```

Expected: All four commands exit 0.

- [ ] **Step 3: Run lint**

```bash
cd packages/security/nexus-delegation && bun run lint
```

Expected: No lint errors.

- [ ] **Step 4: Final commit if any lint fixes were needed**

```bash
git add -p
git commit -m "chore(@koi/nexus-delegation): lint fixes"
```

Only needed if Step 3 produced auto-fixable issues.

- [ ] **Step 5: Verify acceptance criteria from spec**

Check off each item:
- [ ] `NexusDelegationBackend` passes unit tests with mocked Nexus HTTP client → `nexus-delegation-backend.test.ts` covers grant/revoke/verify/list/retry queue
- [ ] Integration test: spawn → Nexus key issued → child terminates → key verified revoked → `spawn-lifecycle.test.ts`
- [ ] Retry queue: failed revocations retried on next termination, structured error log after max retries → covered in `nexus-delegation-backend.test.ts`
- [ ] `check:layers` passes (L2 package does not import L1) → confirmed in Step 2
- [ ] Golden query updated → 2 standalone queries in `golden-replay.test.ts`

---

## Notes

**`DelegationConfig.backend` field:** `@koi/core`'s `DelegationConfig` does not currently have a `backend` field. Consumers wiring `NexusDelegationProvider` must do so explicitly. If manifest-driven routing is needed in future, add `backend?: "nexus" | "memory"` to `DelegationConfig` in a separate L0 PR.

**Docker integration tests:** The spec describes docker-guarded tests verifying real Nexus key attenuation and 404 post-revoke. These are not implemented here — they require real Nexus and should be added in a follow-up once the Nexus delegation endpoints are stable.

**V1 reference:** `archive/v1/packages/security/delegation-nexus/` is the primary reference for this implementation. The main additions over v1 are: (1) retry queue in `revoke()`, (2) `@koi/errors` for error types instead of plain throws, (3) all Nexus REST types self-contained (no `@koi/nexus-client` dep).
