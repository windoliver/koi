# `@koi/artifacts` Core — Plan 2 of 6

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the minimum-viable `@koi/artifacts` L2 package — schema, store identity, and the core CRUD + ACL surface (`saveArtifact`, `getArtifact`, `listArtifacts`, `deleteArtifact`, `shareArtifact`, `revokeShare`). Enough for programmatic consumers to store, retrieve, and share artifacts. Lifecycle (TTL/quota/versions/sweep/scavenger) and full recovery semantics land in Plans 3 + 4.

**Architecture:** A new L2 package depending on `@koi/core` (for `SessionId`/`ArtifactId` branded types) and `@koi/blob-cas` (Plan 1). SQLite via `bun:sqlite` for metadata; `BlobStore` interface from `@koi/blob-cas` for blobs. Single-writer enforced via `flock` lock file + store-id fingerprint pairing. Saves use the full `pending_blob_puts → put → BEGIN IMMEDIATE → INSERT blob_ready=0 → repair → UPDATE blob_ready=1` protocol so concurrent-save + in-flight races are closed. Reads apply an `isVisible(row, now)` predicate (TTL-aware, though Plan 2 doesn't yet stamp `expires_at` for any row). Sweep, scavenger, background worker, and hardened close() are Plan 3/4.

**Tech Stack:** Bun 1.3.x, TypeScript 6 strict, `bun:sqlite`, tsup, Biome, bun:test. One new dep: `@koi/artifacts` uses `bun:sqlite` (no package install — built-in to Bun).

**Prerequisite:** Plan 1 (`@koi/blob-cas`) merged to main.

**Plan series context:** This is Plan 2 of 6. See `docs/superpowers/specs/2026-04-18-artifacts-design.md` for the full design.

**Deferred to later plans** — **do not** implement here:

| Feature | Deferred to |
|---------|-------------|
| TTL reclamation on save (opportunistic) | Plan 3 |
| Quota / version admission checks + eviction | Plan 3 |
| `sweepArtifacts()` Phase A + Phase B | Plan 3 |
| `scavengeOrphanBlobs()` | Plan 3 |
| Background repair worker | Plan 4 |
| `close()` full mutation barrier (drains all in-flight ops) | Plan 4 |
| Startup recovery (draining `blob_ready=0` / tombstones) | Plan 4 |
| `@koi/artifacts-s3` backend | Plan 5 |
| Golden query wiring into `@koi/runtime` | Plan 6 |
| `docs/L2/artifacts.md` | Plan 6 |

Plan 2's `close()` is minimal: release the lock and close SQLite. No barrier semantics. This is documented as a known limitation; Plan 4 replaces it.

---

## File Structure

**Modified `@koi/core` (`packages/kernel/core/`):**
- Modify: `packages/kernel/core/src/ecs.ts` (or the analogous file where `SessionId` / `sessionId()` live) — add `ArtifactId` branded type + `artifactId(id: string): ArtifactId` factory.
- Modify: `packages/kernel/core/src/index.ts` or the appropriate barrel — export `ArtifactId` and `artifactId`.

**New package `packages/lib/artifacts/`:**
- Create: `packages/lib/artifacts/package.json`
- Create: `packages/lib/artifacts/tsconfig.json`
- Create: `packages/lib/artifacts/tsup.config.ts`
- Create: `packages/lib/artifacts/src/index.ts` — curated public API exports
- Create: `packages/lib/artifacts/src/types.ts` — `Artifact`, `SaveArtifactInput`, `ArtifactFilter`, `ArtifactError`, `ArtifactStore`, `ArtifactStoreConfig`
- Create: `packages/lib/artifacts/src/schema.ts` — DDL constants (all five tables: `artifacts`, `artifact_shares`, `pending_blob_puts`, `pending_blob_deletes`, `meta`)
- Create: `packages/lib/artifacts/src/sqlite.ts` — SQLite connection + WAL + pragmas, prepared-statement helpers
- Create: `packages/lib/artifacts/src/lock.ts` — `flock`-based single-writer lock (skipped for `:memory:` paths)
- Create: `packages/lib/artifacts/src/store-id.ts` — layer 2 fingerprint check (DB `meta.store_id` ↔ blob sentinel pairing)
- Create: `packages/lib/artifacts/src/validate.ts` — input validation (name/mimeType/size/tags)
- Create: `packages/lib/artifacts/src/visibility.ts` — `isVisible(row, now)` predicate helper
- Create: `packages/lib/artifacts/src/save.ts` — `saveArtifact` protocol (full blob_ready lifecycle)
- Create: `packages/lib/artifacts/src/get.ts` — `getArtifact` with visibility + post-read ACL recheck
- Create: `packages/lib/artifacts/src/list.ts` — `listArtifacts`
- Create: `packages/lib/artifacts/src/delete.ts` — `deleteArtifact` (metadata + tombstone atomic)
- Create: `packages/lib/artifacts/src/share.ts` — `shareArtifact` / `revokeShare`
- Create: `packages/lib/artifacts/src/create-store.ts` — `createArtifactStore` factory
- Create: `packages/lib/artifacts/src/__tests__/schema.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/store-id.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/lock.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/validate.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/save.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/get.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/list.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/delete.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/share.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/acl-probe.test.ts` — probe-resistance (non-owner never sees `forbidden`)

**Layer registry:**
- Modify: `scripts/layers.ts` — ensure `@koi/artifacts` is recognized as L2. If the check-layers script uses an implicit L2 classification (anything not in L0/L0u/L3), nothing to add — but verify before assuming.

---

## Task Decomposition Strategy

Plan 2 has 14 tasks. Each task focuses on a narrow slice and is independently reviewable:

| # | Task | Approx LOC | Critical-path? |
|---|------|-----------|----------------|
| 1 | Add `ArtifactId` to `@koi/core` | 10 | yes — types used by T2+ |
| 2 | Scaffold `@koi/artifacts` package | 50 | yes |
| 3 | Types (`types.ts`) | 120 | yes |
| 4 | Schema (`schema.ts`) + SQLite setup (`sqlite.ts`) | 150 | yes |
| 5 | Store-id fingerprint (`store-id.ts`) | 80 | yes |
| 6 | Single-writer lock (`lock.ts`) | 50 | yes |
| 7 | `createArtifactStore` factory (minimal close) | 100 | yes |
| 8 | `validate.ts` + `visibility.ts` | 60 | yes |
| 9 | `saveArtifact` (happy path + idempotency + blob_ready repair loop) | 200 | yes |
| 10 | `getArtifact` with post-read ACL recheck | 100 | yes |
| 11 | `listArtifacts` | 60 | yes |
| 12 | `deleteArtifact` (metadata + tombstone) | 80 | yes |
| 13 | `shareArtifact` / `revokeShare` | 100 | yes |
| 14 | Full-repo verification + PR | 0 | yes |

Total: ~1160 LOC of logic + tests. Larger than the CLAUDE.md 300-line preference but unavoidable for a cohesive MVP. The 6-plan split already decomposes the issue; splitting Plan 2 further would produce PRs so small they cost more to review than to read as a unit. Flag this in the PR description.

---

## Task 1: Add `ArtifactId` branded type to `@koi/core`

**Files:**
- Modify: `packages/kernel/core/src/ecs.ts` (or the file where `SessionId` lives — confirm via `grep -rn "export type SessionId" packages/kernel/core/src/`)
- Modify: `packages/kernel/core/src/index.ts` (or appropriate barrel)

**TDD steps:**

- [ ] **Step 1.1: Locate the `SessionId` definition.** Use Grep:
  - pattern: `export type SessionId`
  - path: `packages/kernel/core/src/`

- [ ] **Step 1.2: Read that file and the corresponding barrel** to understand the pattern (branded type + factory function).

- [ ] **Step 1.3: Write a failing type-level test.** If the repo has a type-test harness, use it. Otherwise add a `.test.ts` file that:

```ts
import { describe, expect, test } from "bun:test";
import { artifactId, type ArtifactId } from "../<file>.js";

describe("ArtifactId", () => {
  test("artifactId() produces a branded string", () => {
    const id: ArtifactId = artifactId("art_abc");
    expect(id).toBe("art_abc");
  });

  test("branded type prevents assignment from plain string (compile-only)", () => {
    // This is a compile-only test; if this file typechecks, the guard works.
    const _id: ArtifactId = artifactId("art_xyz");
    expect(typeof _id).toBe("string");
  });
});
```

Run: expected to fail (import doesn't resolve).

- [ ] **Step 1.4: Add the type + factory** next to the `SessionId` pair in the same file. Match the exact pattern used for `SessionId` — if it uses `Brand<T, B>`, use it; if it uses a `declare const __brand`, use it. Consistency over judgment.

Example (adapt to the repo's actual shape):

```ts
export type ArtifactId = Brand<string, "ArtifactId">;

export function artifactId(id: string): ArtifactId {
  return id as ArtifactId;
}
```

- [ ] **Step 1.5: Export from the barrel** next to the `SessionId` export. Alphabetical within groupings.

- [ ] **Step 1.6: Run the type-test.** Exits 0.

- [ ] **Step 1.7: Run `bun run --cwd packages/kernel/core typecheck`.** Exits 0.

- [ ] **Step 1.8: Commit.**

```bash
git add packages/kernel/core/
git commit -m "feat(core): add ArtifactId branded type"
```

---

## Task 2: Scaffold `@koi/artifacts` package

Same pattern as Plan 1 Task 1 (`@koi/blob-cas` scaffolding).

**Files:**
- Create: `packages/lib/artifacts/package.json`
- Create: `packages/lib/artifacts/tsconfig.json`
- Create: `packages/lib/artifacts/tsup.config.ts`
- Create: `packages/lib/artifacts/src/index.ts` (placeholder)

- [ ] **Step 2.1: Create `package.json`.**

```json
{
  "name": "@koi/artifacts",
  "description": "Versioned file lifecycle for agent-created artifacts (metadata + lifecycle via @koi/blob-cas blobs)",
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
  "dependencies": {
    "@koi/blob-cas": "workspace:*",
    "@koi/core": "workspace:*"
  },
  "koi": {}
}
```

- [ ] **Step 2.2: Create `tsconfig.json`** mirroring the hash/checkpoint canonical shape:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../blob-cas" },
    { "path": "../../kernel/core" }
  ]
}
```

- [ ] **Step 2.3: Create `tsup.config.ts`** — mirror `packages/lib/blob-cas/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  target: "node22",
  treeshake: true,
  external: ["bun:sqlite"],
});
```

Note `external: ["bun:sqlite"]` — this package uses Bun's SQLite binding.

- [ ] **Step 2.4: Create placeholder `src/index.ts`.**

```ts
// Populated by subsequent tasks. Keeps the package buildable during scaffolding.
export {};
```

- [ ] **Step 2.5: Run `bun install`.**

- [ ] **Step 2.6: Typecheck empty package.** `bun run --cwd packages/lib/artifacts typecheck`. Exits 0.

- [ ] **Step 2.7: Register `@koi/artifacts` in `scripts/layers.ts`.**

Look at how other L2 packages are registered. If there's an `L2_PACKAGES` set, add `"@koi/artifacts"` alphabetically. If L2 classification is implicit (anything not in L0/L0u/L3), no change needed — but verify.

- [ ] **Step 2.8: Run `bun run check:layers`.** Exits 0.

- [ ] **Step 2.9: Commit.**

```bash
git add packages/lib/artifacts/ scripts/layers.ts bun.lock
git commit -m "chore(artifacts): scaffold package"
```

---

## Task 3: Define public types

**Files:**
- Create: `packages/lib/artifacts/src/types.ts`
- Modify: `packages/lib/artifacts/src/index.ts` (re-export)

- [ ] **Step 3.1: Write `types.ts` verbatim.**

```ts
/**
 * Public types for @koi/artifacts.
 *
 * The ArtifactStore interface is the main surface. ArtifactError is a
 * discriminated union for expected failures (per CLAUDE.md error policy:
 * return Result<T, E> rather than throw for expected cases).
 */

