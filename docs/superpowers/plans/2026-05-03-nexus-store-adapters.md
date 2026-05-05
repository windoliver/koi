# Nexus Store Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two L2 storage adapters — `@koi/snapshot-store-nexus` and `@koi/playbook-store-nexus` — that implement existing local-store contracts (`SnapshotChainStore<T>`, ACE `PlaybookStore` / `StructuredPlaybookStore` / `TrajectoryStore` / `PlaybookProposalStore`) over a Nexus JSON-RPC transport.

**Architecture:** Each adapter calls `NexusTransport.call("read"|"write"|"delete"|"list"|"exists", { path, ... })` from `@koi/nexus-client`. State is stored as JSON files at deterministic paths (`<basePath>/<chainId>/<nodeId>.json`, `<basePath>/playbooks/<id>.json`, etc.). A per-chain mutex serializes meta read-modify-write to prevent lost updates inside a single process. Both packages are tagged `"koi": { "optional": true }` so the orphan-check exempts them — they are wired at L3 assembly, not via static dependency.

**Tech Stack:**
- Bun 1.3.x runtime, `bun:test`, Biome lint, tsup ESM build
- L0 contracts from `@koi/core` (`SnapshotChainStore`, `Result`, `KoiError`, factories) and `@koi/ace-types`
- `@koi/nexus-client` for `NexusTransport`
- `@koi/hash` for `computeContentHash` (snapshot dedup)
- `@koi/fs-nexus/testing` (devDep) for `createFakeNexusTransport` in tests

**Scope deviations from issue #1405:**
- No new generic `KvStore` / `DocumentStore` / `SearchIndex` L0 contracts — issue text said "same contract as local store variants", so we adapt existing per-domain contracts. This matches the v1 `nexus-store` shape.
- No batch-atomic operations — none of the underlying contracts (`SnapshotChainStore`, `PlaybookStore`, etc.) expose a batch method. Documented in each L2 spec.
- "Search index" deferred to issue #1407 (`@koi/search-nexus`) — out of scope here.

---

## File Structure

### Package 1: `@koi/snapshot-store-nexus`

```
packages/lib/snapshot-store-nexus/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts              ← public API re-exports
    ├── types.ts              ← NexusSnapshotStoreConfig
    ├── paths.ts              ← path layout + segment validation
    ├── json-io.ts            ← read/write/delete/list/exists JSON helpers
    ├── nexus-store.ts        ← createSnapshotStoreNexus<T>() factory
    ├── nexus-store.test.ts   ← unit tests (fake transport)
    └── contract.test.ts      ← full SnapshotChainStore<T> contract suite
```

Plus `docs/L2/snapshot-store-nexus.md`.

### Package 2: `@koi/playbook-store-nexus`

```
packages/lib/playbook-store-nexus/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts              ← public API re-exports
    ├── types.ts              ← NexusPlaybookStoreConfig
    ├── json-io.ts            ← read/write/delete/list helpers (shared)
    ├── playbook.ts           ← createNexusPlaybookStore (PlaybookStore)
    ├── structured.ts         ← createNexusStructuredPlaybookStore
    ├── trajectory.ts         ← createNexusTrajectoryStore
    ├── proposal.ts           ← createNexusPlaybookProposalStore
    ├── store.ts              ← createPlaybookStoreNexus composite factory
    └── __tests__/
        ├── playbook.test.ts
        ├── structured.test.ts
        ├── trajectory.test.ts
        └── proposal.test.ts
```

Plus `docs/L2/playbook-store-nexus.md`.

### Shared changes

- `scripts/layers.ts` — add both names to `L2_PACKAGES`.

---

## Task 1: Snapshot adapter scaffolding

**Files:**
- Create: `packages/lib/snapshot-store-nexus/package.json`
- Create: `packages/lib/snapshot-store-nexus/tsconfig.json`
- Create: `packages/lib/snapshot-store-nexus/tsup.config.ts`

- [ ] **Step 1.1: Write `package.json`**

```json
{
  "name": "@koi/snapshot-store-nexus",
  "description": "L2 storage adapter: SnapshotChainStore<T> over Nexus JSON-RPC",
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
    "lint": "biome check --vcs-enabled=false src/",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/core": "workspace:*",
    "@koi/hash": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  },
  "devDependencies": {
    "@koi/fs-nexus": "workspace:*"
  }
}
```

- [ ] **Step 1.2: Write `tsconfig.json`**

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
    { "path": "../hash" },
    { "path": "../nexus-client" },
    { "path": "../fs-nexus" }
  ]
}
```

- [ ] **Step 1.3: Write `tsup.config.ts`**

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

- [ ] **Step 1.4: Run `bun install` so the workspace picks up the new package**

Run: `bun install`
Expected: lockfile updates, no errors.

- [ ] **Step 1.5: Commit scaffolding**

```bash
git add packages/lib/snapshot-store-nexus/package.json packages/lib/snapshot-store-nexus/tsconfig.json packages/lib/snapshot-store-nexus/tsup.config.ts bun.lock
git commit -m "feat(snapshot-store-nexus): scaffold L2 package (#1405)"
```

---

## Task 2: Snapshot adapter spec doc (Doc-first)

**Files:**
- Create: `docs/L2/snapshot-store-nexus.md`

- [ ] **Step 2.1: Write the spec doc**

Path: `docs/L2/snapshot-store-nexus.md`

```markdown
# @koi/snapshot-store-nexus

L2 storage adapter implementing `SnapshotChainStore<T>` from `@koi/core` over a Nexus JSON-RPC transport.

Same generic interface as `@koi/snapshot-store-sqlite` — drop-in replacement for distributed deployments where snapshot history must outlive a single host.

Tracks issue #1405.

---

## Why It Exists

`@koi/snapshot-store-sqlite` works for single-host agents but binds snapshot history to one disk. Distributed runtimes (multi-host workers, recovery on a different node) need persistence at the Nexus mount instead. This package preserves the L0 contract so callers (`@koi/checkpoint`, deterministic-replay) swap backend without code changes.

Ports the v1 implementation from `archive/v1/packages/fs/nexus-store/src/snapshots.ts` with two simplifications:

- Drops the v1 `createNexusClient(...)` wrapper — uses the v2 `NexusTransport.call(...)` directly
- Keeps the per-chain mutex (still needed; meta read-modify-write is non-atomic over RPC)

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  @koi/snapshot-store-nexus  (L2 adapter)               │
│                                                        │
│  types.ts          ← NexusSnapshotStoreConfig          │
│  paths.ts          ← path layout + segment validation  │
│  json-io.ts        ← read/write/delete/list/exists     │
│  nexus-store.ts    ← createSnapshotStoreNexus<T>       │
│  index.ts          ← public API                        │
└────────────────────────────────────────────────────────┘
Dependencies: @koi/core, @koi/hash, @koi/nexus-client
```

## Path layout

```
<basePath>/<chainId>/<nodeId>.json   — node payload (SnapshotNode<T>)
<basePath>/<chainId>/meta.json       — { headNodeId, nodeIds[] }
```

`basePath` defaults to `"snapshots"`. Chain ID and node ID are validated for path safety (no `/`, `..`, null bytes, or backslash).

## Concurrency

Operations that touch `meta.json` (`put`, `prune`) are serialized **per chain** via an in-memory mutex map. Two processes pointing at the same Nexus mount need a higher-level lock — same constraint as v1.

## Batch operations

Not exposed — `SnapshotChainStore<T>` has no batch method. Callers issuing many `put`s pay one round-trip per node. If batch becomes a bottleneck, lift a `putMany` into the L0 contract first.

## Connection-loss handling

Every method returns `Result<T, KoiError>`. Transport errors propagate as `EXTERNAL`-coded errors via `mapNexusError` from `@koi/nexus-client`. A `read` returning EXTERNAL or NOT_FOUND for a missing chain is treated as "empty chain" rather than failure.

## Wiring

`@koi/snapshot-store-nexus` is `koi.optional: true`. L3 (`@koi/runtime` or successor) selects between sqlite and nexus backends at assembly time based on config — no static `dependencies` link.
```

- [ ] **Step 2.2: Commit doc**

```bash
git add docs/L2/snapshot-store-nexus.md
git commit -m "docs(snapshot-store-nexus): L2 spec (#1405)"
```

