# Nexus Filesystem Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 4 architectural gaps blocking `manifest.filesystem.backend: nexus` on `koi start` and `koi tui`.

**Architecture:** Four sequential sub-projects: (1) new `@koi/fs-scoped` L0u package porting v1's scoped filesystem, (2) backend-aware checkpoint/rewind with atomic pre-flight checks, (3) OAuth auth channel loop wiring in TUI, (4) two-gate trust boundary (`--allow-remote-fs` + manifest scope) on `koi start`. Each sub-project has its own tests and commit.

**Tech Stack:** TypeScript 6, Bun, bun:test, tsup (ESM-only)

**Spec:** `docs/superpowers/specs/2026-04-15-nexus-fs-backend-design.md`

---

## File Structure

### New Files

| File | Purpose |
|------|---------|
| `packages/lib/fs-scoped/package.json` | L0u package manifest |
| `packages/lib/fs-scoped/tsconfig.json` | TS project references |
| `packages/lib/fs-scoped/tsup.config.ts` | ESM build config |
| `packages/lib/fs-scoped/src/index.ts` | Public exports |
| `packages/lib/fs-scoped/src/scoped-filesystem.ts` | Core: compile scope, normalize path, write guard, factory |
| `packages/lib/fs-scoped/src/scoped-filesystem.test.ts` | Unit tests |
| `packages/meta/cli/src/auth-interceptor.ts` | OAuth redirect URL detection + submitAuthCode |
| `packages/meta/cli/src/auth-interceptor.test.ts` | Unit tests for URL pattern matching |

### Modified Files

| File | What Changes |
|------|-------------|
| `scripts/layers.ts` | Add `@koi/fs-scoped` to `L0U_PACKAGES` |
| `packages/meta/runtime/src/resolve-filesystem.ts` | Wrap backend with `createScopedFileSystem` when manifest declares scope |
| `packages/kernel/core/src/snapshot-time-travel.ts` | Add optional `backend` field to `FileOpRecordBase` |
| `packages/lib/checkpoint/src/file-tracking.ts` | Thread `backend` string through `BuildFileOpInput` → `FileOpRecord` |
| `packages/lib/checkpoint/src/compensating-ops.ts` | Accept `FileSystemBackend` map, route ops through correct backend |
| `packages/lib/checkpoint/src/restore-protocol.ts` | Pre-flight backend availability check, abort-on-unavailable |
| `packages/meta/cli/src/preset-stacks/checkpoint.ts` | Pass backend discriminator during capture, resolve backends on rewind |
| `packages/meta/cli/src/args/start.ts` | Add `allowRemoteFs: boolean` flag |
| `packages/meta/cli/src/commands/start.ts` | Replace blanket nexus rejection with two-gate (scope + flag) |
| `packages/meta/cli/src/tui-command.ts` | Wire auth notification handler + interceptor, accept nexus |
| `packages/meta/cli/src/manifest.ts` | Relax scheme allowlist after OAuth loop ships |

---

## Task 1: Create `@koi/fs-scoped` Package Scaffold

**Files:**
- Create: `packages/lib/fs-scoped/package.json`
- Create: `packages/lib/fs-scoped/tsconfig.json`
- Create: `packages/lib/fs-scoped/tsup.config.ts`
- Create: `packages/lib/fs-scoped/src/index.ts`
- Modify: `scripts/layers.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@koi/fs-scoped",
  "description": "Scoped filesystem wrapper — restricts a FileSystemBackend to a root path with configurable read-only or read-write access",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [
    {
      "path": "../../kernel/core"
    }
  ]
}
```

- [ ] **Step 3: Create tsup.config.ts**

```typescript
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

- [ ] **Step 4: Create src/index.ts (empty for now)**

```typescript
export { compileFileSystemScope, createScopedFileSystem } from "./scoped-filesystem.js";
export type { FileSystemScope, CompiledFileSystemScope } from "./scoped-filesystem.js";
```

- [ ] **Step 5: Register in layers.ts**

In `scripts/layers.ts`, add `"@koi/fs-scoped"` to `L0U_PACKAGES` set (alphabetical order, after `"@koi/file-resolution"`).

- [ ] **Step 6: Run `bun install` to wire workspace dependency**

Run: `bun install`
Expected: lockfile updated, `@koi/fs-scoped` linked

- [ ] **Step 7: Commit scaffold**

```bash
git add packages/lib/fs-scoped/ scripts/layers.ts bun.lock
git commit -m "chore: scaffold @koi/fs-scoped L0u package"
```

---

## Task 2: Implement `createScopedFileSystem`

**Files:**
- Create: `packages/lib/fs-scoped/src/scoped-filesystem.ts`
- Test: `packages/lib/fs-scoped/src/scoped-filesystem.test.ts`

Port from `archive/v1/packages/security/scope/src/scoped-filesystem.ts` (184 lines). The v1 code is clean and well-tested — adapt to v2's exact `FileSystemBackend` interface at `packages/kernel/core/src/filesystem-backend.ts:136-205`.

- [ ] **Step 1: Write failing tests**

Create `packages/lib/fs-scoped/src/scoped-filesystem.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import type { FileSystemBackend, KoiError, Result } from "@koi/core";
import {
  compileFileSystemScope,
  createScopedFileSystem,
  type CompiledFileSystemScope,
  type FileSystemScope,
} from "./scoped-filesystem.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(overrides?: Partial<FileSystemBackend>): FileSystemBackend {
  return {
    name: "mock",
    read: () => ({ ok: true, value: { content: "hello", resolvedPath: "/tmp/root/file.txt" } }),
    write: () => ({ ok: true, value: { resolvedPath: "/tmp/root/file.txt" } }),
    edit: () => ({ ok: true, value: { resolvedPath: "/tmp/root/file.txt", applied: true } }),
    list: () => ({ ok: true, value: { entries: [], truncated: false } }),
    search: () => ({ ok: true, value: { matches: [], truncated: false } }),
    ...overrides,
  } as FileSystemBackend;
}