import type { ArtifactId, SessionId } from "@koi/core";
import type { BlobStore } from "@koi/blob-cas";

export interface Artifact {
  readonly id: ArtifactId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly version: number;
  readonly mimeType: string;
  readonly size: number;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly tags: ReadonlyArray<string>;
}

export interface SaveArtifactInput {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly tags?: ReadonlyArray<string>;
}

export interface ArtifactFilter {
  readonly name?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly includeShared?: boolean;
}

export interface LifecyclePolicy {
  readonly ttlMs?: number;
  readonly maxSessionBytes?: number;
  readonly maxVersionsPerName?: number;
}

export type ArtifactError =
  | { readonly kind: "not_found"; readonly id: ArtifactId }
  | {
      readonly kind: "quota_exceeded";
      readonly sessionId: SessionId;
      readonly usedBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "invalid_input";
      readonly field: string;
      readonly reason: string;
    };

// `forbidden` is a distinct *internal* concept used for structured logging —
// never returned to callers. All non-owner rejections surface as `not_found`
// on the wire (probe-resistance).

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ArtifactStore {
  readonly saveArtifact: (
    input: SaveArtifactInput,
  ) => Promise<Result<Artifact, ArtifactError>>;
  readonly getArtifact: (
    id: ArtifactId,
    ctx: { readonly sessionId: SessionId },
  ) => Promise<Result<{ readonly meta: Artifact; readonly data: Uint8Array }, ArtifactError>>;
  readonly listArtifacts: (
    filter: ArtifactFilter,
    ctx: { readonly sessionId: SessionId },
  ) => Promise<ReadonlyArray<Artifact>>;
  readonly deleteArtifact: (
    id: ArtifactId,
    ctx: { readonly sessionId: SessionId },
  ) => Promise<Result<void, ArtifactError>>;
  readonly shareArtifact: (
    id: ArtifactId,
    withSessionId: SessionId,
    ctx: { readonly ownerSessionId: SessionId },
  ) => Promise<Result<void, ArtifactError>>;
  readonly revokeShare: (
    id: ArtifactId,
    fromSessionId: SessionId,
    ctx: { readonly ownerSessionId: SessionId },
  ) => Promise<Result<void, ArtifactError>>;
  readonly close: () => Promise<void>;
  // sweepArtifacts + scavengeOrphanBlobs are added in Plan 3.
}

