import { describe, expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import type { FileSystemBackend, KoiError, Result } from "@koi/core";
import { compileFileSystemScope, createScopedFileSystem } from "./scoped-filesystem.js";

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

function createMockBackend(name = "mock"): FileSystemBackend & {
  readonly lastReadPath: () => string | undefined;
  readonly lastWritePath: () => string | undefined;
  readonly lastEditPath: () => string | undefined;
  readonly lastListPath: () => string | undefined;
  readonly lastDeletePath: () => string | undefined;
  readonly lastRenameArgs: () => { from: string; to: string } | undefined;
} {
  let lastRead: string | undefined;
  let lastWrite: string | undefined;
  let lastEdit: string | undefined;
  let lastList: string | undefined;
  let lastDel: string | undefined;
  let lastRen: { from: string; to: string } | undefined;

  return {
    name,
    read(p) {
      lastRead = p;
      return { ok: true, value: { content: "", path: p, size: 0 } };
    },
    write(p, _content) {
      lastWrite = p;
      return { ok: true, value: { path: p, bytesWritten: 0 } };
    },
    edit(p, _edits) {
      lastEdit = p;
      return { ok: true, value: { path: p, hunksApplied: 0 } };
    },
    list(p) {
      lastList = p;
      return { ok: true, value: { entries: [], truncated: false } };
    },
    search(_pattern) {
      return { ok: true, value: { matches: [], truncated: false } };
    },
    delete(p) {
      lastDel = p;
      return { ok: true, value: { path: p } };
    },
    rename(from, to) {
      lastRen = { from, to };
      return { ok: true, value: { from, to } };
    },
    lastReadPath: () => lastRead,
    lastWritePath: () => lastWrite,
    lastEditPath: () => lastEdit,
    lastListPath: () => lastList,
    lastDeletePath: () => lastDel,
    lastRenameArgs: () => lastRen,
  };
}

function isErr(
  r: Result<unknown, KoiError>,
): r is { readonly ok: false; readonly error: KoiError } {
  return !r.ok;
}

// ---------------------------------------------------------------------------
// compileFileSystemScope
// ---------------------------------------------------------------------------

describe("compileFileSystemScope", () => {
  test("resolves relative root to absolute", () => {
    const compiled = compileFileSystemScope({ root: "workspace/src", mode: "rw" });
    expect(compiled.root).toBe(resolve("workspace/src"));
  });

  test("preserves absolute root", () => {
    const compiled = compileFileSystemScope({ root: "/workspace/src", mode: "rw" });
    expect(compiled.root).toBe("/workspace/src");
  });

  test("stores rootWithSep correctly", () => {
    const compiled = compileFileSystemScope({ root: "/workspace/src", mode: "ro" });
    expect(compiled.rootWithSep).toBe(`/workspace/src${sep}`);
  });
});

// ---------------------------------------------------------------------------
// createScopedFileSystem — path normalization
// ---------------------------------------------------------------------------

describe("createScopedFileSystem", () => {
  describe("path normalization", () => {
    test("allows paths within root", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src/file.ts");
      expect(r).toHaveProperty("ok", true);
      expect(backend.lastReadPath()).toBe("/workspace/src/file.ts");
    });

    test("allows root path exactly", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.list("/workspace/src");
      expect(r).toHaveProperty("ok", true);
    });

    test("rejects ../ traversal", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src/../etc/passwd") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        expect(r.error.code).toBe("PERMISSION");
        expect(r.error.message).toContain("escapes root");
      }
    });

    test("rejects ../../ deep traversal", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src/../../etc/passwd") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    });

    test("rejects mixed ./../../ patterns", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src/./../../etc/shadow") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
    });

    test("rejects path at root/../sibling boundary", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src/../other/file.ts") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
    });

    test("rejects absolute path outside root", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/etc/passwd") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    });

    test("allows nested subdirectory paths", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src/deep/nested/file.ts");
      expect(r).toHaveProperty("ok", true);
    });

    test("handles trailing slashes", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src/", mode: "rw" });
      const r = scoped.read("/workspace/src/file.ts");
      expect(r).toHaveProperty("ok", true);
    });

    test("rejects path that is prefix of root but not a child", () => {
      // /workspace/src-extra is NOT a child of /workspace/src
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/workspace/src-extra/file.ts") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Read-only mode
  // ---------------------------------------------------------------------------

  describe("read-only mode", () => {
    test("allows read in ro mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const r = scoped.read("/workspace/file.ts");
      expect(r).toHaveProperty("ok", true);
    });

    test("allows list in ro mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const r = scoped.list("/workspace");
      expect(r).toHaveProperty("ok", true);
    });

    test("allows search in ro mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const r = scoped.search("pattern");
      expect(r).toHaveProperty("ok", true);
    });

    test("rejects write in ro mode with permission error", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const r = scoped.write("/workspace/file.ts", "content") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        expect(r.error.code).toBe("PERMISSION");
        expect(r.error.message).toContain("read-only");
      }
    });

    test("rejects edit in ro mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const r = scoped.edit("/workspace/file.ts", []) as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    });

    test("rejects delete in ro mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const del = scoped.delete;
      expect(del).toBeDefined();
      if (del === undefined) return;
      const r = del("/workspace/file.ts") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    });

    test("rejects rename in ro mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "ro" });
      const ren = scoped.rename;
      expect(ren).toBeDefined();
      if (ren === undefined) return;
      const r = ren("/workspace/a.ts", "/workspace/b.ts") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    });
  });

  // ---------------------------------------------------------------------------
  // Read-write mode
  // ---------------------------------------------------------------------------

  describe("read-write mode", () => {
    test("allows read in rw mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
      const r = scoped.read("/workspace/file.ts");
      expect(r).toHaveProperty("ok", true);
    });

    test("allows write in rw mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
      const r = scoped.write("/workspace/file.ts", "content");
      expect(r).toHaveProperty("ok", true);
    });

    test("allows edit in rw mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
      const r = scoped.edit("/workspace/file.ts", []);
      expect(r).toHaveProperty("ok", true);
    });

    test("allows delete in rw mode", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
      const del = scoped.delete;
      expect(del).toBeDefined();
      if (del === undefined) return;
      const r = del("/workspace/file.ts");
      expect(r).toHaveProperty("ok", true);
    });

    test("allows rename in rw mode within scope", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
      const ren = scoped.rename;
      expect(ren).toBeDefined();
      if (ren === undefined) return;
      const r = ren("/workspace/a.ts", "/workspace/b.ts");
      expect(r).toHaveProperty("ok", true);
    });

    test("rejects rename when destination escapes root", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
      const ren = scoped.rename;
      expect(ren).toBeDefined();
      if (ren === undefined) return;
      const r = ren("/workspace/a.ts", "/other/b.ts") as Result<unknown, KoiError>;
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    });
  });

  // ---------------------------------------------------------------------------
  // Error messages
  // ---------------------------------------------------------------------------

  describe("error messages", () => {
    test("includes escaped path in error", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/etc/passwd") as Result<unknown, KoiError>;
      if (isErr(r)) {
        expect(r.error.message).toContain("/etc/passwd");
      }
    });

    test("includes root in error", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/etc/passwd") as Result<unknown, KoiError>;
      if (isErr(r)) {
        expect(r.error.message).toContain("/workspace/src");
      }
    });

    test("includes actionable guidance", () => {
      const backend = createMockBackend();
      const scoped = createScopedFileSystem(backend, { root: "/workspace/src", mode: "rw" });
      const r = scoped.read("/etc/passwd") as Result<unknown, KoiError>;
      if (isErr(r)) {
        expect(r.error.message).toContain("restricted to");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  test("sets name with scoped prefix", () => {
    const backend = createMockBackend("local-fs");
    const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
    expect(scoped.name).toBe("scoped(local-fs)");
  });

  test("preserves optional methods from backend", () => {
    const backend = createMockBackend();
    const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
    expect(scoped.delete).toBeDefined();
    expect(scoped.rename).toBeDefined();
  });

  test("omits optional methods when backend lacks them", () => {
    const backend: FileSystemBackend = {
      name: "minimal",
      read: () => ({ ok: true, value: { content: "", path: "", size: 0 } }),
      write: () => ({ ok: true, value: { path: "", bytesWritten: 0 } }),
      edit: () => ({ ok: true, value: { path: "", hunksApplied: 0 } }),
      list: () => ({ ok: true, value: { entries: [], truncated: false } }),
      search: () => ({ ok: true, value: { matches: [], truncated: false } }),
    };
    const scoped = createScopedFileSystem(backend, { root: "/workspace", mode: "rw" });
    expect(scoped.delete).toBeUndefined();
    expect(scoped.rename).toBeUndefined();
  });
});