// ---------------------------------------------------------------------------
// compileFileSystemScope
// ---------------------------------------------------------------------------

describe("compileFileSystemScope", () => {
  test("resolves root to absolute and appends separator", () => {
    const compiled = compileFileSystemScope({ root: "/tmp/root", mode: "rw" });
    expect(compiled.root).toBe("/tmp/root");
    expect(compiled.rootWithSep).toBe(`/tmp/root${sep}`);
    expect(compiled.mode).toBe("rw");
  });

  test("resolves relative root against cwd", () => {
    const compiled = compileFileSystemScope({ root: "relative/path", mode: "ro" });
    expect(compiled.root).toContain("relative/path");
    expect(compiled.mode).toBe("ro");
  });
});

// ---------------------------------------------------------------------------
// Path normalization (traversal prevention)
// ---------------------------------------------------------------------------

describe("createScopedFileSystem — path normalization", () => {
  const scope: FileSystemScope = { root: "/tmp/root", mode: "rw" };

  test("allows path within root", () => {
    const mock = createMockBackend();
    const scoped = createScopedFileSystem(mock, scope);
    const result = scoped.read("subdir/file.txt") as Result<unknown, KoiError>;
    expect(result.ok).toBe(true);
  });

  test("allows root itself", () => {
    const mock = createMockBackend();
    const scoped = createScopedFileSystem(mock, scope);
    const result = scoped.list(".") as Result<unknown, KoiError>;
    expect(result.ok).toBe(true);
  });

  test("blocks traversal via ../", () => {
    const mock = createMockBackend();
    const scoped = createScopedFileSystem(mock, scope);
    const result = scoped.read("../etc/passwd") as Result<unknown, KoiError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("escapes root");
    }
  });

  test("blocks absolute path outside root", () => {
    const mock = createMockBackend();
    const scoped = createScopedFileSystem(mock, scope);
    const result = scoped.read("/etc/passwd") as Result<unknown, KoiError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("passes normalized absolute path to inner backend", () => {
    let receivedPath = "";
    const mock = createMockBackend({
      read: (path: string) => {
        receivedPath = path;
        return { ok: true, value: { content: "hello", resolvedPath: path } };
      },
    });
    const scoped = createScopedFileSystem(mock, scope);
    scoped.read("subdir/file.txt");
    expect(receivedPath).toBe("/tmp/root/subdir/file.txt");
  });
});

// ---------------------------------------------------------------------------
// Write guard (read-only mode)
// ---------------------------------------------------------------------------

describe("createScopedFileSystem — write guard", () => {
  const roScope: FileSystemScope = { root: "/tmp/root", mode: "ro" };

  test("allows read in ro mode", () => {
    const scoped = createScopedFileSystem(createMockBackend(), roScope);
    const result = scoped.read("file.txt") as Result<unknown, KoiError>;
    expect(result.ok).toBe(true);
  });

  test("allows list in ro mode", () => {
    const scoped = createScopedFileSystem(createMockBackend(), roScope);
    const result = scoped.list(".") as Result<unknown, KoiError>;
    expect(result.ok).toBe(true);
  });

  test("allows search in ro mode", () => {
    const scoped = createScopedFileSystem(createMockBackend(), roScope);
    const result = scoped.search("*.ts") as Result<unknown, KoiError>;
    expect(result.ok).toBe(true);
  });

  test("blocks write in ro mode", () => {
    const scoped = createScopedFileSystem(createMockBackend(), roScope);
    const result = scoped.write("file.txt", "content") as Result<unknown, KoiError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("read-only");
    }
  });

  test("blocks edit in ro mode", () => {
    const scoped = createScopedFileSystem(createMockBackend(), roScope);
    const result = scoped.edit("file.txt", []) as Result<unknown, KoiError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("blocks delete in ro mode", () => {
    const mock = createMockBackend({
      delete: () => ({ ok: true, value: {} }),
    });
    const scoped = createScopedFileSystem(mock, roScope);
    const result = scoped.delete!("file.txt") as Result<unknown, KoiError>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("allows write in rw mode", () => {
    const rwScope: FileSystemScope = { root: "/tmp/root", mode: "rw" };
    const scoped = createScopedFileSystem(createMockBackend(), rwScope);
    const result = scoped.write("file.txt", "content") as Result<unknown, KoiError>;
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Search filtering
// ---------------------------------------------------------------------------

describe("createScopedFileSystem — search filtering", () => {
  const scope: FileSystemScope = { root: "/tmp/root", mode: "rw" };

  test("filters search results to root boundary", () => {
    const mock = createMockBackend({
      search: () => ({
        ok: true,
        value: {
          matches: [
            { path: "/tmp/root/a.ts", line: 1, content: "match" },
            { path: "/tmp/other/b.ts", line: 1, content: "match" },
            { path: "/tmp/root/sub/c.ts", line: 1, content: "match" },
          ],
          truncated: false,
        },
      }),
    });
    const scoped = createScopedFileSystem(mock, scope);
    const result = scoped.search("pattern") as Result<{ matches: readonly { path: string }[]; truncated: boolean }, KoiError>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matches).toHaveLength(2);
      expect(result.value.matches[0]!.path).toBe("/tmp/root/a.ts");
      expect(result.value.matches[1]!.path).toBe("/tmp/root/sub/c.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// Backend name
// ---------------------------------------------------------------------------

describe("createScopedFileSystem — metadata", () => {
  test("wraps backend name with scoped()", () => {
    const mock = createMockBackend();
    const scoped = createScopedFileSystem(mock, { root: "/tmp/root", mode: "rw" });
    expect(scoped.name).toBe("scoped(mock)");
  });

  test("preserves delete when inner backend has it", () => {
    const mock = createMockBackend({
      delete: () => ({ ok: true, value: {} }),
    });
    const scoped = createScopedFileSystem(mock, { root: "/tmp/root", mode: "rw" });
    expect(scoped.delete).toBeDefined();
  });

  test("omits delete when inner backend lacks it", () => {
    const mock = createMockBackend();
    delete (mock as Record<string, unknown>).delete;
    const scoped = createScopedFileSystem(mock, { root: "/tmp/root", mode: "rw" });
    expect(scoped.delete).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/lib/fs-scoped && bun test`
Expected: FAIL — `scoped-filesystem.ts` doesn't exist yet

- [ ] **Step 3: Implement scoped-filesystem.ts**

Create `packages/lib/fs-scoped/src/scoped-filesystem.ts`. Port directly from `archive/v1/packages/security/scope/src/scoped-filesystem.ts` — the v1 implementation is already clean. Key changes from v1:
- Types are defined inline (no separate `types.ts` — package is small enough)
- Import `permission` from `@koi/core` (same as v1)
- Match v2's exact `FileSystemBackend` method signatures from `packages/kernel/core/src/filesystem-backend.ts:136-205`

```typescript
/**
 * Scoped filesystem wrapper — restricts a FileSystemBackend to a root path
 * with configurable read-only or read-write access.
 *
 * Ported from archive/v1/packages/security/scope/src/scoped-filesystem.ts.
 * Uses resolve + startsWith guard for traversal prevention.
 * All paths are normalized once at call time; the compiled scope is
 * created once at construction time (compile-once pattern).
 */

import { resolve, sep } from "node:path";
import type { FileSearchResult, FileSystemBackend, KoiError, Result } from "@koi/core";
import { permission } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileSystemScope {
  readonly root: string;
  readonly mode: "ro" | "rw";
}

export interface CompiledFileSystemScope {
  readonly root: string;
  readonly rootWithSep: string;
  readonly mode: "ro" | "rw";
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compileFileSystemScope(scope: FileSystemScope): CompiledFileSystemScope {
  const root = resolve(scope.root);
  return {
    root,
    rootWithSep: root + sep,
    mode: scope.mode,
  };
}

// ---------------------------------------------------------------------------
// Path normalization + boundary check
// ---------------------------------------------------------------------------

function normalizePath(
  userPath: string,
  compiled: CompiledFileSystemScope,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: KoiError } {
  const resolved = resolve(compiled.root, userPath);
  if (resolved !== compiled.root && !resolved.startsWith(compiled.rootWithSep)) {
    return {
      ok: false,
      error: permission(
        `Access to '${resolved}' was blocked: path escapes root '${compiled.root}'. ` +
          `All file operations are restricted to '${compiled.root}' and its subdirectories.`,
      ),
    };
  }
  return { ok: true, value: resolved };
}

// ---------------------------------------------------------------------------
// Write guard
// ---------------------------------------------------------------------------

function writeGuard(operation: string, compiled: CompiledFileSystemScope): KoiError | undefined {
  if (compiled.mode === "ro") {
    return permission(
      `${operation} was blocked: filesystem scope is read-only. ` +
        `Only read, list, and search operations are permitted on '${compiled.root}'.`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Search result filtering
// ---------------------------------------------------------------------------

function filterSearchResults(
  raw: Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>>,
  compiled: CompiledFileSystemScope,
): Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>> {
  if (raw instanceof Promise) {
    return raw.then((r) => applySearchFilter(r, compiled));
  }
  return applySearchFilter(raw, compiled);
}

function applySearchFilter(
  result: Result<FileSearchResult, KoiError>,
  compiled: CompiledFileSystemScope,
): Result<FileSearchResult, KoiError> {
  if (!result.ok) return result;
  const filtered = result.value.matches.filter((m) => {
    const resolved = resolve(m.path);
    return resolved === compiled.root || resolved.startsWith(compiled.rootWithSep);
  });
  return { ok: true, value: { matches: filtered, truncated: result.value.truncated } };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedFileSystem(
  backend: FileSystemBackend,
  scope: FileSystemScope,
): FileSystemBackend {
  const compiled = compileFileSystemScope(scope);

  const del = backend.delete;
  const scopedDelete: Pick<FileSystemBackend, "delete"> = del
    ? {
        delete: (filePath: string) => {
          const guard = writeGuard("Delete", compiled);
          if (guard !== undefined)
            return { ok: false, error: guard } satisfies Result<never, KoiError>;
          const norm = normalizePath(filePath, compiled);
          if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
          return del(norm.value);
        },
      }
    : {};

  const ren = backend.rename;
  const scopedRename: Pick<FileSystemBackend, "rename"> = ren
    ? {
        rename: (from: string, to: string) => {
          const guard = writeGuard("Rename", compiled);
          if (guard !== undefined)
            return { ok: false, error: guard } satisfies Result<never, KoiError>;
          const normFrom = normalizePath(from, compiled);
          if (!normFrom.ok)
            return { ok: false, error: normFrom.error } satisfies Result<never, KoiError>;
          const normTo = normalizePath(to, compiled);
          if (!normTo.ok)
            return { ok: false, error: normTo.error } satisfies Result<never, KoiError>;
          return ren(normFrom.value, normTo.value);
        },
      }
    : {};

  const dispose = backend.dispose;
  const scopedDispose: Pick<FileSystemBackend, "dispose"> = dispose
    ? { dispose: () => dispose() }
    : {};

  return {
    name: `scoped(${backend.name})`,

    read(filePath, options) {
      const norm = normalizePath(filePath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.read(norm.value, options);
    },

    write(filePath, content, options) {
      const guard = writeGuard("Write", compiled);
      if (guard !== undefined) return { ok: false, error: guard } satisfies Result<never, KoiError>;
      const norm = normalizePath(filePath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.write(norm.value, content, options);
    },

    edit(filePath, edits, options) {
      const guard = writeGuard("Edit", compiled);
      if (guard !== undefined) return { ok: false, error: guard } satisfies Result<never, KoiError>;
      const norm = normalizePath(filePath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.edit(norm.value, edits, options);
    },

    list(dirPath, options) {
      const norm = normalizePath(dirPath, compiled);
      if (!norm.ok) return { ok: false, error: norm.error } satisfies Result<never, KoiError>;
      return backend.list(norm.value, options);
    },

    search(pattern, options) {
      const raw = backend.search(pattern, options);
      return filterSearchResults(raw, compiled);
    },

    ...scopedDelete,
    ...scopedRename,
    ...scopedDispose,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/lib/fs-scoped && bun test`
Expected: ALL PASS

- [ ] **Step 5: Run typecheck**

Run: `cd packages/lib/fs-scoped && bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/lib/fs-scoped/src/
git commit -m "feat(fs-scoped): implement createScopedFileSystem with traversal prevention and write guard"
```

---

## Task 3: Wire Scoped Filesystem into resolve-filesystem.ts

**Files:**
- Modify: `packages/meta/runtime/src/resolve-filesystem.ts`

The resolver needs to wrap the resolved backend with `createScopedFileSystem` when the manifest declares `filesystem.root` + `mode`. This is the integration point — both `resolveFileSystem` (sync) and `resolveFileSystemAsync` (async) paths need wrapping.

- [ ] **Step 1: Read current resolve-filesystem.ts to understand exact function signatures**

Read: `packages/meta/runtime/src/resolve-filesystem.ts` lines 60-90 (sync path) and lines 187-298 (async path)

Look for: where backends are returned, what types they return, where to insert the scope wrapping.

- [ ] **Step 2: Add scope wrapping to the sync path**

In `resolveFileSystem()`, after the backend is constructed (local or nexus), check if the config has `root` and `mode`. If so, wrap:

```typescript
import { createScopedFileSystem } from "@koi/fs-scoped";

// After backend construction, before return:
if (config?.root !== undefined && config?.mode !== undefined) {
  return createScopedFileSystem(backend, { root: config.root, mode: config.mode });
}
return backend;
```

The exact integration depends on the current return structure — adapt to match.

- [ ] **Step 3: Add scope wrapping to the async path**

In `resolveFileSystemAsync()`, same pattern: wrap the `backend` in the returned `{ backend, operations, transport }` object.

- [ ] **Step 4: Add `@koi/fs-scoped` as dependency of `@koi/runtime`**

Run: `bun add --cwd packages/meta/runtime @koi/fs-scoped`
Then update the runtime's `tsconfig.json` references.

- [ ] **Step 5: Run existing tests**

Run: `bun run test --filter=@koi/runtime`
Expected: All existing tests still pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add packages/meta/runtime/
git commit -m "feat(runtime): wrap filesystem backend with scope when manifest declares root+mode"
```

---

## Task 4: Add `backend` Field to `FileOpRecordBase` (L0)

**Files:**
- Modify: `packages/kernel/core/src/snapshot-time-travel.ts`

The `FileOpRecordBase` type at line 30 needs an optional `backend` field. This is an L0 type change — additive, non-breaking.

- [ ] **Step 1: Add backend field to FileOpRecordBase**

In `packages/kernel/core/src/snapshot-time-travel.ts`, add to `FileOpRecordBase` (after `renameId` at line 45):

```typescript
  /**
   * Backend that owns this file. `"local"` for the host filesystem,
   * `"nexus:<transport>"` for nexus backends (e.g., `"nexus:local-bridge"`).
   * Undefined means `"local"` (backwards-compatible default for existing snapshots).
   */
  readonly backend?: string;
```

- [ ] **Step 2: Update API surface snapshot**

Run: `cd packages/kernel/core && bun test src/__tests__/api-surface.test.ts -- --update`
Expected: Snapshot updated with new `backend` field

- [ ] **Step 3: Run full core typecheck**

Run: `cd packages/kernel/core && bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/core/
git commit -m "feat(core): add optional backend field to FileOpRecordBase for multi-backend checkpoint"
```

---

## Task 5: Thread Backend Through File Tracking

**Files:**
- Modify: `packages/lib/checkpoint/src/file-tracking.ts`

`BuildFileOpInput` (line 75) and `buildFileOpRecord` need to pass `backend` through to the returned `FileOpRecord`.

- [ ] **Step 1: Write failing test**

Add to existing checkpoint tests (or create `packages/lib/checkpoint/src/file-tracking.test.ts` if it doesn't exist):

```typescript
import { describe, expect, test } from "bun:test";
import { buildFileOpRecord } from "./file-tracking.js";

describe("buildFileOpRecord — backend field", () => {
  test("includes backend in create record when provided", () => {
    const record = buildFileOpRecord({
      callId: "call-1" as import("@koi/core").ToolCallId,
      path: "/tmp/root/file.txt",
      turnIndex: 0,
      eventIndex: 0,
      pre: { existed: false, contentHash: undefined },
      post: { existed: true, contentHash: "abc123" },
      backend: "nexus:local-bridge",
    });
    expect(record).toBeDefined();
    expect(record!.kind).toBe("create");
    expect(record!.backend).toBe("nexus:local-bridge");
  });

  test("omits backend when undefined (backwards compat)", () => {
    const record = buildFileOpRecord({
      callId: "call-1" as import("@koi/core").ToolCallId,
      path: "/tmp/root/file.txt",
      turnIndex: 0,
      eventIndex: 0,
      pre: { existed: false, contentHash: undefined },
      post: { existed: true, contentHash: "abc123" },
    });
    expect(record).toBeDefined();
    expect(record!.backend).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/lib/checkpoint && bun test`
Expected: FAIL — `backend` not in `BuildFileOpInput`

- [ ] **Step 3: Add backend to BuildFileOpInput and thread through**

In `packages/lib/checkpoint/src/file-tracking.ts`:

1. Add to `BuildFileOpInput` interface (line 75):
```typescript
  readonly backend?: string;
```

2. In `buildFileOpRecord`, spread `backend` into every returned record. For each return that constructs a `FileOpRecord`, add the backend field conditionally:

```typescript
// In each record-returning branch, add:
...(input.backend !== undefined ? { backend: input.backend } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/lib/checkpoint && bun test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/lib/checkpoint/src/file-tracking.ts packages/lib/checkpoint/src/file-tracking.test.ts
git commit -m "feat(checkpoint): thread backend discriminator through file tracking"
```

---

## Task 6: Backend-Aware Compensating Ops

**Files:**
- Modify: `packages/lib/checkpoint/src/compensating-ops.ts`

Currently `applyCompensatingOps` uses `unlinkSync` and direct Bun file I/O — hardcoded to local filesystem. To support nexus backends, it needs to accept a backend resolver and route ops through the correct backend.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test, mock } from "bun:test";
import type { CompensatingOp, FileSystemBackend } from "@koi/core";
import { applyCompensatingOps } from "./compensating-ops.js";

describe("applyCompensatingOps — backend routing", () => {
  test("routes ops to correct backend by discriminator", async () => {
    const localDeleteCalls: string[] = [];
    const nexusDeleteCalls: string[] = [];

    const localBackend = {
      name: "local",
      delete: (path: string) => { localDeleteCalls.push(path); return { ok: true, value: {} }; },
    } as unknown as FileSystemBackend;

    const nexusBackend = {
      name: "nexus",
      delete: (path: string) => { nexusDeleteCalls.push(path); return { ok: true, value: {} }; },
    } as unknown as FileSystemBackend;

    const backends = new Map<string, FileSystemBackend>([
      ["local", localBackend],
      ["nexus:local-bridge", nexusBackend],
    ]);

    const ops: CompensatingOp[] = [
      { kind: "delete", path: "/local/file.txt", backend: "local" },
      { kind: "delete", path: "/nexus/file.txt", backend: "nexus:local-bridge" },
    ];

    await applyCompensatingOps(ops, "/tmp/blobs", backends);
    expect(localDeleteCalls).toEqual(["/local/file.txt"]);
    expect(nexusDeleteCalls).toEqual(["/nexus/file.txt"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/lib/checkpoint && bun test`
Expected: FAIL — `applyCompensatingOps` doesn't accept backends map

- [ ] **Step 3: Update applyCompensatingOps signature**

Add optional `backends` parameter. When present, route through the backend. When absent, use direct filesystem I/O (backwards compatible).

The exact implementation depends on the current `CompensatingOp` type. The L0 type at `packages/kernel/core/src/snapshot-time-travel.ts:86` needs `backend` added to `CompensatingOp` as well (optional field, same as `FileOpRecordBase`).

Update `computeCompensatingOps` to carry `backend` from `FileOpRecord` into `CompensatingOp`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/lib/checkpoint && bun test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/lib/checkpoint/src/compensating-ops.ts packages/kernel/core/src/snapshot-time-travel.ts
git commit -m "feat(checkpoint): route compensating ops through backend-aware resolver"
```

---

## Task 7: Atomic Rewind Pre-Flight Check

**Files:**
- Modify: `packages/lib/checkpoint/src/restore-protocol.ts`

Add pre-flight backend availability check before any restore operations. If any required backend is unavailable, abort the entire rewind.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test";

describe("runRestore — pre-flight backend check", () => {
  test("aborts rewind when a required backend is unavailable", async () => {
    // Setup: snapshot entries reference "nexus:local-bridge" backend,
    // but backends map only contains "local"
    // Expected: rewind fails with error mentioning unavailable backend
    // Exact setup depends on RestoreInput shape — adapt after reading
    // the full runRestore function
  });

  test("succeeds when all required backends are available", async () => {
    // Setup: all backends in snapshot entries exist in backends map
    // Expected: rewind succeeds normally
  });
});
```

Note: The exact test implementation depends on the full `runRestore` shape and how backends are threaded through `RestoreInput`. The implementing agent should read `restore-protocol.ts` fully and adapt.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/lib/checkpoint && bun test`
Expected: FAIL

- [ ] **Step 3: Add pre-flight check to runRestore**

In `runRestore` (line 90), after `locateTarget` returns the `snapshotsToUndo`, collect all unique `backend` values from `FileOpRecord`s across those snapshots. Check each against the available backends map. If any is missing, return early with error:

```typescript
// After locateTarget, before computeCompensatingOps:
const requiredBackends = new Set<string>();
for (const snap of snapshotsToUndo) {
  for (const op of snap.payload.fileOps) {
    requiredBackends.add(op.backend ?? "local");
  }
}

for (const backend of requiredBackends) {
  if (!backends.has(backend)) {
    return {
      ok: false,
      error: internal(
        `Rewind aborted — backend '${backend}' unavailable. No changes were made. ` +
        `Ensure the nexus backend is running and retry.`
      ),
    };
  }
}
```

- [ ] **Step 4: Thread backends map through RestoreInput**

Add `backends?: ReadonlyMap<string, FileSystemBackend>` to `RestoreInput` interface. Pass it through to `applyCompensatingOps`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/lib/checkpoint && bun test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/lib/checkpoint/src/restore-protocol.ts
git commit -m "feat(checkpoint): atomic rewind pre-flight — abort if any backend unavailable"
```

---

## Task 8: Wire Backend Discriminator in Checkpoint Preset Stack

**Files:**
- Modify: `packages/meta/cli/src/preset-stacks/checkpoint.ts`

The preset stack activates the checkpoint middleware. It needs to:
1. Pass backend discriminator during capture (read from session's filesystem context)
2. Build backends map for rewind (resolve available backends from session)

- [ ] **Step 1: Read checkpoint.ts fully**

Read: `packages/meta/cli/src/preset-stacks/checkpoint.ts` (all 102 lines)

Understand how `StackContribution` is built, where tool calls are intercepted, and where `resolvePath` is defined.

- [ ] **Step 2: Add backend to capture flow**

In the tool call interception (where `capturePreImage`/`capturePostImage` are called), pass the backend discriminator from the session's filesystem context. The exact mechanism depends on how the preset stack accesses the runtime context — read the code first.

- [ ] **Step 3: Build backends map for rewind**

In the rewind handler, construct a `Map<string, FileSystemBackend>` from the session's available backends. Pass it to `runRestore` via `RestoreInput.backends`.

- [ ] **Step 4: Run existing checkpoint tests**

Run: `bun run test --filter=@koi/checkpoint`
Expected: ALL PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/preset-stacks/checkpoint.ts
git commit -m "feat(checkpoint): wire backend discriminator in preset stack capture and rewind"
```

---

## Task 9: Add `--allow-remote-fs` Flag to `koi start`

**Files:**
- Modify: `packages/meta/cli/src/args/start.ts`
- Modify: `packages/meta/cli/src/commands/start.ts`

- [ ] **Step 1: Add flag to StartFlags interface**

In `packages/meta/cli/src/args/start.ts`, add to `StartFlags`:

```typescript
  /** Operator opt-in for nexus filesystem backends. Required with `--manifest` when backend is nexus. */
  readonly allowRemoteFs: boolean;
```

And in the `parseArgs` options:

```typescript
"allow-remote-fs": { type: "boolean", default: false },
```

And in the flags mapping:

```typescript
allowRemoteFs: parsed.values["allow-remote-fs"] ?? false,
```

- [ ] **Step 2: Replace blanket nexus rejection with two-gate**

In `packages/meta/cli/src/commands/start.ts`, replace lines 149-167 (the nexus rejection block) with:

```typescript
    if (manifestResult.value.filesystem?.backend === "nexus") {
      const scope = manifestResult.value.filesystem.root;
      const mode = manifestResult.value.filesystem.mode;

      // Gate 1: manifest must declare scope
      if (scope === undefined || mode === undefined) {
        process.stderr.write(
          "koi start: nexus backends require 'filesystem.root' and 'filesystem.mode' " +
            "in the manifest.\n" +
            "Add filesystem.root and filesystem.mode to your manifest, or use 'koi tui'.\n",
        );
        return ExitCode.FAILURE;
      }

      // Gate 2: operator must opt in
      if (!flags.allowRemoteFs) {
        process.stderr.write(
          "koi start: nexus filesystem backends require --allow-remote-fs.\n" +
            "This flag confirms the operator (not the manifest) authorizes remote storage access.\n" +
            `Scope: ${scope} (mode: ${mode})\n`,
        );
        return ExitCode.FAILURE;
      }
    }
```

- [ ] **Step 3: Write tests for the gate logic**

Create `packages/meta/cli/src/commands/__tests__/start-nexus-gate.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

// Test the gate logic in isolation by extracting it or testing via
// the command's exit code. The exact approach depends on how start.ts
// is structured — if `run()` is exported, call it with mock flags.

describe("koi start — nexus gate", () => {
  test("rejects nexus without scope", () => {
    // manifest: { filesystem: { backend: "nexus" } }  (no root, no mode)
    // flags: { allowRemoteFs: true }
    // Expected: ExitCode.FAILURE, stderr contains "require 'filesystem.root'"
  });

  test("rejects nexus with scope but without --allow-remote-fs", () => {
    // manifest: { filesystem: { backend: "nexus", root: "/mnt", mode: "rw" } }
    // flags: { allowRemoteFs: false }
    // Expected: ExitCode.FAILURE, stderr contains "require --allow-remote-fs"
  });

  test("accepts nexus with scope and --allow-remote-fs", () => {
    // manifest: { filesystem: { backend: "nexus", root: "/mnt", mode: "rw" } }
    // flags: { allowRemoteFs: true }
    // Expected: proceeds past gate (may fail later due to missing API key, etc.)
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun run test --filter=@koi/cli`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/args/start.ts packages/meta/cli/src/commands/start.ts packages/meta/cli/src/commands/__tests__/
git commit -m "feat(cli): replace blanket nexus reject with two-gate (scope + --allow-remote-fs)"
```

---

## Task 10: OAuth Auth Interceptor

**Files:**
- Create: `packages/meta/cli/src/auth-interceptor.ts`
- Create: `packages/meta/cli/src/auth-interceptor.test.ts`

Detects OAuth redirect URLs pasted by the user and routes them to `transport.submitAuthCode`.

- [ ] **Step 1: Write failing tests**

Create `packages/meta/cli/src/auth-interceptor.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isOAuthRedirectUrl, createAuthInterceptor } from "./auth-interceptor.js";

describe("isOAuthRedirectUrl", () => {
  test("matches localhost callback URL", () => {
    expect(isOAuthRedirectUrl("http://localhost:8080/callback?code=abc&state=xyz")).toBe(true);
  });

  test("matches localhost with different port", () => {
    expect(isOAuthRedirectUrl("http://localhost:3000/callback?code=abc")).toBe(true);
  });

  test("matches 127.0.0.1 callback URL", () => {
    expect(isOAuthRedirectUrl("http://127.0.0.1:8080/callback?code=abc")).toBe(true);
  });

  test("rejects normal user message", () => {
    expect(isOAuthRedirectUrl("what files are in my drive?")).toBe(false);
  });

  test("rejects non-callback URL", () => {
    expect(isOAuthRedirectUrl("https://example.com/page")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isOAuthRedirectUrl("")).toBe(false);
  });
});

describe("createAuthInterceptor", () => {
  test("calls submitAuthCode when redirect URL detected", () => {
    const submitted: { url: string; correlationId: string | undefined }[] = [];
    const transport = {
      submitAuthCode: (url: string, correlationId?: string) => {
        submitted.push({ url, correlationId });
      },
    };

    const interceptor = createAuthInterceptor(transport);
    const result = interceptor("http://localhost:8080/callback?code=abc", "corr-123");

    expect(result.intercepted).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.url).toBe("http://localhost:8080/callback?code=abc");
    expect(submitted[0]!.correlationId).toBe("corr-123");
  });

  test("passes through non-redirect messages", () => {
    const transport = {
      submitAuthCode: () => {},
    };

    const interceptor = createAuthInterceptor(transport);
    const result = interceptor("list my files", undefined);

    expect(result.intercepted).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/meta/cli && bun test src/auth-interceptor.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement auth-interceptor.ts**

```typescript
/**
 * OAuth redirect URL interceptor for TUI chat input.
 *
 * Detects when a user pastes an OAuth callback URL (localhost redirect)
 * and routes it to the nexus bridge transport's submitAuthCode method.
 */

/** Pattern: http://localhost:<port>/callback or http://127.0.0.1:<port>/callback with query params */
const OAUTH_CALLBACK_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/callback\b/i;

export function isOAuthRedirectUrl(message: string): boolean {
  return OAUTH_CALLBACK_PATTERN.test(message.trim());
}

interface AuthTransport {
  readonly submitAuthCode: (redirectUrl: string, correlationId?: string) => void;
}

interface InterceptResult {
  readonly intercepted: boolean;
}

export function createAuthInterceptor(
  transport: AuthTransport,
): (message: string, correlationId: string | undefined) => InterceptResult {
  return (message: string, correlationId: string | undefined): InterceptResult => {
    const trimmed = message.trim();
    if (!isOAuthRedirectUrl(trimmed)) {
      return { intercepted: false };
    }
    transport.submitAuthCode(trimmed, correlationId);
    return { intercepted: true };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/meta/cli && bun test src/auth-interceptor.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/auth-interceptor.ts packages/meta/cli/src/auth-interceptor.test.ts
git commit -m "feat(cli): add OAuth redirect URL interceptor for TUI auth flow"
```

---

## Task 11: Wire Auth Loop in TUI Command

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts`

Wire `createAuthNotificationHandler` (outbound) and `createAuthInterceptor` (inbound) into the TUI when a nexus backend with local-bridge transport is resolved.

- [ ] **Step 1: Read tui-command.ts to find the wiring point**

Read: `packages/meta/cli/src/tui-command.ts`

Find where `resolveFileSystemAsync` is called (or should be called), where the channel is created, and where user messages are received.

- [ ] **Step 2: Wire outbound auth notifications**

After `resolveFileSystemAsync()` returns, pass `createAuthNotificationHandler(channel)` as the `onNotification` callback:

```typescript
import { createAuthNotificationHandler } from "@koi/fs-nexus";
import { createAuthInterceptor } from "./auth-interceptor.js";

// In the nexus backend resolution path:
const { backend, operations, transport } = await resolveFileSystemAsync(
  config,
  cwd,
  createAuthNotificationHandler(channel),
);
```

- [ ] **Step 3: Wire inbound auth interceptor**

Create the interceptor and hook it into the TUI's message receive path:

```typescript
const authInterceptor = transport !== undefined
  ? createAuthInterceptor(transport)
  : undefined;

// In the message receive handler, before passing to engine:
if (authInterceptor !== undefined) {
  const result = authInterceptor(userMessage, currentCorrelationId);
  if (result.intercepted) {
    // Show confirmation in TUI, don't send to model
    channel.send({ kind: "system", content: "OAuth redirect received — authenticating..." });
    return;
  }
}
```

- [ ] **Step 4: Add correlation ID tracking**

When `auth_required` notification fires with `mode: "remote"`, store `correlationId` in a mutable ref that the interceptor reads:

```typescript
let currentCorrelationId: string | undefined;

const onNotification = (n: BridgeNotification) => {
  if (n.method === "auth_required" && n.params.mode === "remote") {
    currentCorrelationId = n.params.correlation_id;
  }
  createAuthNotificationHandler(channel)(n);
};
```

- [ ] **Step 5: Run existing TUI tests**

Run: `bun run test --filter=@koi/cli`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(tui): wire OAuth auth notification loop for nexus local-bridge"
```

---

## Task 12: Reject OAuth Mounts on `koi start` + Relax Scheme Allowlist

**Files:**
- Modify: `packages/meta/cli/src/commands/start.ts`
- Modify: `packages/meta/cli/src/manifest.ts`

- [ ] **Step 1: Add OAuth scheme rejection to start.ts**

After the two-gate check (from Task 9), add:

```typescript
    // OAuth-gated schemes require interactive auth UI (koi tui)
    if (manifestResult.value.filesystem?.options?.mountUri !== undefined) {
      const uri = String(manifestResult.value.filesystem.options.mountUri);
      if (/^(gdrive|gmail|s3|dropbox):\/\//i.test(uri)) {
        process.stderr.write(
          `koi start: OAuth-gated mount '${uri.split("://")[0]}://' requires interactive authentication.\n` +
            "Use 'koi tui' for OAuth-gated mounts.\n",
        );
        return ExitCode.FAILURE;
      }
    }
```

- [ ] **Step 2: Relax scheme allowlist in manifest.ts**

In `packages/meta/cli/src/manifest.ts`, find `SUPPORTED_NEXUS_LOCAL_BRIDGE_SCHEMES` or the scheme validation block (around lines 396-436). Remove the reject for OAuth schemes when the TUI auth loop is wired. Add a comment noting that `koi start` has its own rejection in the command handler.

The exact change depends on the current allowlist structure — read the code first.

- [ ] **Step 3: Run tests**

Run: `bun run test --filter=@koi/cli`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/meta/cli/src/commands/start.ts packages/meta/cli/src/manifest.ts
git commit -m "feat(cli): reject OAuth mounts on koi start, relax scheme allowlist for koi tui"
```

---

## Task 13: Backend Label in Approval Display

**Files:**
- Modify: TUI approval rendering (find the exact file by grepping for `resolveFsPath` or approval prompt rendering in `packages/meta/cli/src/`)

- [ ] **Step 1: Find the approval display code**

Grep for `resolveFsPath`, `approval`, or `approve` in `packages/meta/cli/src/` to locate where filesystem tool calls are displayed for user approval.

- [ ] **Step 2: Add backend label for non-local backends**

When the filesystem backend is not `"local"`, prefix the path display with `[nexus: <transport>]`. The exact mechanism depends on how the approval handler accesses backend metadata — it may need to be threaded through the runtime context.

```typescript
// Pseudocode for approval display:
const pathDisplay = backend === "local"
  ? resolvedPath
  : `[nexus: ${transport}] ${resolvedPath}`;
```

- [ ] **Step 3: Run tests**

Run: `bun run test --filter=@koi/cli`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/meta/cli/src/
git commit -m "feat(tui): show backend label in approval prompts for non-local filesystems"
```

---

## Task 14: Accept Nexus in TUI Command

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts`

Remove any remaining nexus rejection in the TUI path. TUI has interactive approval — it accepts nexus with or without scope.

- [ ] **Step 1: Find and remove nexus rejection in tui-command.ts**

Search for any `backend === "nexus"` rejection in `tui-command.ts`. Remove it. If scope is declared, wrap with `createScopedFileSystem`. If not, proceed without scope (interactive approval covers it).

- [ ] **Step 2: Run tests**

Run: `bun run test --filter=@koi/cli`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(tui): accept nexus filesystem backends (interactive approval as trust boundary)"
```

---

## Task 15: Integration Tests + Layer Check

**Files:**
- Various test files

- [ ] **Step 1: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

- [ ] **Step 2: Run layer check**

Run: `bun run check:layers`
Expected: PASS — `@koi/fs-scoped` only imports from `@koi/core`, no layer violations

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes"
```

---

## Task 16: Final Verification

- [ ] **Step 1: Verify all acceptance criteria from issue #1814**

Check each item:
- All 4 gaps have merged fixes
- `koi start --manifest` accepts `backend: nexus` with `--allow-remote-fs` + scope
- `koi tui --manifest` accepts `backend: nexus` (with or without scope)
- Scheme allowlist relaxed
- Nexus-reject branches removed from both `start.ts` and `tui-command.ts`

- [ ] **Step 2: Run full CI gate**

```bash
bun run test
bun run typecheck
bun run lint
bun run check:layers
```

Expected: ALL PASS

- [ ] **Step 3: Review all changes**

Run: `git log --oneline main..HEAD`
Verify commit history is clean, each commit is self-contained.