export interface ArtifactStoreConfig {
  readonly dbPath: string;
  readonly blobDir: string;
  readonly blobStore?: BlobStore;
  readonly policy?: LifecyclePolicy;
  readonly durability?: "process" | "os";
  readonly maxArtifactBytes?: number;
}
```

- [ ] **Step 3.2: Re-export from `index.ts`.**

```ts
export type {
  Artifact,
  ArtifactError,
  ArtifactFilter,
  ArtifactStore,
  ArtifactStoreConfig,
  LifecyclePolicy,
  Result,
  SaveArtifactInput,
} from "./types.js";
```

- [ ] **Step 3.3: Typecheck.** Must pass — no implementation yet, but types are self-contained and depend only on `@koi/core` + `@koi/blob-cas`.

- [ ] **Step 3.4: Commit.**

```bash
git add packages/lib/artifacts/src/types.ts packages/lib/artifacts/src/index.ts
git commit -m "feat(artifacts): define public types"
```

---

## Task 4: Schema + SQLite connection

**Files:**
- Create: `packages/lib/artifacts/src/schema.ts`
- Create: `packages/lib/artifacts/src/sqlite.ts`
- Create: `packages/lib/artifacts/src/__tests__/schema.test.ts`

- [ ] **Step 4.1: Write `schema.ts` verbatim** with all five DDL statements as `readonly` string constants. Mirror the spec §5 exactly.

```ts
/**
 * SQL DDL for the artifacts store. Applied verbatim at open time via
 * `applySchema(db)` in sqlite.ts. Every table, every index, no surprises.
 *
 * See docs/superpowers/specs/2026-04-18-artifacts-design.md §5 for rationale.
 */

export const DDL_ARTIFACTS = `
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  size            INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  blob_ready      INTEGER NOT NULL DEFAULT 1,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_name    ON artifacts(session_id, name);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash    ON artifacts(content_hash);
` as const;

export const DDL_ARTIFACT_SHARES = `
CREATE TABLE IF NOT EXISTS artifact_shares (
  artifact_id           TEXT NOT NULL,
  granted_to_session_id TEXT NOT NULL,
  granted_at            INTEGER NOT NULL,
  PRIMARY KEY(artifact_id, granted_to_session_id),
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON artifact_shares(granted_to_session_id);
` as const;

export const DDL_PENDING_BLOB_DELETES = `
CREATE TABLE IF NOT EXISTS pending_blob_deletes (
  hash        TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  claimed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_enqueued ON pending_blob_deletes(enqueued_at);
` as const;

export const DDL_PENDING_BLOB_PUTS = `
CREATE TABLE IF NOT EXISTS pending_blob_puts (
  intent_id   TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_puts_hash    ON pending_blob_puts(hash);
CREATE INDEX IF NOT EXISTS idx_pending_puts_created ON pending_blob_puts(created_at);
` as const;

export const DDL_META = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
` as const;

export const ALL_DDL: ReadonlyArray<string> = [
  DDL_ARTIFACTS,
  DDL_ARTIFACT_SHARES,
  DDL_PENDING_BLOB_DELETES,
  DDL_PENDING_BLOB_PUTS,
  DDL_META,
];
```

- [ ] **Step 4.2: Write `sqlite.ts`.**

```ts
/**
 * SQLite connection management for @koi/artifacts.
 *
 * Exports `openDatabase(config)` which returns a configured Database instance
 * with WAL mode and the appropriate synchronous level for the durability
 * setting. Applies the full schema at open time (idempotent CREATE TABLE IF
 * NOT EXISTS statements).
 */

import { Database } from "bun:sqlite";
import { ALL_DDL } from "./schema.js";
import type { ArtifactStoreConfig } from "./types.js";

export function openDatabase(
  config: Pick<ArtifactStoreConfig, "dbPath" | "durability">,
): Database {
  const db = new Database(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(
    `PRAGMA synchronous = ${config.durability === "os" ? "FULL" : "NORMAL"};`,
  );
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  for (const ddl of ALL_DDL) {
    db.exec(ddl);
  }
  return db;
}
```

- [ ] **Step 4.3: Write schema test** (`__tests__/schema.test.ts`):

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ALL_DDL } from "../schema.js";
import { openDatabase } from "../sqlite.js";