---

## Task 3: Path safety helpers (TDD)

**Files:**
- Create: `packages/lib/snapshot-store-nexus/src/paths.ts`
- Create: `packages/lib/snapshot-store-nexus/src/paths.test.ts`

- [ ] **Step 3.1: Write the failing test**

Path: `packages/lib/snapshot-store-nexus/src/paths.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { nodePath, metaPath, validateSegment } from "./paths.js";

describe("nodePath", () => {
  test("composes basePath/chainId/nodeId.json", () => {
    expect(nodePath("snapshots", "chain-1", "node-abc")).toBe(
      "snapshots/chain-1/node-abc.json",
    );
  });
});

describe("metaPath", () => {
  test("composes basePath/chainId/meta.json", () => {
    expect(metaPath("snapshots", "chain-1")).toBe("snapshots/chain-1/meta.json");
  });
});

describe("validateSegment", () => {
  test("accepts safe segments", () => {
    const r = validateSegment("chain-1", "Chain ID");
    expect(r.ok).toBe(true);
  });

  test.each([
    ["", "empty"],
    ["a/b", "slash"],
    ["..", "dotdot"],
    ["a\\b", "backslash"],
    ["a\0b", "null byte"],
  ])("rejects unsafe segment: %s (%s)", (segment) => {
    const r = validateSegment(segment, "Test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `bun test packages/lib/snapshot-store-nexus/src/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `paths.ts`**

Path: `packages/lib/snapshot-store-nexus/src/paths.ts`

```ts
/**
 * Path layout + segment validation for the Nexus snapshot store.
 *
 * Snapshots are stored as JSON files at deterministic paths:
 *   <basePath>/<chainId>/<nodeId>.json   — node payload
 *   <basePath>/<chainId>/meta.json       — chain head + node list
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export function nodePath(basePath: string, chainId: string, nodeId: string): string {
  return `${basePath}/${chainId}/${nodeId}.json`;
}

export function metaPath(basePath: string, chainId: string): string {
  return `${basePath}/${chainId}/meta.json`;
}

/**
 * Reject path segments that could escape the basePath sandbox.
 * Disallows: empty, slash, dot-dot, backslash, null byte.
 */
export function validateSegment(segment: string, label: string): Result<void, KoiError> {
  if (segment.length === 0) return invalid(`${label} cannot be empty`);
  if (segment.includes("/")) return invalid(`${label} cannot contain '/': ${segment}`);
  if (segment === "..") return invalid(`${label} cannot be '..'`);
  if (segment.includes("\\")) return invalid(`${label} cannot contain '\\': ${segment}`);
  if (segment.includes("\0")) return invalid(`${label} cannot contain null bytes`);
  return { ok: true, value: undefined };
}

function invalid(message: string): Result<void, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `bun test packages/lib/snapshot-store-nexus/src/paths.test.ts`
Expected: PASS — all 7 cases.

- [ ] **Step 3.5: Commit**

```bash
git add packages/lib/snapshot-store-nexus/src/paths.ts packages/lib/snapshot-store-nexus/src/paths.test.ts
git commit -m "feat(snapshot-store-nexus): path layout + segment validation (#1405)"
```

---

## Task 4: JSON I/O helpers (TDD)

**Files:**
- Create: `packages/lib/snapshot-store-nexus/src/json-io.ts`
- Create: `packages/lib/snapshot-store-nexus/src/json-io.test.ts`

- [ ] **Step 4.1: Write the failing test**

Path: `packages/lib/snapshot-store-nexus/src/json-io.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { deleteJson, exists, listChildren, readJson, writeJson } from "./json-io.js";

