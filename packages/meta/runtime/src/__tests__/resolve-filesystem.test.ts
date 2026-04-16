import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFileSystem,
  resolveFileSystemAsync,
  validateFileSystemConfig,
} from "../resolve-filesystem.js";

const tmpBase = mkdtempSync(join(tmpdir(), "koi-resolve-fs-test-"));

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveFileSystem — dispatch
// ---------------------------------------------------------------------------

describe("resolveFileSystem", () => {
  test("defaults to local backend when config is undefined", () => {
    const backend = resolveFileSystem(undefined, tmpBase);
    expect(backend.name).toBe("local");
  });

  test("creates local backend for backend: 'local'", () => {
    const backend = resolveFileSystem({ backend: "local" }, tmpBase);
    expect(backend.name).toBe("local");
  });

  test("creates local backend when backend is absent (only options)", () => {
    const backend = resolveFileSystem({}, tmpBase);
    expect(backend.name).toBe("local");
  });

  test("local backend can read/write files", async () => {
    const backend = resolveFileSystem(undefined, tmpBase);
    await backend.write("resolve-test.txt", "hello dispatch");
    const result = await backend.read("resolve-test.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("hello dispatch");
  });

  test("creates nexus backend for backend: 'nexus' with valid options", () => {
    const backend = resolveFileSystem(
      {
        backend: "nexus",
        options: { url: "http://localhost:3100", mountPoint: "test" },
      },
      tmpBase,
    );
    expect(backend.name).toBe("nexus");
  });

  test("throws on backend: 'nexus' without options", () => {
    expect(() => resolveFileSystem({ backend: "nexus" }, tmpBase)).toThrow(
      /Invalid nexus filesystem config/,
    );
  });

  test("throws on backend: 'nexus' with empty options", () => {
    expect(() => resolveFileSystem({ backend: "nexus", options: {} }, tmpBase)).toThrow(
      /url must be a non-empty string/,
    );
  });

  test("throws on backend: 'nexus' with invalid url scheme", () => {
    expect(() =>
      resolveFileSystem({ backend: "nexus", options: { url: "ftp://bad" } }, tmpBase),
    ).toThrow(/http:\/\/ or https:\/\//);
  });
});

// ---------------------------------------------------------------------------
// validateFileSystemConfig — Zod schema validation
// ---------------------------------------------------------------------------

describe("validateFileSystemConfig", () => {
  test("accepts undefined (defaults to empty config)", () => {
    const result = validateFileSystemConfig(undefined);
    expect(result.ok).toBe(true);
  });

  test("accepts null (defaults to empty config)", () => {
    const result = validateFileSystemConfig(null);
    expect(result.ok).toBe(true);
  });

  test("accepts empty object", () => {
    const result = validateFileSystemConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts backend: 'local'", () => {
    const result = validateFileSystemConfig({ backend: "local" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.backend).toBe("local");
  });

  test("accepts backend: 'nexus' with options", () => {
    const result = validateFileSystemConfig({
      backend: "nexus",
      options: { url: "http://localhost:3100" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.backend).toBe("nexus");
  });

  test("rejects backend: 'auto' (not yet supported)", () => {
    const result = validateFileSystemConfig({ backend: "auto" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("backend");
    }
  });

  test("rejects unknown backend value", () => {
    const result = validateFileSystemConfig({ backend: "s3" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects non-object input", () => {
    const result = validateFileSystemConfig("local");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects unknown properties (strict mode)", () => {
    const result = validateFileSystemConfig({ backend: "local", unknown: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects backend as number", () => {
    const result = validateFileSystemConfig({ backend: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// Scoped filesystem wrapping
// ---------------------------------------------------------------------------

describe("resolveFileSystem — scoped wrapping", () => {
  test("wraps local backend with scope when options.root and options.mode are present", () => {
    const scopeDir = mkdtempSync(join(tmpdir(), "koi-scope-test-"));
    try {
      const backend = resolveFileSystem(
        { backend: "local", options: { root: scopeDir, mode: "ro" } },
        tmpBase,
      );
      expect(backend.name).toBe(`scoped(local)`);
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  test("does NOT wrap when only root is present (mode missing)", () => {
    const backend = resolveFileSystem({ backend: "local", options: { root: tmpBase } }, tmpBase);
    expect(backend.name).toBe("local");
  });

  test("does NOT wrap when only mode is present (root missing)", () => {
    const backend = resolveFileSystem({ backend: "local", options: { mode: "rw" } }, tmpBase);
    expect(backend.name).toBe("local");
  });

  test("does NOT wrap when mode is invalid (not ro/rw)", () => {
    const backend = resolveFileSystem(
      { backend: "local", options: { root: tmpBase, mode: "rwx" } },
      tmpBase,
    );
    expect(backend.name).toBe("local");
  });

  test("resolves relative root against cwd", () => {
    const backend = resolveFileSystem(
      { backend: "local", options: { root: ".", mode: "ro" } },
      tmpBase,
    );
    expect(backend.name).toBe("scoped(local)");
  });

  test("scoped backend allows reads inside root (ro)", async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), "koi-scope-ro-test-"));
    try {
      const backend = resolveFileSystem(
        { backend: "local", options: { root: scopeDir, mode: "ro" } },
        tmpBase,
      );
      // Write directly to disk then read via backend using relative path
      writeFileSync(join(scopeDir, "allowed.txt"), "ok");
      const readOk = await backend.read("allowed.txt");
      expect(readOk.ok).toBe(true);
      if (readOk.ok) expect(readOk.value.content).toBe("ok");
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  test("scoped backend blocks access outside root (ro) via path traversal", async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), "koi-scope-ro-escape-test-"));
    try {
      const backend = resolveFileSystem(
        { backend: "local", options: { root: scopeDir, mode: "ro" } },
        tmpBase,
      );
      // Attempt to escape scope via path traversal
      const readBlocked = await backend.read("../escape.txt");
      expect(readBlocked.ok).toBe(false);
      if (!readBlocked.ok) expect(readBlocked.error.code).toBe("PERMISSION");
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  test("scoped backend blocks writes in ro mode", async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), "koi-scope-ro-write-test-"));
    try {
      const backend = resolveFileSystem(
        { backend: "local", options: { root: scopeDir, mode: "ro" } },
        tmpBase,
      );
      const result = await backend.write("blocked.txt", "data");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PERMISSION");
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  test("scoped backend allows writes in rw mode", async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), "koi-scope-rw-test-"));
    try {
      const backend = resolveFileSystem(
        { backend: "local", options: { root: scopeDir, mode: "rw" } },
        tmpBase,
      );
      const result = await backend.write("allowed.txt", "data");
      expect(result.ok).toBe(true);
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  test("nexus backend gets scoped when options include root and mode alongside url", () => {
    const backend = resolveFileSystem(
      {
        backend: "nexus",
        options: { url: "http://localhost:3100", mountPoint: "test", root: tmpBase, mode: "ro" },
      },
      tmpBase,
    );
    expect(backend.name).toBe("scoped(nexus)");
  });
});

describe("resolveFileSystemAsync — scoped wrapping", () => {
  test("wraps local backend with scope when options.root and options.mode are present", async () => {
    const scopeDir = mkdtempSync(join(tmpdir(), "koi-async-scope-test-"));
    try {
      const result = await resolveFileSystemAsync(
        { backend: "local", options: { root: scopeDir, mode: "rw" } },
        tmpBase,
      );
      expect(result.backend.name).toBe("scoped(local)");
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  });

  test("does NOT wrap local backend when scope is absent", async () => {
    const result = await resolveFileSystemAsync(undefined, tmpBase);
    expect(result.backend.name).toBe("local");
  });

  test("does NOT wrap when partial scope config (root only)", async () => {
    const result = await resolveFileSystemAsync(
      { backend: "local", options: { root: tmpBase } },
      tmpBase,
    );
    expect(result.backend.name).toBe("local");
  });

  test("nexus HTTP backend gets scoped when options include root and mode", async () => {
    const result = await resolveFileSystemAsync(
      {
        backend: "nexus",
        options: { url: "http://localhost:3100", mountPoint: "test", root: tmpBase, mode: "rw" },
      },
      tmpBase,
    );
    expect(result.backend.name).toBe("scoped(nexus)");
  });
});