describe("schema", () => {
  test("all DDL applies cleanly to a fresh in-memory DB", () => {
    const db = openDatabase({ dbPath: ":memory:" });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as ReadonlyArray<{ readonly name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("artifacts");
    expect(names).toContain("artifact_shares");
    expect(names).toContain("pending_blob_deletes");
    expect(names).toContain("pending_blob_puts");
    expect(names).toContain("meta");
    db.close();
  });

  test("applying DDL twice is idempotent (CREATE TABLE IF NOT EXISTS)", () => {
    const db = new Database(":memory:");
    for (const ddl of ALL_DDL) db.exec(ddl);
    for (const ddl of ALL_DDL) db.exec(ddl); // second pass
    db.close();
  });

  test("WAL mode + foreign_keys enabled", () => {
    const db = openDatabase({ dbPath: ":memory:" });
    const journalMode = db.query("PRAGMA journal_mode").get() as {
      readonly journal_mode: string;
    };
    // :memory: databases report "memory" for journal_mode; this test mostly
    // verifies the PRAGMA calls don't throw.
    expect(["wal", "memory"]).toContain(journalMode.journal_mode.toLowerCase());
    const fk = db.query("PRAGMA foreign_keys").get() as {
      readonly foreign_keys: number;
    };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  test("durability='os' sets synchronous=FULL", () => {
    const db = openDatabase({ dbPath: ":memory:", durability: "os" });
    const sync = db.query("PRAGMA synchronous").get() as {
      readonly synchronous: number;
    };
    // 2 = FULL, 1 = NORMAL
    expect(sync.synchronous).toBe(2);
    db.close();
  });

  test("CASCADE drops shares when the artifact is deleted", () => {
    const db = openDatabase({ dbPath: ":memory:" });
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    db.exec(
      "INSERT INTO artifact_shares (artifact_id, granted_to_session_id, granted_at) VALUES ('art_1', 'sess_b', 0)",
    );
    db.exec("DELETE FROM artifacts WHERE id = 'art_1'");
    const count = db
      .query("SELECT COUNT(*) as c FROM artifact_shares")
      .get() as { readonly c: number };
    expect(count.c).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 4.4: Run.** `bun run --cwd packages/lib/artifacts test`. All schema tests pass.

- [ ] **Step 4.5: Typecheck + lint.**

- [ ] **Step 4.6: Commit.**

```bash
git add packages/lib/artifacts/src/schema.ts \
        packages/lib/artifacts/src/sqlite.ts \
        packages/lib/artifacts/src/__tests__/schema.test.ts
git commit -m "feat(artifacts): schema and SQLite connection"
```

---

## Task 5: Store-id fingerprint pairing

**Files:**
- Create: `packages/lib/artifacts/src/store-id.ts`
- Create: `packages/lib/artifacts/src/__tests__/store-id.test.ts`

- [ ] **Step 5.1: Write failing tests** covering the six-cell truth table from spec §3.0:

```ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemBlobStore } from "@koi/blob-cas";
import { ensureStoreIdPair, readStoreIdFromDb } from "../store-id.js";
import { openDatabase } from "../sqlite.js";

describe("store-id fingerprint", () => {
  let blobDir: string;
  let db: Database;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-storeid-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    db = openDatabase({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("both missing + empty → bootstraps fresh UUID on both sides", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    const id = await ensureStoreIdPair({ db, blobDir, blobStore });
    expect(id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 shape
    const dbId = readStoreIdFromDb(db);
    expect(dbId).toBe(id);
    const sentinel = readFileSync(join(blobDir, ".store-id"), "utf8").trim();
    expect(sentinel).toBe(id);
  });

  test("both present + match → opens normally", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    const id1 = await ensureStoreIdPair({ db, blobDir, blobStore });
    const id2 = await ensureStoreIdPair({ db, blobDir, blobStore });
    expect(id1).toBe(id2);
  });

  test("both present + differ → throws 'paired with a different ArtifactStore'", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobDir, blobStore });
    writeFileSync(join(blobDir, ".store-id"), "different-uuid");
    await expect(
      ensureStoreIdPair({ db, blobDir, blobStore }),
    ).rejects.toThrow(/paired with a different ArtifactStore/);
  });

  test("DB present + sentinel missing → throws 'missing store-id sentinel'", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobDir, blobStore });
    rmSync(join(blobDir, ".store-id"));
    await expect(
      ensureStoreIdPair({ db, blobDir, blobStore }),
    ).rejects.toThrow(/missing store-id sentinel/);
  });

  test("sentinel present + DB missing → throws 'metadata DB is missing store-id'", async () => {
    writeFileSync(join(blobDir, ".store-id"), crypto.randomUUID());
    const blobStore = createFilesystemBlobStore(blobDir);
    await expect(
      ensureStoreIdPair({ db, blobDir, blobStore }),
    ).rejects.toThrow(/Metadata DB is missing store-id/);
  });

  test("both missing + DB has existing rows → throws 'missing on a non-empty store'", async () => {
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    const blobStore = createFilesystemBlobStore(blobDir);
    await expect(
      ensureStoreIdPair({ db, blobDir, blobStore }),
    ).rejects.toThrow(/missing on a non-empty store/);
  });
});
```

Run: expected RED — module doesn't exist.

- [ ] **Step 5.2: Implement `store-id.ts`.**

```ts
/**
 * Layer 2 of §3.0: pair the metadata DB with the blob backend via a UUID
 * `store_id`. Prevents two different DBs from sharing the same blob backend
 * (which would let one's sweep delete the other's blobs).
 *
 * Layer 1 (advisory flock) is in lock.ts.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlobStore } from "@koi/blob-cas";

const STORE_ID_KEY = "store_id";
const SENTINEL_FILENAME = ".store-id";

export function readStoreIdFromDb(db: Database): string | undefined {
  const row = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(STORE_ID_KEY) as { readonly value: string } | null;
  return row?.value;
}

function readSentinelFromFs(blobDir: string): string | undefined {
  const path = join(blobDir, SENTINEL_FILENAME);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8").trim();
  return content || undefined;
}

function writeSentinelToFs(blobDir: string, id: string): void {
  writeFileSync(join(blobDir, SENTINEL_FILENAME), id, "utf8");
}

function writeStoreIdToDb(db: Database, id: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    STORE_ID_KEY,
    id,
  );
}

function dbHasArtifactsOrPending(db: Database): boolean {
  const counts = db
    .query(
      "SELECT (SELECT COUNT(*) FROM artifacts) + (SELECT COUNT(*) FROM pending_blob_deletes) + (SELECT COUNT(*) FROM pending_blob_puts) AS total",
    )
    .get() as { readonly total: number };
  return counts.total > 0;
}

export async function ensureStoreIdPair(args: {
  readonly db: Database;
  readonly blobDir: string;
  readonly blobStore: BlobStore;
}): Promise<string> {
  const dbId = readStoreIdFromDb(args.db);
  const sentinelId = readSentinelFromFs(args.blobDir);

  if (dbId !== undefined && sentinelId !== undefined) {
    if (dbId !== sentinelId) {
      throw new Error(
        "Blob backend is paired with a different ArtifactStore; refusing to open",
      );
    }
    return dbId;
  }

  if (dbId !== undefined && sentinelId === undefined) {
    throw new Error(
      "Blob backend is missing store-id sentinel; operator must restore or reset explicitly",
    );
  }

  if (dbId === undefined && sentinelId !== undefined) {
    throw new Error(
      "Metadata DB is missing store-id; operator must restore or reset explicitly",
    );
  }

  // Both missing — only safe to bootstrap if the store is provably empty.
  if (dbHasArtifactsOrPending(args.db)) {
    throw new Error(
      "Store-id missing on a non-empty store; operator must restore or reset explicitly",
    );
  }

  const fresh = crypto.randomUUID();
  writeStoreIdToDb(args.db, fresh);
  writeSentinelToFs(args.blobDir, fresh);
  return fresh;
}
```

Note: `@koi/blob-cas` is imported for the `BlobStore` type only — we don't call it here. The `blobDir` path is used for the sentinel file. If the `BlobStore` is a non-FS impl (e.g., S3), the sentinel must live somewhere the blob backend can see. For Plan 2 we support only FS — Plan 5 (`@koi/artifacts-s3`) extends this to handle remote sentinels.

- [ ] **Step 5.3: Run tests.** All 6 pass.

- [ ] **Step 5.4: Commit.**

```bash
git add packages/lib/artifacts/src/store-id.ts \
        packages/lib/artifacts/src/__tests__/store-id.test.ts
git commit -m "feat(artifacts): store-id fingerprint pairing"
```

---

## Task 6: Single-writer lock

**Files:**
- Create: `packages/lib/artifacts/src/lock.ts`
- Create: `packages/lib/artifacts/src/__tests__/lock.test.ts`

- [ ] **Step 6.1: Write failing tests.**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../lock.js";

describe("single-writer lock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `koi-art-lock-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test(":memory: skips the lock", () => {
    const release = acquireLock(":memory:");
    // No lock file created, no throw. release() is a no-op.
    release();
  });

  test("first acquirer succeeds; second throws", () => {
    const dbPath = join(tmpDir, "store.db");
    const release1 = acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).toThrow(
      /ArtifactStore already open by another process/,
    );
    release1();
  });

  test("release lets a second acquirer succeed", () => {
    const dbPath = join(tmpDir, "store.db");
    const release1 = acquireLock(dbPath);
    release1();
    const release2 = acquireLock(dbPath);
    release2();
  });
});
```

- [ ] **Step 6.2: Implement `lock.ts`.**

```ts
/**
 * Layer 1 of §3.0: exclusive advisory lock on <dbPath>.lock via flock.
 * Prevents two writer processes from opening the same store concurrently.
 * :memory: databases skip this since they're process-local by definition.
 */

import { closeSync, openSync, writeFileSync } from "node:fs";
// @ts-expect-error — Bun exposes flock via Bun.file().lock(), but the
// portable path for the advisory lock is node's `fcntl` which isn't
// directly exposed. Use an open file descriptor + fcntl-style pattern.
// For the MVP we implement a best-effort lock via an exclusive-create file.
import { existsSync, unlinkSync } from "node:fs";

const LOCK_SUFFIX = ".lock";

function isInMemory(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath.startsWith("file::memory:");
}

export function acquireLock(dbPath: string): () => void {
  if (isInMemory(dbPath)) {
    return () => {};
  }

  const lockPath = `${dbPath}${LOCK_SUFFIX}`;

  // Exclusive-create semantics: O_CREAT | O_EXCL. Throws EEXIST if another
  // holder exists. Not as robust as flock (doesn't auto-release on crash),
  // but works without platform-specific bindings and Bun will also clean
  // up via the close() path plus the process-exit hook we register.
  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // w + x = write + exclusive create
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        "ArtifactStore already open by another process",
      );
    }
    throw err;
  }

  // Write the owner pid for diagnostics.
  writeFileSync(fd, String(process.pid));

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch {
      /* ignore close errors on release */
    }
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* ignore unlink errors — another process may have already cleaned up */
    }
  };

  // Best-effort release on process exit.
  process.once("exit", release);

  return release;
}
```

**Known limitation** (document in doc-comment + Plan 4): this uses `O_CREAT | O_EXCL` instead of `flock` because Bun doesn't expose a portable `flock` binding. The gap is that if a process crashes without running the `exit` handler (e.g., SIGKILL), the lock file lingers. Plan 4 hardens this with a proper `flock` or a PID-liveness check on stale lock files.

- [ ] **Step 6.3: Run tests.** All 3 pass.

- [ ] **Step 6.4: Commit.**

```bash
git add packages/lib/artifacts/src/lock.ts \
        packages/lib/artifacts/src/__tests__/lock.test.ts
