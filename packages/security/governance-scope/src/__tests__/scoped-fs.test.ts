import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { createScopedFs } from "../scoped-fs.js";

// ---------------------------------------------------------------------------
// Test backend — records the path each method was called with so tests can
// confirm the scoped wrapper passed the realpath-resolved path through.
// ---------------------------------------------------------------------------

interface MockBackend extends FileSystemBackend {
  readonly calls: { readonly op: string; readonly path: string }[];
}

function createMockBackend(): MockBackend {
  const calls: { op: string; path: string }[] = [];
  const backend: FileSystemBackend = {
    name: "mock",
    read(p: string, _options?: FileReadOptions): Result<FileReadResult, KoiError> {
      calls.push({ op: "read", path: p });
      return { ok: true, value: { content: "", path: p, size: 0 } };
    },
    write(p: string, _c: string, _options?: FileWriteOptions): Result<FileWriteResult, KoiError> {
      calls.push({ op: "write", path: p });
      return { ok: true, value: { path: p, bytesWritten: 0 } };
    },
    edit(
      p: string,
      _edits: readonly FileEdit[],
      _options?: FileEditOptions,
    ): Result<FileEditResult, KoiError> {
      calls.push({ op: "edit", path: p });
      return { ok: true, value: { path: p, hunksApplied: 0 } };
    },
    list(p: string, _options?: FileListOptions): Result<FileListResult, KoiError> {
      calls.push({ op: "list", path: p });
      return { ok: true, value: { entries: [], truncated: false } };
    },
    search(p: string, _options?: FileSearchOptions): Result<FileSearchResult, KoiError> {
      calls.push({ op: "search", path: p });
      return { ok: true, value: { matches: [], truncated: false } };
    },
    delete(p: string) {
      calls.push({ op: "delete", path: p });
      return { ok: true, value: { path: p } };
    },
    rename(from: string, to: string) {
      calls.push({ op: "rename", path: `${from}|${to}` });
      return { ok: true, value: { from, to } };
    },
  };
  return Object.assign(backend, { calls }) as MockBackend;
}

function isErr(
  r: Result<unknown, KoiError>,
): r is { readonly ok: false; readonly error: KoiError } {
  return !r.ok;
}

function sync<T>(r: Result<T, KoiError> | Promise<Result<T, KoiError>>): Result<T, KoiError> {
  if (r instanceof Promise) throw new Error("expected sync result in test");
  return r;
}

// ---------------------------------------------------------------------------
// Real-fs fixture — needed to exercise realpath / symlink behaviour.
// ---------------------------------------------------------------------------

let dir: string;
let scope: string;
let outside: string;

beforeEach(() => {
  // realpathSync collapses macOS' /var → /private/var symlink so the
  // canonical path matches the allow globs we compile in tests.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "scoped-fs-")));
  scope = join(dir, "scope");
  outside = join(dir, "outside");
  mkdirSync(scope, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(scope, "ok.ts"), "ok");
  writeFileSync(join(outside, "secret.txt"), "secret");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

describe("createScopedFs — path containment", () => {
  test("allows reads inside the scope", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = sync(fs.read(join(scope, "ok.ts")));
    expect(r.ok).toBe(true);
    expect(backend.calls.at(-1)?.path).toBe(join(scope, "ok.ts"));
  });

  test("blocks paths entirely outside the scope", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = fs.read(join(outside, "secret.txt")) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    expect(backend.calls.length).toBe(0);
  });

  test("blocks `..` traversal that escapes the scope", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = fs.read(`${scope}/../outside/secret.txt`) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });

  test("supports multiple allow globs", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, {
      allow: [`${scope}/**`, `${outside}/**`],
      mode: "rw",
    });
    expect(sync(fs.read(join(scope, "ok.ts"))).ok).toBe(true);
    expect(sync(fs.read(join(outside, "secret.txt"))).ok).toBe(true);
  });

  test("blocks symlink that escapes the scope", () => {
    symlinkSync(outside, join(scope, "escape"));
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = fs.read(join(scope, "escape", "secret.txt")) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
  });

  test("allows write of a not-yet-existing file inside the scope", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = sync(fs.write(join(scope, "new.ts"), "content"));
    expect(r.ok).toBe(true);
  });

  test("blocks write of a not-yet-existing file outside the scope", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = fs.write(join(outside, "new.txt"), "content") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });

  test("blocks write into a symlinked-out directory even if file does not exist", () => {
    symlinkSync(outside, join(scope, "esc"));
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "rw" });
    const r = fs.write(join(scope, "esc", "new.txt"), "x") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------

describe("createScopedFs — read-only mode", () => {
  test("allows read", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    expect(sync(fs.read(join(scope, "ok.ts"))).ok).toBe(true);
  });

  test("blocks write", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    const r = fs.write(join(scope, "ok.ts"), "x") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
  });

  test("blocks edit", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    const r = fs.edit(join(scope, "ok.ts"), []) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });

  test("blocks delete", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    const del = fs.delete;
    if (!del) throw new Error("delete missing");
    const r = del(join(scope, "ok.ts")) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });

  test("blocks rename", () => {
    const backend = createMockBackend();
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    const ren = fs.rename;
    if (!ren) throw new Error("rename missing");
    const r = ren(join(scope, "ok.ts"), join(scope, "renamed.ts")) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

describe("createScopedFs — search", () => {
  test("filters out matches outside the scope", () => {
    const okPath = join(scope, "ok.ts");
    const secretPath = join(outside, "secret.txt");
    const backend: FileSystemBackend = {
      name: "mock",
      read: (p) => ({ ok: true, value: { content: "", path: p, size: 0 } }),
      write: (p) => ({ ok: true, value: { path: p, bytesWritten: 0 } }),
      edit: (p) => ({ ok: true, value: { path: p, hunksApplied: 0 } }),
      list: () => ({ ok: true, value: { entries: [], truncated: false } }),
      search: () => ({
        ok: true,
        value: {
          matches: [
            { path: okPath, line: 1, text: "x" },
            { path: secretPath, line: 1, text: "x" },
          ],
          truncated: false,
        },
      }),
    };
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    const r = fs.search("x") as Result<FileSearchResult, KoiError>;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.matches.length).toBe(1);
      expect(r.value.matches[0]?.path).toBe(okPath);
    }
  });
});

// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------

describe("createScopedFs — resolvePath", () => {
  test("returns undefined for paths outside the scope", () => {
    const backend: FileSystemBackend = {
      name: "mock",
      read: (p) => ({ ok: true, value: { content: "", path: p, size: 0 } }),
      write: (p) => ({ ok: true, value: { path: p, bytesWritten: 0 } }),
      edit: (p) => ({ ok: true, value: { path: p, hunksApplied: 0 } }),
      list: () => ({ ok: true, value: { entries: [], truncated: false } }),
      search: () => ({ ok: true, value: { matches: [], truncated: false } }),
      resolvePath: (p) => p,
    };
    const fs = createScopedFs(backend, { allow: [`${scope}/**`], mode: "ro" });
    expect(fs.resolvePath?.(join(scope, "ok.ts"))).toBe(join(scope, "ok.ts"));
    expect(fs.resolvePath?.(join(outside, "secret.txt"))).toBeUndefined();
  });
});

// avoid unused-warning shimmer
void sep;