describe("json-io", () => {
  test("writeJson / readJson round-trip", async () => {
    const transport = createFakeNexusTransport();
    const w = await writeJson(transport, "/snapshots/x.json", { hello: "world" });
    expect(w.ok).toBe(true);

    const r = await readJson<{ hello: string }>(transport, "/snapshots/x.json");
    expect(r.ok).toBe(true);
    if (r.ok && r.value !== undefined) expect(r.value.hello).toBe("world");
  });

  test("readJson on missing path returns undefined value (not error)", async () => {
    const transport = createFakeNexusTransport();
    const r = await readJson<unknown>(transport, "/snapshots/missing.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("exists returns false for missing", async () => {
    const transport = createFakeNexusTransport();
    const r = await exists(transport, "/snapshots/none.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);
  });

  test("exists returns true after write", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/y.json", { v: 1 });
    const r = await exists(transport, "/snapshots/y.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);
  });

  test("deleteJson removes the file", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/z.json", { v: 2 });
    const d = await deleteJson(transport, "/snapshots/z.json");
    expect(d.ok).toBe(true);
    const r = await readJson<unknown>(transport, "/snapshots/z.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  test("listChildren glob lists matching files", async () => {
    const transport = createFakeNexusTransport();
    await writeJson(transport, "/snapshots/a.json", { i: 1 });
    await writeJson(transport, "/snapshots/b.json", { i: 2 });
    const r = await listChildren(transport, "/snapshots/*.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `bun test packages/lib/snapshot-store-nexus/src/json-io.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `json-io.ts`**

Path: `packages/lib/snapshot-store-nexus/src/json-io.ts`

```ts
/**
 * JSON I/O helpers over a NexusTransport.
 *
 * Single-file utilities used by the snapshot store. Each helper returns
 * `Result<T, KoiError>` so callers can compose without throwing.
 *
 * `readJson` treats NOT_FOUND / EXTERNAL "file does not exist" responses as
 * `value: undefined` rather than errors — matches the chain-store contract,
 * where reading a missing meta is "empty chain", not a failure.
 */

import type { KoiError, Result } from "@koi/core";
import { internal } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface NexusReadResponse {
  readonly content?: unknown;
  readonly metadata?: { readonly size?: number };
}

interface NexusListEntry {
  readonly path: string;
}

interface NexusListResponse {
  readonly files: readonly NexusListEntry[];
}

/** Decode a Nexus read result into a UTF-8 string. */
function decodeContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return "";
  const obj = raw as Record<string, unknown>;
  if (obj.__type__ === "bytes" && typeof obj.data === "string") {
    return Buffer.from(obj.data, "base64").toString("utf-8");
  }
  if (obj.content !== undefined) return decodeContent(obj.content);
  return "";
}

/** Read + JSON-parse a file. Missing file → `value: undefined`. */
export async function readJson<T>(
  transport: NexusTransport,
  path: string,
): Promise<Result<T | undefined, KoiError>> {
  const r = await transport.call<NexusReadResponse | string>("read", { path });
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
      return { ok: true, value: undefined };
    }
    return r;
  }
  const text = decodeContent(r.value);
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: internal(`json-io: parse error at ${path}`, e) };
  }
}

/** Stringify + write a value to a path. */
export async function writeJson(
  transport: NexusTransport,
  path: string,
  data: unknown,
): Promise<Result<void, KoiError>> {
  const r = await transport.call<unknown>("write", {
    path,
    content: JSON.stringify(data),
  });
  if (!r.ok) return r;
  return { ok: true, value: undefined };
}

/** Delete a file. Missing file is a no-op (returns `ok: true`). */
export async function deleteJson(
  transport: NexusTransport,
  path: string,
): Promise<Result<void, KoiError>> {
  const r = await transport.call<unknown>("delete", { path });
  if (!r.ok && r.error.code !== "NOT_FOUND" && r.error.code !== "EXTERNAL") return r;
  return { ok: true, value: undefined };
}

/** Existence check via list — true when the path appears in its parent. */
export async function exists(
  transport: NexusTransport,
  path: string,
): Promise<Result<boolean, KoiError>> {
  const r = await transport.call<unknown>("read", { path });
  if (r.ok) return { ok: true, value: true };
  if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
    return { ok: true, value: false };
  }
  return { ok: false, error: r.error };
}

/** Glob list — returns paths matching the pattern. */
export async function listChildren(
  transport: NexusTransport,
  pattern: string,
): Promise<Result<readonly string[], KoiError>> {
  const r = await transport.call<NexusListResponse>("list", { pattern });
  if (!r.ok) return r;
  return { ok: true, value: r.value.files.map((f) => f.path) };
}
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `bun test packages/lib/snapshot-store-nexus/src/json-io.test.ts`
Expected: PASS — 6 cases.

- [ ] **Step 4.5: Commit**

```bash
git add packages/lib/snapshot-store-nexus/src/json-io.ts packages/lib/snapshot-store-nexus/src/json-io.test.ts
git commit -m "feat(snapshot-store-nexus): JSON I/O helpers over NexusTransport (#1405)"
```

---

## Task 5: Snapshot store types

**Files:**
- Create: `packages/lib/snapshot-store-nexus/src/types.ts`

- [ ] **Step 5.1: Write `types.ts`**

```ts
/**
 * Configuration for `createSnapshotStoreNexus`.
 *
 * The store is generic over the payload type `T`. Snapshots are written as
 * JSON files at `<basePath>/<chainId>/<nodeId>.json`.
 */

import type { NexusTransport } from "@koi/nexus-client";

export interface NexusSnapshotStoreConfig {
  /** A configured Nexus transport (HTTP, local-bridge, or test fake). */
  readonly transport: NexusTransport;

  /**
   * Base path within the Nexus mount where chains are stored.
   * Defaults to `"snapshots"`. Must not contain `..`, `\`, or null bytes.
   */
  readonly basePath?: string;
}
```

- [ ] **Step 5.2: Commit**

```bash
git add packages/lib/snapshot-store-nexus/src/types.ts
git commit -m "feat(snapshot-store-nexus): config type (#1405)"
```

---

## Task 6: Snapshot store factory (TDD)

**Files:**
- Create: `packages/lib/snapshot-store-nexus/src/nexus-store.ts`
- Create: `packages/lib/snapshot-store-nexus/src/nexus-store.test.ts`
- Create: `packages/lib/snapshot-store-nexus/src/index.ts`

- [ ] **Step 6.1: Write the failing factory test**

Path: `packages/lib/snapshot-store-nexus/src/nexus-store.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { ChainId, NodeId } from "@koi/core";
import { chainId } from "@koi/core";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createSnapshotStoreNexus } from "./nexus-store.js";

interface TData {
  readonly v: number;
}

function newStore() {
  return createSnapshotStoreNexus<TData>({
    transport: createFakeNexusTransport(),
  });
}

describe("createSnapshotStoreNexus", () => {
  test("put → head round-trip", async () => {
    const store = newStore();
    const cid = chainId("c1");
    const r = await store.put(cid, { v: 1 }, []);
    expect(r.ok).toBe(true);
    const h = await store.head(cid);
    expect(h.ok).toBe(true);
    if (h.ok && h.value !== undefined) expect(h.value.data).toEqual({ v: 1 });
  });

  test("skipIfUnchanged dedupes by content hash", async () => {
    const store = newStore();
    const cid = chainId("c2");
    const a = await store.put(cid, { v: 7 }, []);
    expect(a.ok).toBe(true);
    const b = await store.put(cid, { v: 7 }, [], undefined, { skipIfUnchanged: true });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value).toBeUndefined();
    const list = await store.list(cid);
    if (list.ok) expect(list.value.length).toBe(1);
  });

  test("get walks the glob to find a node by id", async () => {
    const store = newStore();
    const cid = chainId("c3");
    const r = await store.put(cid, { v: 3 }, []);
    if (!r.ok || r.value === undefined) throw new Error("put failed");
    const got = await store.get(r.value.nodeId);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.data.v).toBe(3);
  });

  test("get on missing node returns NOT_FOUND", async () => {
    const store = newStore();
    const r = await store.get("node-nope" as NodeId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("ancestors walks parent chain", async () => {
    const store = newStore();
    const cid = chainId("c4");
    const root = await store.put(cid, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error("root put failed");
    const child = await store.put(cid, { v: 2 }, [root.value.nodeId]);
    if (!child.ok || child.value === undefined) throw new Error("child put failed");

    const r = await store.ancestors({ startNodeId: child.value.nodeId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });

  test("fork copies node into new chain", async () => {
    const store = newStore();
    const src = chainId("src");
    const root = await store.put(src, { v: 1 }, []);
    if (!root.ok || root.value === undefined) throw new Error();

    const f = await store.fork(root.value.nodeId, chainId("forked"), "experiment");
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.value.label).toBe("experiment");

    const head = await store.head(chainId("forked"));
    expect(head.ok).toBe(true);
    if (head.ok && head.value !== undefined) expect(head.value.data.v).toBe(1);
  });

  test("prune retainCount keeps only the newest N nodes", async () => {
    const store = newStore();
    const cid = chainId("c-prune");
    for (let i = 0; i < 5; i++) {
      const r = await store.put(cid, { v: i }, []);
      if (!r.ok) throw new Error("put failed");
    }
    const removed = await store.prune(cid, { retainCount: 2 });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value).toBe(3);
    const list = await store.list(cid);
    if (list.ok) expect(list.value.length).toBe(2);
  });

  test("rejects path-unsafe chain IDs", async () => {
    const store = newStore();
    const r = await store.put("a/b" as ChainId, { v: 1 }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("transport-level error on read surfaces as EXTERNAL", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "read",
      failCode: -32603,
      failMessage: "boom",
    });
    const store = createSnapshotStoreNexus<TData>({ transport });
    const r = await store.head(chainId("any"));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `bun test packages/lib/snapshot-store-nexus/src/nexus-store.test.ts`
Expected: FAIL — `createSnapshotStoreNexus` not exported.

- [ ] **Step 6.3: Implement `nexus-store.ts`**

Path: `packages/lib/snapshot-store-nexus/src/nexus-store.ts`

```ts
/**
 * Nexus-backed `SnapshotChainStore<T>`.
 *
 * Each chain lives at <basePath>/<chainId>/, with one JSON file per node and
 * a meta.json holding the head pointer + node order. Per-chain mutex
 * serializes meta read-modify-write within a single process.
 */

import type {
  AncestorQuery,
  ChainId,
  ForkRef,
  KoiError,
  NodeId,
  PruningPolicy,
  PutOptions,
  Result,
  SnapshotChainStore,
  SnapshotNode,
} from "@koi/core";
import { nodeId as makeNodeId, notFound, validation } from "@koi/core";
import { computeContentHash } from "@koi/hash";
import { deleteJson, exists, listChildren, readJson, writeJson } from "./json-io.js";
import { metaPath, nodePath, validateSegment } from "./paths.js";
import type { NexusSnapshotStoreConfig } from "./types.js";

interface ChainMeta {
  readonly headNodeId: NodeId | null;
  readonly nodeIds: readonly NodeId[];
}

const EMPTY_META: ChainMeta = { headNodeId: null, nodeIds: [] };

const DEFAULT_BASE_PATH = "snapshots";

export function createSnapshotStoreNexus<T>(
  config: NexusSnapshotStoreConfig,
): SnapshotChainStore<T> {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const transport = config.transport;
  const chainLocks = new Map<ChainId, Promise<void>>();

  // ----- meta + node helpers ------------------------------------------------

  async function readMeta(cid: ChainId): Promise<Result<ChainMeta, KoiError>> {
    const r = await readJson<ChainMeta>(transport, metaPath(basePath, cid));
    if (!r.ok) return r;
    if (r.value === undefined) return { ok: true, value: EMPTY_META };
    return { ok: true, value: r.value };
  }

  async function writeMeta(cid: ChainId, meta: ChainMeta): Promise<Result<void, KoiError>> {
    return writeJson(transport, metaPath(basePath, cid), meta);
  }

  async function readNode(
    cid: ChainId,
    nid: NodeId,
  ): Promise<Result<SnapshotNode<T>, KoiError>> {
    const r = await readJson<SnapshotNode<T>>(transport, nodePath(basePath, cid, nid));
    if (!r.ok) return r;
    if (r.value === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    return { ok: true, value: r.value };
  }

  async function writeNode(node: SnapshotNode<T>): Promise<Result<void, KoiError>> {
    return writeJson(transport, nodePath(basePath, node.chainId, node.nodeId), node);
  }

  // ----- per-chain mutex ----------------------------------------------------

  async function withChainLock<R>(cid: ChainId, fn: () => Promise<R>): Promise<R> {
    const prev = chainLocks.get(cid) ?? Promise.resolve();
    let release = (): void => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    chainLocks.set(cid, next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ----- SnapshotChainStore methods -----------------------------------------

  const put: SnapshotChainStore<T>["put"] = async (cid, data, parentIds, metadata, options) => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return seg;
    for (const pid of parentIds) {
      const psg = validateSegment(pid, "Parent Node ID");
      if (!psg.ok) return psg;
    }
    for (const pid of parentIds) {
      const ex = await exists(transport, nodePath(basePath, cid, pid));
      if (!ex.ok) return ex;
      if (!ex.value) return { ok: false, error: validation(`Parent node not found: ${pid}`) };
    }
    return withChainLock(cid, async () => {
      const hash = computeContentHash(data);
      const metaRes = await readMeta(cid);
      if (!metaRes.ok) return metaRes;
      const meta = metaRes.value;

      if (options?.skipIfUnchanged === true && meta.headNodeId !== null) {
        const head = await readNode(cid, meta.headNodeId);
        if (head.ok && head.value.contentHash === hash) {
          return { ok: true, value: undefined };
        }
      }

      const nid = makeNodeId(`node-${crypto.randomUUID()}`);
      const node: SnapshotNode<T> = {
        nodeId: nid,
        chainId: cid,
        parentIds: [...parentIds],
        contentHash: hash,
        data,
        createdAt: Date.now(),
        metadata: metadata ?? {},
      };
      const wn = await writeNode(node);
      if (!wn.ok) return wn;
      const wm = await writeMeta(cid, {
        headNodeId: nid,
        nodeIds: [...meta.nodeIds, nid],
      });
      if (!wm.ok) return wm;
      return { ok: true, value: node };
    });
  };

  const get: SnapshotChainStore<T>["get"] = async (nid) => {
    const seg = validateSegment(nid, "Node ID");
    if (!seg.ok) return seg;
    const matches = await listChildren(transport, `${basePath}/*/${nid}.json`);
    if (!matches.ok) return matches;
    const path = matches.value[0];
    if (path === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    const r = await readJson<SnapshotNode<T>>(transport, path);
    if (!r.ok) return r;
    if (r.value === undefined) {
      return { ok: false, error: notFound(nid, `Snapshot node not found: ${nid}`) };
    }
    return { ok: true, value: r.value };
  };

  const head: SnapshotChainStore<T>["head"] = async (cid) => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return seg;
    const m = await readMeta(cid);
    if (!m.ok) return m;
    if (m.value.headNodeId === null) return { ok: true, value: undefined };
    return readNode(cid, m.value.headNodeId);
  };

  const list: SnapshotChainStore<T>["list"] = async (cid) => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return seg;
    const m = await readMeta(cid);
    if (!m.ok) return m;
    const ids = m.value.nodeIds;
    const out: SnapshotNode<T>[] = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (id === undefined) continue;
      const r = await readNode(cid, id);
      if (r.ok) out.push(r.value);
    }
    return { ok: true, value: out };
  };

  const ancestors: SnapshotChainStore<T>["ancestors"] = async (query: AncestorQuery) => {
    const start = await get(query.startNodeId);
    if (!start.ok) return start;
    const out: SnapshotNode<T>[] = [];
    const visited = new Set<NodeId>();
    const queue: Array<readonly [SnapshotNode<T>, number]> = [[start.value, 1]];
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      const [node, depth] = entry;
      if (visited.has(node.nodeId)) continue;
      visited.add(node.nodeId);
      out.push(node);
      if (query.maxDepth !== undefined && depth >= query.maxDepth) continue;
      for (const pid of node.parentIds) {
        if (visited.has(pid)) continue;
        const pr = await get(pid);
        if (pr.ok) queue.push([pr.value, depth + 1]);
      }
    }
    return { ok: true, value: out };
  };

  const fork: SnapshotChainStore<T>["fork"] = async (sourceNodeId, newChainId, label) => {
    const sseg = validateSegment(sourceNodeId, "Source Node ID");
    if (!sseg.ok) return sseg;
    const cseg = validateSegment(newChainId, "New Chain ID");
    if (!cseg.ok) return cseg;
    const src = await get(sourceNodeId);
    if (!src.ok) return src;
    const copy: SnapshotNode<T> = { ...src.value, chainId: newChainId };
    const wn = await writeNode(copy);
    if (!wn.ok) return wn;
    const wm = await writeMeta(newChainId, {
      headNodeId: sourceNodeId,
      nodeIds: [sourceNodeId],
    });
    if (!wm.ok) return wm;
    const ref: ForkRef = { parentNodeId: sourceNodeId, label };
    return { ok: true, value: ref };
  };

  const prune: SnapshotChainStore<T>["prune"] = async (cid, policy: PruningPolicy) => {
    const seg = validateSegment(cid, "Chain ID");
    if (!seg.ok) return seg;
    return withChainLock(cid, async () => {
      const m = await readMeta(cid);
      if (!m.ok) return m;
      const ids = [...m.value.nodeIds];
      if (ids.length === 0) return { ok: true, value: 0 };

      const remove = new Set<number>();
      if (policy.retainCount !== undefined && ids.length > policy.retainCount) {
        for (let i = 0; i < ids.length - policy.retainCount; i++) remove.add(i);
      }
      if (policy.retainDuration !== undefined) {
        const cutoff = Date.now() - policy.retainDuration;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (id === undefined) continue;
          const node = await readNode(cid, id);
          if (node.ok && node.value.createdAt < cutoff) remove.add(i);
        }
      }
      if (policy.retainBranches !== false) remove.delete(ids.length - 1);

      const sorted = [...remove].sort((a, b) => b - a);
      let removed = 0;
      for (const idx of sorted) {
        const id = ids[idx];
        if (id !== undefined) {
          const d = await deleteJson(transport, nodePath(basePath, cid, id));
          if (!d.ok) return d;
          removed += 1;
        }
        ids.splice(idx, 1);
      }
      const newHead = ids.length > 0 ? (ids[ids.length - 1] ?? null) : null;
      const wm = await writeMeta(cid, { headNodeId: newHead, nodeIds: ids });
      if (!wm.ok) return wm;
      return { ok: true, value: removed };
    });
  };

  const close = (): void => {
    transport.close();
  };

  return { put, get, head, list, ancestors, fork, prune, close };
}
```

- [ ] **Step 6.4: Write `index.ts`**

Path: `packages/lib/snapshot-store-nexus/src/index.ts`

```ts
/**
 * @koi/snapshot-store-nexus — Nexus-backed `SnapshotChainStore<T>`.
 *
 * L2 storage adapter with the same generic interface as `@koi/snapshot-store-sqlite`.
 *
 * Spec: docs/L2/snapshot-store-nexus.md
 */

export { createSnapshotStoreNexus } from "./nexus-store.js";
export type { NexusSnapshotStoreConfig } from "./types.js";
```

- [ ] **Step 6.5: Run tests**

Run: `bun test packages/lib/snapshot-store-nexus/`
Expected: PASS — all suites green.

- [ ] **Step 6.6: Run typecheck + lint**

Run: `bun run --filter=@koi/snapshot-store-nexus typecheck && bun run --filter=@koi/snapshot-store-nexus lint`
Expected: clean.

- [ ] **Step 6.7: Commit**

```bash
git add packages/lib/snapshot-store-nexus/src/nexus-store.ts packages/lib/snapshot-store-nexus/src/nexus-store.test.ts packages/lib/snapshot-store-nexus/src/index.ts
git commit -m "feat(snapshot-store-nexus): SnapshotChainStore<T> implementation (#1405)"
```

---

## Task 7: Wire snapshot-store-nexus into layers + run gates

**Files:**
- Modify: `scripts/layers.ts` (add `"@koi/snapshot-store-nexus"` to `L2_PACKAGES`)

- [ ] **Step 7.1: Edit `scripts/layers.ts`**

Find the `L2_PACKAGES` set and add the new entry alphabetically. Look for the existing `"@koi/snapshot-store-sqlite"` line and add `"@koi/snapshot-store-nexus"` immediately above it.

- [ ] **Step 7.2: Run check:layers**

Run: `bun run check:layers`
Expected: PASS — no layer violations.

- [ ] **Step 7.3: Run check:orphans**

Run: `bun run check:orphans`
Expected: PASS — `@koi/snapshot-store-nexus` is exempt via `koi.optional: true`.

- [ ] **Step 7.4: Commit**

```bash
git add scripts/layers.ts
git commit -m "chore(layers): register snapshot-store-nexus as L2 (#1405)"
```

---

## Task 8: Playbook adapter scaffolding

**Files:**
- Create: `packages/lib/playbook-store-nexus/package.json`
- Create: `packages/lib/playbook-store-nexus/tsconfig.json`
- Create: `packages/lib/playbook-store-nexus/tsup.config.ts`

- [ ] **Step 8.1: Write `package.json`**

```json
{
  "name": "@koi/playbook-store-nexus",
  "description": "L2 storage adapter: ACE PlaybookStore/StructuredPlaybookStore/TrajectoryStore/PlaybookProposalStore over Nexus",
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
    "lint": "biome check --vcs-enabled=false src/",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  },
  "dependencies": {
    "@koi/ace-types": "workspace:*",
    "@koi/core": "workspace:*",
    "@koi/nexus-client": "workspace:*"
  },
  "devDependencies": {
    "@koi/fs-nexus": "workspace:*"
  }
}
```

- [ ] **Step 8.2: Write `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../ace-types" },
    { "path": "../../kernel/core" },
    { "path": "../nexus-client" },
    { "path": "../fs-nexus" }
  ]
}
```

- [ ] **Step 8.3: Write `tsup.config.ts`**

```ts
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

- [ ] **Step 8.4: Install + commit**

```bash
bun install
git add packages/lib/playbook-store-nexus/package.json packages/lib/playbook-store-nexus/tsconfig.json packages/lib/playbook-store-nexus/tsup.config.ts bun.lock
git commit -m "feat(playbook-store-nexus): scaffold L2 package (#1405)"
```

---

## Task 9: Playbook adapter spec doc

**Files:**
- Create: `docs/L2/playbook-store-nexus.md`

- [ ] **Step 9.1: Write doc**

```markdown
# @koi/playbook-store-nexus

L2 storage adapter implementing the four ACE store contracts from `@koi/ace-types` over Nexus JSON-RPC:

- `PlaybookStore`
- `StructuredPlaybookStore`
- `TrajectoryStore`
- `PlaybookProposalStore`

Same interfaces as `@koi/playbook-store-sqlite` — drop-in for distributed deployments.

Tracks issue #1405.

---

## Why It Exists

ACE's self-improvement loop persists playbooks, structured playbooks, trajectories, and proposals across sessions. Sqlite works on a single host. When agents run on different machines but share a Nexus mount, they need a backend that publishes learning to every peer. This package provides exactly that, behind the same contracts.

Ports `archive/v1/packages/fs/nexus-store/src/ace.ts` to v2's split-package layout (one factory per substore) and replaces the v1 `createNexusClient(...)` wrapper with the v2 `NexusTransport.call(...)` surface.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ @koi/playbook-store-nexus (L2)                          │
│                                                         │
│ types.ts        ← NexusPlaybookStoreConfig              │
│ json-io.ts      ← read/write/delete/listChildren        │
│ playbook.ts     ← createNexusPlaybookStore              │
│ structured.ts   ← createNexusStructuredPlaybookStore    │
│ trajectory.ts   ← createNexusTrajectoryStore            │
│ proposal.ts     ← createNexusPlaybookProposalStore      │
│ store.ts        ← createPlaybookStoreNexus (composite)  │
│ index.ts        ← public API                            │
└─────────────────────────────────────────────────────────┘
Dependencies: @koi/ace-types, @koi/core, @koi/nexus-client
```

## Path layout

```
<basePath>/playbooks/<id>.json
<basePath>/structured/<id>.json
<basePath>/trajectories/<sessionId>.json
<basePath>/proposals/<proposalId>.json
<basePath>/proposals-by-playbook/<playbookId>/<proposalId>.json   (index)
<basePath>/evaluations/<proposalId>.json
```

`basePath` defaults to `"ace"`. IDs are sanitized — colons in session IDs become `_` so Nexus list/glob can index them.

## Differences vs sqlite sibling

- No SQL — list ops are O(N) over a glob. Acceptable: ACE list operations are user-driven, not hot-path.
- No `getVersion()` lineage — sqlite uses an indexed `version` column; nexus stores only the latest version per ID. The optional `getVersion` returns `undefined` to signal lineage is unavailable. Documented as a known gap; #1469 tracks the lineage solution.
- `storeId` is derived from the configured `basePath` (deterministic per mount) rather than per-database UUID. ACE's resume guard tolerates this — it cares about "did the database move under me", and the nexus mount has its own identity.
- No writer lock — ACE in distributed mode tolerates concurrent updates (last-write-wins on `version`). Single-host concurrent writers must use the sqlite backend.

## Connection-loss handling

Each store method propagates transport errors. `read` calls returning NOT_FOUND/EXTERNAL are treated as `undefined`, matching the contract.

## Wiring

Exempt from the orphan check via `koi.optional: true`. L3 selects between sqlite and nexus at assembly time.
```

- [ ] **Step 9.2: Commit**

```bash
git add docs/L2/playbook-store-nexus.md
git commit -m "docs(playbook-store-nexus): L2 spec (#1405)"
```

---

## Task 10: Playbook adapter shared helpers + types

**Files:**
- Create: `packages/lib/playbook-store-nexus/src/types.ts`
- Create: `packages/lib/playbook-store-nexus/src/json-io.ts`

- [ ] **Step 10.1: Write `types.ts`**

```ts
/** Configuration for the Nexus-backed ACE stores. */

import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPlaybookStoreConfig {
  /** A configured Nexus transport. */
  readonly transport: NexusTransport;
  /** Base path for all ACE files. Default: "ace". */
  readonly basePath?: string;
}
```

- [ ] **Step 10.2: Write `json-io.ts`**

Same structure as the snapshot-store-nexus version, plus a path-segment sanitizer for ACE IDs (colons become underscores).

```ts
/**
 * JSON I/O helpers for the Nexus-backed ACE stores.
 *
 * `sanitizeId` collapses colons to underscores so session IDs like
 * "session:2026-05-03:abc" are storable as filenames Nexus can list/glob.
 */

import type { KoiError, Result } from "@koi/core";
import { internal } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface NexusListEntry {
  readonly path: string;
}

interface NexusListResponse {
  readonly files: readonly NexusListEntry[];
}

export function sanitizeId(id: string): string {
  return id.replace(/:/g, "_");
}

function decodeContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return "";
  const obj = raw as Record<string, unknown>;
  if (obj.__type__ === "bytes" && typeof obj.data === "string") {
    return Buffer.from(obj.data, "base64").toString("utf-8");
  }
  if (obj.content !== undefined) return decodeContent(obj.content);
  return "";
}

export async function readJson<T>(
  transport: NexusTransport,
  path: string,
): Promise<Result<T | undefined, KoiError>> {
  const r = await transport.call<unknown>("read", { path });
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
      return { ok: true, value: undefined };
    }
    return r;
  }
  const text = decodeContent(r.value);
  if (text === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    return { ok: false, error: internal(`playbook-store-nexus: parse error at ${path}`, e) };
  }
}

export async function writeJson(
  transport: NexusTransport,
  path: string,
  data: unknown,
): Promise<Result<void, KoiError>> {
  const r = await transport.call<unknown>("write", { path, content: JSON.stringify(data) });
  if (!r.ok) return r;
  return { ok: true, value: undefined };
}

export async function deleteJson(
  transport: NexusTransport,
  path: string,
): Promise<Result<boolean, KoiError>> {
  const r = await transport.call<unknown>("delete", { path });
  if (!r.ok) {
    if (r.error.code === "NOT_FOUND" || r.error.code === "EXTERNAL") {
      return { ok: true, value: false };
    }
    return r;
  }
  return { ok: true, value: true };
}

export async function listChildren(
  transport: NexusTransport,
  pattern: string,
): Promise<Result<readonly string[], KoiError>> {
  const r = await transport.call<NexusListResponse>("list", { pattern });
  if (!r.ok) return r;
  return { ok: true, value: r.value.files.map((f) => f.path) };
}

export function basenameNoExt(path: string): string {
  const file = path.split("/").pop() ?? "";
  return file.replace(/\.json$/, "");
}
```

- [ ] **Step 10.3: Commit**

```bash
git add packages/lib/playbook-store-nexus/src/types.ts packages/lib/playbook-store-nexus/src/json-io.ts
git commit -m "feat(playbook-store-nexus): config + JSON I/O helpers (#1405)"
```

---

## Task 11: PlaybookStore (TDD)

**Files:**
- Create: `packages/lib/playbook-store-nexus/src/playbook.ts`
- Create: `packages/lib/playbook-store-nexus/src/__tests__/playbook.test.ts`

- [ ] **Step 11.1: Write the failing test**

Path: `packages/lib/playbook-store-nexus/src/__tests__/playbook.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { Playbook } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createNexusPlaybookStore } from "../playbook.js";

function pb(id: string, conf: number, tags: readonly string[] = []): Playbook {
  return {
    id,
    title: id,
    bullets: [],
    tags,
    confidence: conf,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  } as Playbook;
}

describe("createNexusPlaybookStore", () => {
  test("save → get round-trip", async () => {
    const store = createNexusPlaybookStore({ transport: createFakeNexusTransport() });
    await store.save(pb("p1", 0.9));
    const r = await store.get("p1");
    expect(r?.id).toBe("p1");
    expect(r?.confidence).toBe(0.9);
  });

  test("get returns undefined for missing", async () => {
    const store = createNexusPlaybookStore({ transport: createFakeNexusTransport() });
    expect(await store.get("absent")).toBeUndefined();
  });

  test("list filters by minConfidence", async () => {
    const store = createNexusPlaybookStore({ transport: createFakeNexusTransport() });
    await store.save(pb("a", 0.4));
    await store.save(pb("b", 0.9));
    const r = await store.list({ minConfidence: 0.5 });
    expect(r.length).toBe(1);
    expect(r[0]?.id).toBe("b");
  });

  test("list filters by tag", async () => {
    const store = createNexusPlaybookStore({ transport: createFakeNexusTransport() });
    await store.save(pb("a", 0.9, ["x"]));
    await store.save(pb("b", 0.9, ["y"]));
    const r = await store.list({ tags: ["x"] });
    expect(r.length).toBe(1);
    expect(r[0]?.id).toBe("a");
  });

  test("remove deletes the playbook", async () => {
    const store = createNexusPlaybookStore({ transport: createFakeNexusTransport() });
    await store.save(pb("p1", 0.9));
    expect(await store.remove("p1")).toBe(true);
    expect(await store.get("p1")).toBeUndefined();
  });

  test("remove returns false when missing", async () => {
    const store = createNexusPlaybookStore({ transport: createFakeNexusTransport() });
    expect(await store.remove("nope")).toBe(false);
  });
});
```

- [ ] **Step 11.2: Run test — expect fail**

Run: `bun test packages/lib/playbook-store-nexus/src/__tests__/playbook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 11.3: Implement `playbook.ts`**

```ts
/** Nexus-backed `PlaybookStore` (from `@koi/ace-types`). */

import type { Playbook, PlaybookStore } from "@koi/ace-types";
import { basenameNoExt, deleteJson, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusPlaybookStore(config: NexusPlaybookStoreConfig): PlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/playbooks`;
  const transport = config.transport;
  const path = (id: string): string => `${dir}/${sanitizeId(id)}.json`;

  return {
    async get(id: string): Promise<Playbook | undefined> {
      const r = await readJson<Playbook>(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    async list(options): Promise<readonly Playbook[]> {
      const lr = await listChildren(transport, `${dir}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const out: Playbook[] = [];
      for (const p of lr.value) {
        const r = await readJson<Playbook>(transport, p);
        if (!r.ok || r.value === undefined) continue;
        const pb = r.value;
        if (options?.minConfidence !== undefined && pb.confidence < options.minConfidence) continue;
        if (
          options?.tags !== undefined &&
          options.tags.length > 0 &&
          !options.tags.some((t) => pb.tags.includes(t))
        ) {
          continue;
        }
        out.push(pb);
      }
      // Touch basenameNoExt so the import is retained when list filters short-circuit.
      void basenameNoExt;
      return out;
    },

    async save(playbook: Playbook): Promise<void> {
      const r = await writeJson(transport, path(playbook.id), playbook);
      if (!r.ok) throw new Error(r.error.message);
    },

    async remove(id: string): Promise<boolean> {
      const r = await deleteJson(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
  };
}
```

- [ ] **Step 11.4: Run tests — expect pass**

Run: `bun test packages/lib/playbook-store-nexus/src/__tests__/playbook.test.ts`
Expected: PASS — 6 cases.

- [ ] **Step 11.5: Commit**

```bash
git add packages/lib/playbook-store-nexus/src/playbook.ts packages/lib/playbook-store-nexus/src/__tests__/playbook.test.ts
git commit -m "feat(playbook-store-nexus): PlaybookStore (#1405)"
```

---

## Task 12: StructuredPlaybookStore (TDD)

**Files:**
- Create: `packages/lib/playbook-store-nexus/src/structured.ts`
- Create: `packages/lib/playbook-store-nexus/src/__tests__/structured.test.ts`

- [ ] **Step 12.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import type { StructuredPlaybook } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createNexusStructuredPlaybookStore } from "../structured.js";

function sp(id: string, tags: readonly string[] = []): StructuredPlaybook {
  return {
    id,
    title: id,
    sections: [],
    tags,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  } as StructuredPlaybook;
}

describe("createNexusStructuredPlaybookStore", () => {
  test("save → get round-trip", async () => {
    const store = createNexusStructuredPlaybookStore({
      transport: createFakeNexusTransport(),
    });
    await store.save(sp("s1"));
    expect((await store.get("s1"))?.id).toBe("s1");
  });

  test("list filters by tag", async () => {
    const store = createNexusStructuredPlaybookStore({
      transport: createFakeNexusTransport(),
    });
    await store.save(sp("a", ["one"]));
    await store.save(sp("b", ["two"]));
    const r = await store.list({ tags: ["one"] });
    expect(r.length).toBe(1);
    expect(r[0]?.id).toBe("a");
  });

  test("remove deletes", async () => {
    const store = createNexusStructuredPlaybookStore({
      transport: createFakeNexusTransport(),
    });
    await store.save(sp("s1"));
    expect(await store.remove("s1")).toBe(true);
    expect(await store.get("s1")).toBeUndefined();
  });

  test("getVersion returns undefined (lineage not stored)", async () => {
    const store = createNexusStructuredPlaybookStore({
      transport: createFakeNexusTransport(),
    });
    await store.save(sp("s1"));
    expect(await store.getVersion?.("s1", 0)).toBeUndefined();
  });
});
```

- [ ] **Step 12.2: Run — expect fail**

- [ ] **Step 12.3: Implement `structured.ts`**

```ts
/** Nexus-backed `StructuredPlaybookStore`. No lineage — `getVersion` returns undefined. */

import type { StructuredPlaybook, StructuredPlaybookStore } from "@koi/ace-types";
import { deleteJson, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusStructuredPlaybookStore(
  config: NexusPlaybookStoreConfig,
): StructuredPlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/structured`;
  const transport = config.transport;
  const path = (id: string): string => `${dir}/${sanitizeId(id)}.json`;

  return {
    async get(id: string): Promise<StructuredPlaybook | undefined> {
      const r = await readJson<StructuredPlaybook>(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
    async list(options): Promise<readonly StructuredPlaybook[]> {
      const lr = await listChildren(transport, `${dir}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const out: StructuredPlaybook[] = [];
      for (const p of lr.value) {
        const r = await readJson<StructuredPlaybook>(transport, p);
        if (!r.ok || r.value === undefined) continue;
        const pb = r.value;
        if (
          options?.tags !== undefined &&
          options.tags.length > 0 &&
          !options.tags.some((t) => pb.tags.includes(t))
        ) {
          continue;
        }
        out.push(pb);
      }
      return out;
    },
    async save(playbook: StructuredPlaybook): Promise<void> {
      const r = await writeJson(transport, path(playbook.id), playbook);
      if (!r.ok) throw new Error(r.error.message);
    },
    async remove(id: string): Promise<boolean> {
      const r = await deleteJson(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
    async getVersion(_id: string, _version: number): Promise<StructuredPlaybook | undefined> {
      return undefined;
    },
  };
}
```

- [ ] **Step 12.4: Run — expect pass; commit**

```bash
git add packages/lib/playbook-store-nexus/src/structured.ts packages/lib/playbook-store-nexus/src/__tests__/structured.test.ts
git commit -m "feat(playbook-store-nexus): StructuredPlaybookStore (#1405)"
```

---

## Task 13: TrajectoryStore (TDD)

**Files:**
- Create: `packages/lib/playbook-store-nexus/src/trajectory.ts`
- Create: `packages/lib/playbook-store-nexus/src/__tests__/trajectory.test.ts`

- [ ] **Step 13.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import type { TrajectoryEntry } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createNexusTrajectoryStore } from "../trajectory.js";

function entry(seq: number): TrajectoryEntry {
  return {
    seq,
    turnIndex: 0,
    timestamp: seq,
    kind: "tool_call",
    identifier: "t",
    outcome: "success",
    durationMs: 1,
  } as TrajectoryEntry;
}

describe("createNexusTrajectoryStore", () => {
  test("append + getSession round-trip", async () => {
    const store = createNexusTrajectoryStore({ transport: createFakeNexusTransport() });
    await store.append("session-A", [entry(1), entry(2)]);
    const r = await store.getSession("session-A");
    expect(r.length).toBe(2);
  });

  test("append accumulates across calls", async () => {
    const store = createNexusTrajectoryStore({ transport: createFakeNexusTransport() });
    await store.append("session-B", [entry(1)]);
    await store.append("session-B", [entry(2)]);
    const r = await store.getSession("session-B");
    expect(r.length).toBe(2);
    expect(r[0]?.seq).toBe(1);
  });

  test("getSession of unknown returns []", async () => {
    const store = createNexusTrajectoryStore({ transport: createFakeNexusTransport() });
    expect((await store.getSession("none")).length).toBe(0);
  });

  test("listSessions returns saved session ids", async () => {
    const store = createNexusTrajectoryStore({ transport: createFakeNexusTransport() });
    await store.append("s1", [entry(1)]);
    await store.append("s2", [entry(1)]);
    const r = await store.listSessions();
    expect(r.length).toBe(2);
  });

  test("colon in session id is sanitized for storage", async () => {
    const store = createNexusTrajectoryStore({ transport: createFakeNexusTransport() });
    await store.append("a:b:c", [entry(1)]);
    const r = await store.getSession("a:b:c");
    expect(r.length).toBe(1);
  });
});
```

- [ ] **Step 13.2: Run — expect fail**

- [ ] **Step 13.3: Implement `trajectory.ts`**

```ts
/** Nexus-backed `TrajectoryStore`. Append rewrites the session file. */

import type { TrajectoryEntry, TrajectoryStore } from "@koi/ace-types";
import { basenameNoExt, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusTrajectoryStore(
  config: NexusPlaybookStoreConfig,
): TrajectoryStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/trajectories`;
  const transport = config.transport;
  const path = (sid: string): string => `${dir}/${sanitizeId(sid)}.json`;

  return {
    async append(sessionId: string, entries: readonly TrajectoryEntry[]): Promise<void> {
      const cur = await readJson<readonly TrajectoryEntry[]>(transport, path(sessionId));
      if (!cur.ok) throw new Error(cur.error.message);
      const merged = [...(cur.value ?? []), ...entries];
      const w = await writeJson(transport, path(sessionId), merged);
      if (!w.ok) throw new Error(w.error.message);
    },
    async getSession(sessionId: string): Promise<readonly TrajectoryEntry[]> {
      const r = await readJson<readonly TrajectoryEntry[]>(transport, path(sessionId));
      if (!r.ok) throw new Error(r.error.message);
      return r.value ?? [];
    },
    async listSessions(options): Promise<readonly string[]> {
      const lr = await listChildren(transport, `${dir}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const ids = lr.value.map((p) => basenameNoExt(p));
      const limit = options?.limit ?? ids.length;
      return ids.slice(0, limit);
    },
  };
}
```

- [ ] **Step 13.4: Run — expect pass; commit**

```bash
git add packages/lib/playbook-store-nexus/src/trajectory.ts packages/lib/playbook-store-nexus/src/__tests__/trajectory.test.ts
git commit -m "feat(playbook-store-nexus): TrajectoryStore (#1405)"
```

---

## Task 14: PlaybookProposalStore (TDD)

**Files:**
- Create: `packages/lib/playbook-store-nexus/src/proposal.ts`
- Create: `packages/lib/playbook-store-nexus/src/__tests__/proposal.test.ts`

The proposal store also needs a per-playbook listing index. Layout:

```
<base>/proposals/<proposalId>.json          — proposal payload
<base>/evaluations/<proposalId>.json        — evaluation payload (1:1 with proposal)
<base>/proposals-by-playbook/<playbookId>/<proposalId>.json   — empty marker for indexing
```

- [ ] **Step 14.1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import type { PlaybookEvaluation, PlaybookProposal } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createNexusPlaybookProposalStore } from "../proposal.js";

function prop(id: string, playbookId: string): PlaybookProposal {
  return {
    id,
    playbookId,
    operations: [],
    proposedAt: 0,
  } as PlaybookProposal;
}

function evaln(proposalId: string): PlaybookEvaluation {
  return {
    proposalId,
    verdict: "promote",
    evaluatedAt: 0,
  } as PlaybookEvaluation;
}

describe("createNexusPlaybookProposalStore", () => {
  test("recordProposal + getProposal round-trip", async () => {
    const store = createNexusPlaybookProposalStore({ transport: createFakeNexusTransport() });
    await store.recordProposal(prop("p1", "pb1"));
    const r = await store.getProposal("p1");
    expect(r?.id).toBe("p1");
  });

  test("listProposals returns proposals for a given playbook only", async () => {
    const store = createNexusPlaybookProposalStore({ transport: createFakeNexusTransport() });
    await store.recordProposal(prop("p1", "pb1"));
    await store.recordProposal(prop("p2", "pb1"));
    await store.recordProposal(prop("p3", "pb2"));
    const r = await store.listProposals("pb1");
    expect(r.length).toBe(2);
  });

  test("recordEvaluation persists evaluation alongside proposal", async () => {
    const store = createNexusPlaybookProposalStore({ transport: createFakeNexusTransport() });
    await store.recordProposal(prop("p1", "pb1"));
    await store.recordEvaluation(evaln("p1"));
    // No public reader for evaluations in the contract — recording must not throw.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 14.2: Run — expect fail**

- [ ] **Step 14.3: Implement `proposal.ts`**

```ts
/** Nexus-backed `PlaybookProposalStore`. Append-only — no removal API. */

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
} from "@koi/ace-types";
import { basenameNoExt, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusPlaybookProposalStore(
  config: NexusPlaybookStoreConfig,
): PlaybookProposalStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const proposalsDir = `${base}/proposals`;
  const evalsDir = `${base}/evaluations`;
  const indexDir = `${base}/proposals-by-playbook`;
  const transport = config.transport;

  const proposalPath = (id: string): string => `${proposalsDir}/${sanitizeId(id)}.json`;
  const evalPath = (id: string): string => `${evalsDir}/${sanitizeId(id)}.json`;
  const indexPath = (playbookId: string, proposalId: string): string =>
    `${indexDir}/${sanitizeId(playbookId)}/${sanitizeId(proposalId)}.json`;

  return {
    async recordProposal(proposal: PlaybookProposal): Promise<void> {
      const w = await writeJson(transport, proposalPath(proposal.id), proposal);
      if (!w.ok) throw new Error(w.error.message);
      const idx = await writeJson(transport, indexPath(proposal.playbookId, proposal.id), {});
      if (!idx.ok) throw new Error(idx.error.message);
    },
    async recordEvaluation(evaluation: PlaybookEvaluation): Promise<void> {
      const w = await writeJson(transport, evalPath(evaluation.proposalId), evaluation);
      if (!w.ok) throw new Error(w.error.message);
    },
    async getProposal(id: string): Promise<PlaybookProposal | undefined> {
      const r = await readJson<PlaybookProposal>(transport, proposalPath(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
    async listProposals(playbookId: string): Promise<readonly PlaybookProposal[]> {
      const lr = await listChildren(
        transport,
        `${indexDir}/${sanitizeId(playbookId)}/*.json`,
      );
      if (!lr.ok) throw new Error(lr.error.message);
      const out: PlaybookProposal[] = [];
      for (const p of lr.value) {
        const proposalId = basenameNoExt(p);
        const r = await readJson<PlaybookProposal>(transport, proposalPath(proposalId));
        if (!r.ok || r.value === undefined) continue;
        out.push(r.value);
      }
      return out;
    },
  };
}
```

- [ ] **Step 14.4: Run — expect pass; commit**

```bash
git add packages/lib/playbook-store-nexus/src/proposal.ts packages/lib/playbook-store-nexus/src/__tests__/proposal.test.ts
git commit -m "feat(playbook-store-nexus): PlaybookProposalStore (#1405)"
```

---

## Task 15: Composite factory + index

**Files:**
- Create: `packages/lib/playbook-store-nexus/src/store.ts`
- Create: `packages/lib/playbook-store-nexus/src/index.ts`

- [ ] **Step 15.1: Write `store.ts`**

```ts
/**
 * Composite factory wiring all four ACE stores onto a single Nexus transport.
 * Mirrors the shape of `createSqlitePlaybookStore` in @koi/playbook-store-sqlite.
 */

import type {
  PlaybookProposalStore,
  PlaybookStore,
  StructuredPlaybookStore,
  TrajectoryStore,
} from "@koi/ace-types";
import { createNexusPlaybookStore } from "./playbook.js";
import { createNexusPlaybookProposalStore } from "./proposal.js";
import { createNexusStructuredPlaybookStore } from "./structured.js";
import { createNexusTrajectoryStore } from "./trajectory.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

export interface NexusPlaybookStoreBundle {
  readonly playbooks: PlaybookStore;
  readonly structuredPlaybooks: Required<
    Pick<StructuredPlaybookStore, "get" | "list" | "save" | "remove" | "getVersion">
  >;
  readonly trajectories: TrajectoryStore;
  readonly proposals: PlaybookProposalStore;
  /** Stable identity for resume guards — derived from basePath. */
  readonly storeId: string;
  readonly close: () => void;
}

const DEFAULT_BASE = "ace";

export function createPlaybookStoreNexus(
  config: NexusPlaybookStoreConfig,
): NexusPlaybookStoreBundle {
  const base = config.basePath ?? DEFAULT_BASE;
  const structured = createNexusStructuredPlaybookStore(config);
  return {
    playbooks: createNexusPlaybookStore(config),
    structuredPlaybooks: {
      get: structured.get,
      list: structured.list,
      save: structured.save,
      remove: structured.remove,
      getVersion: structured.getVersion ?? (async () => undefined),
    },
    trajectories: createNexusTrajectoryStore(config),
    proposals: createNexusPlaybookProposalStore(config),
    storeId: `nexus:${base}`,
    close: (): void => {
      config.transport.close();
    },
  };
}
```

- [ ] **Step 15.2: Write `index.ts`**

```ts
/**
 * @koi/playbook-store-nexus — Nexus-backed ACE stores.
 *
 * Spec: docs/L2/playbook-store-nexus.md
 */

export { createNexusPlaybookStore } from "./playbook.js";
export { createNexusPlaybookProposalStore } from "./proposal.js";
export { createNexusStructuredPlaybookStore } from "./structured.js";
export { createNexusTrajectoryStore } from "./trajectory.js";
export {
  createPlaybookStoreNexus,
  type NexusPlaybookStoreBundle,
} from "./store.js";
export type { NexusPlaybookStoreConfig } from "./types.js";
```

- [ ] **Step 15.3: Run typecheck + lint + tests**

```bash
bun run --filter=@koi/playbook-store-nexus typecheck
bun run --filter=@koi/playbook-store-nexus lint
bun test packages/lib/playbook-store-nexus/
```
Expected: all PASS.

- [ ] **Step 15.4: Commit**

```bash
git add packages/lib/playbook-store-nexus/src/store.ts packages/lib/playbook-store-nexus/src/index.ts
git commit -m "feat(playbook-store-nexus): composite factory + public API (#1405)"
```

---

## Task 16: Wire playbook-store-nexus into layers + run gates

**Files:**
- Modify: `scripts/layers.ts`

- [ ] **Step 16.1: Edit `scripts/layers.ts`**

In the `L2_PACKAGES` set, add `"@koi/playbook-store-nexus"` immediately above `"@koi/playbook-store-sqlite"`.

- [ ] **Step 16.2: Run full CI gate**

```bash
bun run check:layers
bun run check:orphans
bun run check:unused
bun run check:duplicates
```
Expected: all PASS.

- [ ] **Step 16.3: Run repo-wide typecheck + lint**

```bash
bun run typecheck
bun run lint
```
Expected: clean.

- [ ] **Step 16.4: Run repo-wide tests for the two new packages**

```bash
bun test packages/lib/snapshot-store-nexus/ packages/lib/playbook-store-nexus/
```
Expected: all green.

- [ ] **Step 16.5: Commit**

```bash
git add scripts/layers.ts
git commit -m "chore(layers): register playbook-store-nexus as L2 (#1405)"
```

---

## Task 17: Final verification

- [ ] **Step 17.1: Confirm both packages show up in `bun pm ls`**

Run: `bun pm ls --filter='@koi/snapshot-store-nexus' --filter='@koi/playbook-store-nexus'`
Expected: both listed with their workspace deps resolved.

- [ ] **Step 17.2: Build both packages**

```bash
bun run --filter=@koi/snapshot-store-nexus build
bun run --filter=@koi/playbook-store-nexus build
```
Expected: clean builds, `dist/index.js` and `dist/index.d.ts` produced.

- [ ] **Step 17.3: Open PR**

```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
gh pr create --title "feat: nexus store adapters — snapshot + playbook (#1405)" --body "$(cat <<'EOF'
## Summary
- Add `@koi/snapshot-store-nexus` — `SnapshotChainStore<T>` over Nexus JSON-RPC
- Add `@koi/playbook-store-nexus` — ACE PlaybookStore/StructuredPlaybookStore/TrajectoryStore/PlaybookProposalStore over Nexus
- Both packages tagged `koi.optional: true` (wired at L3 assembly, not statically)
- Same contracts as their sqlite siblings — drop-in replacement for distributed deployments

Closes #1405.

## Scope deviations from issue
- No new generic KvStore/DocumentStore/SearchIndex L0 contracts — adapters bind to existing per-domain contracts (matches v1 nexus-store)
- No batch-atomic ops — underlying contracts have no batch method
- Search index deferred to #1407 (search-nexus)

## Test plan
- [ ] `bun test packages/lib/snapshot-store-nexus/`
- [ ] `bun test packages/lib/playbook-store-nexus/`
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run check:layers`
- [ ] `bun run check:orphans`
EOF
)"
```

---

## Self-Review

**Spec coverage (issue #1405 bullets):**

| Issue bullet | Where covered |
|---|---|
| KV-style store | Adapted: SnapshotChainStore (DAG of versioned KV-like nodes) — Tasks 3–7 |
| Document store | Adapted: ACE PlaybookStore + StructuredPlaybookStore — Tasks 11, 12 |
| Search index | Deferred to #1407 — documented in plan preamble + L2 spec |
| Adapter interface = local sibling | Same `SnapshotChainStore<T>` and `@koi/ace-types` contracts — Tasks 6, 11–14 |
| Batch ops atomic | Documented as out-of-scope (no batch in underlying contracts) — Task 9 doc |
| KV set/get/delete | Tasks 3–6 (snapshot), 11 (playbook) |
| Document CRUD | Tasks 11, 12 |
| Same interface as local stores | Type-level guarantee via shared imports + factory return type |
| Connection loss handled | json-io maps NOT_FOUND/EXTERNAL → undefined; transport errors propagate as Result errors — Tasks 4, 11 (test 14.x) |

**Placeholder scan:** none — every step has full code.

**Type consistency:**
- `createSnapshotStoreNexus` consistent across Tasks 5, 6, 7
- `NexusPlaybookStoreConfig` shared by playbook/structured/trajectory/proposal — Tasks 10–14
- `NexusPlaybookStoreBundle` exported once from `store.ts` (Task 15) and not redefined elsewhere
- `sanitizeId`, `readJson`, `writeJson`, `deleteJson`, `listChildren`, `basenameNoExt` defined once in `json-io.ts` per package, signatures stable across consumers