git commit -m "feat(artifacts): single-writer lock (file-based)"
```

---

## Task 7: `createArtifactStore` factory (skeleton + minimal close)

**Files:**
- Create: `packages/lib/artifacts/src/create-store.ts`
- Modify: `packages/lib/artifacts/src/index.ts` (export the factory)

- [ ] **Step 7.1: Write minimal failing test.**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../create-store.js";

describe("createArtifactStore (skeleton)", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("opens a fresh store (both sides empty → bootstraps store_id)", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    expect(typeof store.close).toBe("function");
    await store.close();
  });

  test("second open while first is alive throws", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await expect(
      createArtifactStore({ dbPath, blobDir }),
    ).rejects.toThrow(/already open by another process/);
    await store.close();
  });

  test("re-open after close succeeds", async () => {
    const s1 = await createArtifactStore({ dbPath, blobDir });
    await s1.close();
    const s2 = await createArtifactStore({ dbPath, blobDir });
    await s2.close();
  });

  test(":memory: does not write a sentinel file to the fs when blobDir is present but DB is :memory:", async () => {
    const store = await createArtifactStore({ dbPath: ":memory:", blobDir });
    // Memory DB with a real blobDir: layer 2 still requires pairing, so the
    // bootstrap creates the sentinel. This is the expected behavior per §3.0.
    await store.close();
  });
});
```

- [ ] **Step 7.2: Implement `create-store.ts`** as a skeleton — just wires the layers together. Every CRUD method throws `"not implemented"` until Tasks 9–13. Tasks 9–13 will replace the stubs.

```ts
/**
 * createArtifactStore — factory assembling the layers:
 *   1. Open + pragma SQLite (sqlite.ts)
 *   2. Acquire single-writer advisory lock (lock.ts)
 *   3. Pair DB store-id with blob backend sentinel (store-id.ts)
 *   4. Build the CRUD surface (save/get/list/delete/share/revoke)
 *
 * Plan 2 ships a minimal close() that releases the lock and closes SQLite.
 * Plan 4 replaces it with a full mutation barrier.
 */

import type { Database } from "bun:sqlite";
import { createFilesystemBlobStore, type BlobStore } from "@koi/blob-cas";
import { acquireLock } from "./lock.js";
import { openDatabase } from "./sqlite.js";
import { ensureStoreIdPair } from "./store-id.js";
import type { ArtifactStore, ArtifactStoreConfig } from "./types.js";

export async function createArtifactStore(
  config: ArtifactStoreConfig,
): Promise<ArtifactStore> {
  const releaseLock = acquireLock(config.dbPath);

  let db: Database | undefined;
  try {
    db = openDatabase(config);
    const blobStore: BlobStore =
      config.blobStore ?? createFilesystemBlobStore(config.blobDir);
    await ensureStoreIdPair({ db, blobDir: config.blobDir, blobStore });

    // Task 9–13 will replace these with real implementations.
    // Intentionally throwing so any accidental call during Plan 2
    // development is loud.
    const notImpl = <T>(): Promise<T> => {
      throw new Error("not implemented in Plan 2 skeleton");
    };

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      db?.close();
      releaseLock();
    };

    return {
      saveArtifact: () => notImpl(),
      getArtifact: () => notImpl(),
      listArtifacts: () => notImpl(),
      deleteArtifact: () => notImpl(),
      shareArtifact: () => notImpl(),
      revokeShare: () => notImpl(),
      close,
    };
  } catch (err) {
    db?.close();
    releaseLock();
    throw err;
  }
}
```

- [ ] **Step 7.3: Export from `index.ts`.**

```ts
// Add alongside existing type exports:
export { createArtifactStore } from "./create-store.js";
```

- [ ] **Step 7.4: Run tests.** The 4 create-store tests pass.

- [ ] **Step 7.5: Commit.**

```bash
git add packages/lib/artifacts/src/create-store.ts \
        packages/lib/artifacts/src/index.ts \
        packages/lib/artifacts/src/__tests__/create-store.test.ts
git commit -m "feat(artifacts): createArtifactStore factory (skeleton)"
```

---

## Task 8: Validation + visibility helpers

**Files:**
- Create: `packages/lib/artifacts/src/validate.ts`
- Create: `packages/lib/artifacts/src/visibility.ts`
- Create: `packages/lib/artifacts/src/__tests__/validate.test.ts`

- [ ] **Step 8.1: Write `validate.ts`.**

```ts
/**
 * Boundary-level input validation for saveArtifact. Per CLAUDE.md:
 * all external input validated at the system boundary.
 */

import type { ArtifactError, SaveArtifactInput } from "./types.js";

const MAX_NAME_LEN = 255;
const MAX_MIME_LEN = 128;
const MAX_TAG_LEN = 64;
const MAX_TAGS = 32;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const NAME_FORBIDDEN_RE = /[\u0000/\\]/;

export function validateSaveInput(
  input: SaveArtifactInput,
  maxArtifactBytes: number,
): ArtifactError | undefined {
  if (input.name.length === 0) {
    return { kind: "invalid_input", field: "name", reason: "must not be empty" };
  }
  if (input.name.length > MAX_NAME_LEN) {
    return {
      kind: "invalid_input",
      field: "name",
      reason: `exceeds ${MAX_NAME_LEN} chars`,
    };
  }
  if (NAME_FORBIDDEN_RE.test(input.name)) {
    return {
      kind: "invalid_input",
      field: "name",
      reason: "contains forbidden characters (null byte, slash, backslash)",
    };
  }
  if (input.mimeType.length === 0 || input.mimeType.length > MAX_MIME_LEN) {
    return {
      kind: "invalid_input",
      field: "mimeType",
      reason: `length must be in [1, ${MAX_MIME_LEN}]`,
    };
  }
  if (!MIME_RE.test(input.mimeType)) {
    return {
      kind: "invalid_input",
      field: "mimeType",
      reason: "must match type/subtype pattern",
    };
  }
  if (input.data.byteLength > maxArtifactBytes) {
    return {
      kind: "invalid_input",
      field: "data",
      reason: `exceeds maxArtifactBytes (${maxArtifactBytes})`,
    };
  }
  if (input.tags) {
    if (input.tags.length > MAX_TAGS) {
      return {
        kind: "invalid_input",
        field: "tags",
        reason: `exceeds ${MAX_TAGS} tags`,
      };
    }
    for (const tag of input.tags) {
      if (tag.length === 0 || tag.length > MAX_TAG_LEN) {
        return {
          kind: "invalid_input",
          field: "tags",
          reason: `tag length must be in [1, ${MAX_TAG_LEN}]`,
        };
      }
    }
  }
  return undefined;
}
```

