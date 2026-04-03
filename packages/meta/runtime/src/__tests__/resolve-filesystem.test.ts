import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileSystem, validateFileSystemConfig } from "../resolve-filesystem.js";

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