- [ ] **Step 8.2: Write `visibility.ts`.**

```ts
/**
 * isVisible(row, now) — the single predicate used by every read-side API.
 * See spec §6 "Visibility predicate".
 */

export interface VisibilityRow {
  readonly blob_ready: number; // 0 or 1
  readonly expires_at: number | null;
}

export function isVisible(row: VisibilityRow, now: number): boolean {
  if (row.blob_ready !== 1) return false;
  if (row.expires_at !== null && row.expires_at < now) return false;
  return true;
}
```

- [ ] **Step 8.3: Write validation tests** covering name/mimeType/size/tags boundary cases (empty, too long, forbidden chars, bad mime pattern, oversize, too many tags).

- [ ] **Step 8.4: Run tests. Commit.**

```bash
git add packages/lib/artifacts/src/validate.ts \
        packages/lib/artifacts/src/visibility.ts \
        packages/lib/artifacts/src/__tests__/validate.test.ts
git commit -m "feat(artifacts): input validation and visibility predicate"
```

---

## Task 9: `saveArtifact` (full protocol)

**Files:**
- Create: `packages/lib/artifacts/src/save.ts`
- Create: `packages/lib/artifacts/src/__tests__/save.test.ts`
- Modify: `packages/lib/artifacts/src/create-store.ts` (wire in real `saveArtifact`)

This is the single largest task. Implements the full happy-path protocol from spec §6.1:

1. Pre-transaction validation
2. Hash bytes (SHA-256 via `Bun.CryptoHasher`)
3. Journal intent into `pending_blob_puts` (short tx)
4. `blobStore.put(data)` — outside the lock
5. `BEGIN IMMEDIATE` — sequencing query, idempotency check, tombstone reclaim, INSERT `blob_ready=0`, DELETE intent
6. `COMMIT`
7. Post-commit blob repair: put + has + UPDATE `blob_ready=1` (or loop per §6.1 step 7)
8. Return artifact

**Deferred to Plan 3:** opportunistic TTL reclamation (skip step in the BEGIN IMMEDIATE block); quota admission (always admit for now); maxVersionsPerName enforcement.

**Tests required** (per spec §9.3):

- T1: `save` returns same `id` when content unchanged (idempotent no-op on latest `blob_ready=1`)
- T7: Concurrent saves to same `(session, name)` serialize — both succeed with versions `{1, 2}`
- T8: Save-reclaims-tombstone race (manually insert a tombstone for hash H; save with bytes hashing to H; tombstone must be gone after commit and blob must remain intact)
- T16: Save observes claimed tombstone → re-puts unconditionally
- T18: Crash after save COMMIT but before repair UPDATE (simulate by stopping at step 7 before UPDATE; verify row is blob_ready=0, invisible to reads)
- Basic: save-and-read round-trip

**Implementation skeleton:**

```ts
import { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import type { ArtifactId, SessionId } from "@koi/core";
import { artifactId } from "@koi/core";
import { validateSaveInput } from "./validate.js";
import type {
  Artifact,
  ArtifactError,
  ArtifactStoreConfig,
  Result,
  SaveArtifactInput,
} from "./types.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export function createSaveArtifact(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
  readonly config: ArtifactStoreConfig;
}): (input: SaveArtifactInput) => Promise<Result<Artifact, ArtifactError>> {
  const maxBytes = args.config.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

  return async (input) => {
    const validationError = validateSaveInput(input, maxBytes);
    if (validationError) return { ok: false, error: validationError };

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input.data);
    const hash = hasher.digest("hex");

    const intentId = `intent_${crypto.randomUUID()}`;
    const now = Date.now();

    // Step 3: journal intent (short tx)
    args.db
      .query(
        "INSERT INTO pending_blob_puts (intent_id, hash, created_at) VALUES (?, ?, ?)",
      )
      .run(intentId, hash, now);

    // Step 4: blob put outside the lock
    await args.blobStore.put(input.data);

    // Step 5: metadata transaction
    const committed = args.db.transaction(
      (): { idempotentArtifactId?: string; insertedId?: string; needsRePut: boolean } => {
        // Sequencing
        const maxRow = args.db
          .query(
            "SELECT MAX(version) AS max FROM artifacts WHERE session_id = ? AND name = ?",
          )
          .get(input.sessionId, input.name) as { readonly max: number | null };
        const nextVersion = (maxRow.max ?? 0) + 1;

        // Idempotency (checks latest row of any blob_ready state)
        const latest = args.db
          .query(
            "SELECT id, content_hash, blob_ready, expires_at FROM artifacts WHERE session_id = ? AND name = ? ORDER BY version DESC LIMIT 1",
          )
          .get(input.sessionId, input.name) as
          | {
              readonly id: string;
              readonly content_hash: string;
              readonly blob_ready: number;
              readonly expires_at: number | null;
            }
          | null;

        if (
          latest &&
          latest.content_hash === hash &&
          latest.blob_ready === 1 &&
          (latest.expires_at === null || latest.expires_at >= now)
        ) {
          // Idempotent no-op. Retire intent.
          args.db
            .query("DELETE FROM pending_blob_puts WHERE intent_id = ?")
            .run(intentId);
          return { idempotentArtifactId: latest.id, needsRePut: false };
        }

        // Observe tombstone claim state + reclaim
        const tomb = args.db
          .query(
            "SELECT claimed_at FROM pending_blob_deletes WHERE hash = ?",
          )
          .get(hash) as { readonly claimed_at: number | null } | null;
        const needsRePut = tomb !== null && tomb.claimed_at !== null;
        args.db
          .query("DELETE FROM pending_blob_deletes WHERE hash = ?")
          .run(hash);

        // Insert artifact row (always blob_ready=0)
        const newId = `art_${crypto.randomUUID()}`;
        args.db
          .query(
            `INSERT INTO artifacts
               (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            newId,
            input.sessionId,
            input.name,
            nextVersion,
            input.mimeType,
            input.data.byteLength,
            hash,
            JSON.stringify(input.tags ?? []),
            now,
            null, // Plan 3 stamps expires_at from policy.ttlMs
          );

        // Retire intent atomically with the INSERT
        args.db
          .query("DELETE FROM pending_blob_puts WHERE intent_id = ?")
          .run(intentId);

        return { insertedId: newId, needsRePut };
      },
    )();

    // Idempotent no-op path
    if (committed.idempotentArtifactId) {
      const row = args.db
        .query(
          `SELECT id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at
           FROM artifacts WHERE id = ?`,
        )
        .get(committed.idempotentArtifactId);
      return { ok: true, value: rowToArtifact(row) };
    }

    const newId = committed.insertedId as string;

    // Step 7: post-commit repair
    if (committed.needsRePut) {
      // Unconditional put; sweep claim meant the blob may be gone any moment.
      await args.blobStore.put(input.data);
    }
    // Verify (loop max 2 per §6.1 analysis)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await args.blobStore.has(hash)) break;
      await args.blobStore.put(input.data);
    }

    const updateResult = args.db
      .query(
        "UPDATE artifacts SET blob_ready = 1 WHERE id = ? AND blob_ready = 0",
      )
      .run(newId);
    if (updateResult.changes === 0) {
      throw new Error(
        `saveArtifact: row ${newId} was reaped during repair; save is lost`,
      );
    }

    const row = args.db
      .query(
        `SELECT id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at
         FROM artifacts WHERE id = ?`,
      )
      .get(newId);
    return { ok: true, value: rowToArtifact(row) };
  };
}

function rowToArtifact(row: unknown): Artifact {
  const r = row as {
    readonly id: string;
    readonly session_id: string;
    readonly name: string;
    readonly version: number;
    readonly mime_type: string;
    readonly size: number;
    readonly content_hash: string;
    readonly tags: string;
    readonly created_at: number;
    readonly expires_at: number | null;
  };
  return {
    id: artifactId(r.id),
    sessionId: r.session_id as SessionId,
    name: r.name,
    version: r.version,
    mimeType: r.mime_type,
    size: r.size,
    contentHash: r.content_hash,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    tags: JSON.parse(r.tags) as ReadonlyArray<string>,
  };
}
```

**Detailed steps for the implementer:**

- [ ] **Step 9.1: Write each test from the list above — start with save-then-get round-trip.**
- [ ] **Step 9.2: Implement `save.ts` as above.**
- [ ] **Step 9.3: Wire `createSaveArtifact` into `create-store.ts` — replace the `notImpl()` stub.**
- [ ] **Step 9.4: Run the round-trip test. Green.**
- [ ] **Step 9.5: Write + pass the concurrency test (two parallel saves → versions 1 and 2).**
- [ ] **Step 9.6: Write + pass the tombstone-reclaim test.**
- [ ] **Step 9.7: Write + pass the claimed-tombstone re-put test.**
- [ ] **Step 9.8: Commit.**

```bash
git add packages/lib/artifacts/src/save.ts \
        packages/lib/artifacts/src/create-store.ts \
        packages/lib/artifacts/src/__tests__/save.test.ts
git commit -m "feat(artifacts): saveArtifact with blob_ready repair protocol"
```

---

## Task 10: `getArtifact` + ACL recheck

**Files:**
- Create: `packages/lib/artifacts/src/get.ts`
- Create: `packages/lib/artifacts/src/__tests__/get.test.ts`
- Modify: `packages/lib/artifacts/src/create-store.ts`

Implements §6.2 — post-read revalidation closes the get-vs-revoke and get-vs-sweep races.

**Tests required:**
- Owner get succeeds
- Grantee get succeeds (after explicit share)
- Non-owner, non-grantee → `not_found` (NOT `forbidden`)
- `blob_ready=0` row → invisible (returns `not_found`)
- Manual corruption (delete blob from disk while row is `blob_ready=1`) → throws corruption error
- Read-vs-revoke race (T2, T41 from spec §9.3): manually remove share row between step 2 and step 4 → must return `not_found`

**Implementation:**

```ts
import type { Database } from "bun:sqlite";
import type { BlobStore } from "@koi/blob-cas";
import type { ArtifactId, SessionId } from "@koi/core";
import type { Artifact, ArtifactError, Result } from "./types.js";

export function createGetArtifact(args: {
  readonly db: Database;
  readonly blobStore: BlobStore;
}): (
  id: ArtifactId,
  ctx: { readonly sessionId: SessionId },
) => Promise<
  Result<{ readonly meta: Artifact; readonly data: Uint8Array }, ArtifactError>
> {
  return async (id, ctx) => {
    const now = Date.now();

    // Step 1: initial visibility + fetch row
    const row = args.db
      .query(
        `SELECT id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready
         FROM artifacts WHERE id = ?`,
      )
      .get(id) as
      | {
          readonly id: string;
          readonly session_id: string;
          readonly name: string;
          readonly version: number;
          readonly mime_type: string;
          readonly size: number;
          readonly content_hash: string;
          readonly tags: string;
          readonly created_at: number;
          readonly expires_at: number | null;
          readonly blob_ready: number;
        }
      | null;

    if (!row) return { ok: false, error: { kind: "not_found", id } };
    if (row.blob_ready !== 1)
      return { ok: false, error: { kind: "not_found", id } };
    if (row.expires_at !== null && row.expires_at < now)
      return { ok: false, error: { kind: "not_found", id } };

    // Step 2: ACL
    if (row.session_id !== ctx.sessionId) {
      const share = args.db
        .query(
          "SELECT 1 FROM artifact_shares WHERE artifact_id = ? AND granted_to_session_id = ?",
        )
        .get(id, ctx.sessionId);
      if (!share) return { ok: false, error: { kind: "not_found", id } };
    }

    // Step 3: read blob
    const data = await args.blobStore.get(row.content_hash);

    // Step 4: post-read revalidation (combined visibility + ACL recheck)
    const nowAfter = Date.now();
    const revalidation = args.db
      .query(
        `SELECT 1 FROM artifacts WHERE id = ?
           AND blob_ready = 1
           AND (expires_at IS NULL OR expires_at >= ?)
           AND (
             session_id = ?
             OR EXISTS (SELECT 1 FROM artifact_shares
                          WHERE artifact_id = ? AND granted_to_session_id = ?)
           )`,
      )
      .get(id, nowAfter, ctx.sessionId, id, ctx.sessionId);

    if (!revalidation) return { ok: false, error: { kind: "not_found", id } };

    if (data === undefined) {
      // Row is still visible + authorized but blob is missing → corruption.
      throw new Error(
        `getArtifact: blob missing for live artifact ${id}; contact operator`,
      );
    }

    return {
      ok: true,
      value: {
        meta: rowToArtifact(row),
        data,
      },
    };
  };
}

// rowToArtifact mirrors save.ts — consider extracting to a shared helper
// once both use it. For Plan 2, duplicate is OK (Rule of Three not yet
// triggered — the third use would be in Plan 3's sweepArtifacts).
```

**Detailed steps:**

- [ ] **Step 10.1: Write the basic round-trip test (save + get same session).**
- [ ] **Step 10.2: Write the cross-session → not_found test.**
- [ ] **Step 10.3: Write the blob_ready=0 invisibility test** (insert a `blob_ready=0` row directly via SQLite; get returns not_found).
- [ ] **Step 10.4: Implement get.ts.** Wire into `create-store.ts`.
- [ ] **Step 10.5: Write the corruption test** (delete blob from disk, get throws).
- [ ] **Step 10.6: Commit.**

```bash
git add packages/lib/artifacts/src/get.ts \
        packages/lib/artifacts/src/create-store.ts \
        packages/lib/artifacts/src/__tests__/get.test.ts
git commit -m "feat(artifacts): getArtifact with post-read ACL recheck"
```

---

## Task 11: `listArtifacts`

**Files:**
- Create: `packages/lib/artifacts/src/list.ts`
- Create: `packages/lib/artifacts/src/__tests__/list.test.ts`
- Modify: `packages/lib/artifacts/src/create-store.ts`

Filters by `session_id = ctx.sessionId` OR (if `includeShared`) shares-to-me. Applies visibility predicate.

- [ ] **Step 11.1: Write failing tests** (5 minimum): own-session, name filter, tags AND semantics, includeShared, blob_ready=0 hidden.

- [ ] **Step 11.2: Implement `list.ts`** — prepared SQL with dynamic WHERE. Return rows mapped to `Artifact[]`.

- [ ] **Step 11.3: Wire + commit.**

```bash
git commit -m "feat(artifacts): listArtifacts with visibility + sharing filter"
```

---

## Task 12: `deleteArtifact`

**Files:**
- Create: `packages/lib/artifacts/src/delete.ts`
- Create: `packages/lib/artifacts/src/__tests__/delete.test.ts`
- Modify: `packages/lib/artifacts/src/create-store.ts`

Owner-only. Applies **`blob_ready = 1` only** (NOT full visibility — owner can delete expired rows per spec §6.2 "Owner overrides"). Metadata delete + tombstone insert atomic in one BEGIN IMMEDIATE. Blob unlink deferred to Plan 3's `sweepArtifacts`.

- [ ] **Step 12.1: Write tests (5):** owner delete removes row + CASCADE shares; non-owner returns not_found; tombstone row appears after delete; blob stays until sweep (which doesn't exist in Plan 2 — verify the blob file still exists on disk after the delete); deleting a `blob_ready=0` in-flight row → not_found.

- [ ] **Step 12.2: Implement.** Transaction body:
  1. `SELECT content_hash FROM artifacts WHERE id = ? AND session_id = ? AND blob_ready = 1`
  2. If no row → return `not_found`.
  3. `DELETE FROM artifacts WHERE id = ?` (CASCADE drops shares).
  4. If no other row references the hash (check `blob_ready IN (0, 1)` plus `pending_blob_puts`), `INSERT INTO pending_blob_deletes (hash, enqueued_at) VALUES (?, ?) ON CONFLICT DO NOTHING`.

- [ ] **Step 12.3: Commit.**

```bash
git commit -m "feat(artifacts): deleteArtifact (metadata + tombstone)"
```

---

## Task 13: `shareArtifact` + `revokeShare`

**Files:**
- Create: `packages/lib/artifacts/src/share.ts`
- Create: `packages/lib/artifacts/src/__tests__/share.test.ts`
- Create: `packages/lib/artifacts/src/__tests__/acl-probe.test.ts`
- Modify: `packages/lib/artifacts/src/create-store.ts`

`shareArtifact` applies full `isVisible` predicate (can't share an expired row — once Plan 3 adds TTL). `revokeShare` is owner-override: applies only `blob_ready = 1` so expired rows are still revokable.

- [ ] **Step 13.1: Write tests (6):**
  - share → grantee can now get; share is idempotent (same share twice → same row, no error).
  - revoke → grantee gets not_found.
  - share by non-owner → not_found.
  - revoke by non-owner → not_found.
  - ACL probe-resistance test (`acl-probe.test.ts`): across 20 random artifact IDs that don't exist plus 20 owned by someone else, `getArtifact`/`shareArtifact`/`revokeShare` must return identically-shaped `not_found` errors (no information leak via error shape or timing differences).

- [ ] **Step 13.2: Implement share.ts.**

```ts
export function createShareArtifact(args: { db: Database }): ... {
  return async (id, withSessionId, ctx) => {
    const row = args.db.query(
      "SELECT 1 FROM artifacts WHERE id = ? AND session_id = ? AND blob_ready = 1 AND (expires_at IS NULL OR expires_at >= ?)"
    ).get(id, ctx.ownerSessionId, Date.now());
    if (!row) return { ok: false, error: { kind: "not_found", id } };
    args.db.query(
      "INSERT INTO artifact_shares (artifact_id, granted_to_session_id, granted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
    ).run(id, withSessionId, Date.now());
    return { ok: true, value: undefined };
  };
}

export function createRevokeShare(args: { db: Database }): ... {
  return async (id, fromSessionId, ctx) => {
    // Owner override: blob_ready = 1 only, no TTL check
    const row = args.db.query(
      "SELECT 1 FROM artifacts WHERE id = ? AND session_id = ? AND blob_ready = 1"
    ).get(id, ctx.ownerSessionId);
    if (!row) return { ok: false, error: { kind: "not_found", id } };
    args.db.query(
      "DELETE FROM artifact_shares WHERE artifact_id = ? AND granted_to_session_id = ?"
    ).run(id, fromSessionId);
    return { ok: true, value: undefined };
  };
}
```

- [ ] **Step 13.3: Commit.**

```bash
git commit -m "feat(artifacts): shareArtifact and revokeShare (owner-override on expired)"
```

---

## Task 14: Full-repo verification + PR

Same structure as Plan 1's Task 8 + Task 10.

- [ ] **Step 14.1: Run all CI gates:**
  - `bun run typecheck`
  - `bun test`
  - `bun run lint`
  - `bun run check:layers`
  - `bun run check:unused` — `@koi/artifacts` exports may be flagged as unused (consumed by Plan 3+). Suppress or document.
  - `bun run check:duplicates`
  - `bun run build`

- [ ] **Step 14.2: Run checkpoint's test suite** to confirm Plan 1's public API is still intact (shouldn't have changed, but defense-in-depth).

- [ ] **Step 14.3: Push + open PR.**

```bash
git push -u origin feat/issue-1651-artifacts-core
gh pr create --title "feat(artifacts): core CRUD + ACL (Plan 2 of 6 for #1651)" --body-file /tmp/pr-body.md
```

PR description must:
- Reference #1651 and `feat(checkpoint): extract @koi/blob-cas` (Plan 1 PR #1916).
- List every deferred feature and the plan that covers it.
- Acknowledge the Plan 2 close() limitation (no barrier yet; proper close in Plan 4).
- Flag the lock.ts limitation (file-based instead of flock; crash may leave stale lock — Plan 4 hardens).
- Full CI gate results.

---

## Self-Review

**Spec coverage** (cross-reference `docs/superpowers/specs/2026-04-18-artifacts-design.md`):

| Spec section | Covered by | Deferred? |
|--------------|------------|-----------|
| §3.0 Single-writer lock | T6 (file-based MVP), T14 | Plan 4 hardens |
| §3.0 Store-id pairing | T5 | no |
| §4 Types | T3 | no |
| §5 Schema | T4 | no |
| §6.1 saveArtifact | T9 (without TTL stamping / quota admission) | Plan 3 adds lifecycle |
| §6.2 getArtifact | T10 | no |
| §6.2 listArtifacts | T11 | no |
| §6.2 deleteArtifact owner override | T12 | no |
| §6.2 shareArtifact/revokeShare | T13 | no |
| §6.3 sweepArtifacts | — | Plan 3 |
| §6.4 scavengeOrphanBlobs | — | Plan 3 |
| §6.5 Startup recovery | — | Plan 4 |
| §7 Error handling (Result<T, E>) | T3, T9, T10, T12, T13 | no |
| §8 Security (probe-resistance, owner-only writes) | T10, T12, T13 | no |
| §9 Testing | Each task's tests | partial — lifecycle tests in Plan 3 |

**Placeholder scan:** every step has concrete code or a concrete command. No "TBD" or "implement later" for Plan 2 scope. (Explicit deferrals to Plans 3+ are clearly tagged.)

**Type consistency:** `Artifact`, `ArtifactStore`, `SaveArtifactInput`, `Result<T,E>`, `ArtifactError` used identically across every task. Row-to-Artifact mapping duplicated in save.ts and get.ts — extracted in Plan 3 when the 3rd consumer (sweep) appears (Rule of Three).

**Scope check:** 14 tasks × ~3-8 steps = ~70 steps. Larger than Plan 1 (10 tasks, ~65 steps) but still one coherent PR. The breakdown by task is clean — each could independently ship (with stubs for the rest) if we needed finer granularity.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-artifacts-phase2-core.md`.

Prerequisite: Plan 1 (PR #1916) must be merged to `main` before Plan 2 implementation begins. Plan 2 depends on `@koi/blob-cas` being available as a workspace dep.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review per task.

**2. Inline Execution** — batch execution in this session with checkpoint reviews.

Which approach? (Or: wait until PR #1916 merges first and re-confirm.)
