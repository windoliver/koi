/**
 * Tests for path-traversal guards.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveBaseDir, resolveSafePath } from "./path-safety.js";

const CWD = "/tmp/koi-test-project";

describe("resolveBaseDir", () => {
  test("accepts a relative path under cwd", () => {
    const result = resolveBaseDir(".koi/plans", CWD);
    expect(result).toEqual({ ok: true, path: resolve(CWD, ".koi/plans") });
  });

  test("accepts cwd itself", () => {
    const result = resolveBaseDir(".", CWD);
    expect(result).toEqual({ ok: true, path: CWD });
  });

  test("accepts an absolute path under cwd", () => {
    const abs = resolve(CWD, "plans");
    const result = resolveBaseDir(abs, CWD);
    expect(result).toEqual({ ok: true, path: abs });
  });

  test("rejects an absolute path outside cwd", () => {
    const result = resolveBaseDir("/etc", CWD);
    expect(result.ok).toBe(false);
  });

  test("rejects parent traversal", () => {
    const result = resolveBaseDir("../escape", CWD);
    expect(result.ok).toBe(false);
  });

  test("rejects baseDir containing NUL byte", () => {
    const result = resolveBaseDir("plans\u0000bad", CWD);
    expect(result.ok).toBe(false);
  });
});

describe("resolveSafePath", () => {
  const baseDir = resolve(CWD, ".koi/plans");
  const fakeFs = {
    realpath: (p: string): Promise<string> => Promise.resolve(p),
  };

  test("accepts a relative path under baseDir", async () => {
    const result = await resolveSafePath(".koi/plans/x.md", baseDir, baseDir, CWD, fakeFs);
    expect(result).toEqual({ ok: true, path: resolve(CWD, ".koi/plans/x.md") });
  });

  test("accepts an absolute path under baseDir", async () => {
    const abs = resolve(baseDir, "x.md");
    const result = await resolveSafePath(abs, baseDir, baseDir, CWD, fakeFs);
    expect(result.ok).toBe(true);
  });

  test("rejects parent traversal at literal level", async () => {
    const result = await resolveSafePath(
      ".koi/plans/../../../etc/passwd",
      baseDir,
      baseDir,
      CWD,
      fakeFs,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("path outside baseDir");
    }
  });

  test("rejects when realpath escapes baseDir (symlink)", async () => {
    const escapingFs = {
      realpath: (_p: string): Promise<string> => Promise.resolve("/etc/passwd"),
    };
    const result = await resolveSafePath(
      ".koi/plans/looks-safe.md",
      baseDir,
      baseDir,
      CWD,
      escapingFs,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("path outside baseDir");
    }
  });

  test("rejects path with NUL byte", async () => {
    const result = await resolveSafePath(".koi/plans/x\u0000.md", baseDir, baseDir, CWD, fakeFs);
    expect(result.ok).toBe(false);
  });

  test("returns file-not-found when realpath fails", async () => {
    const enoFs = {
      realpath: (_p: string): Promise<string> => Promise.reject(new Error("ENOENT")),
    };
    const result = await resolveSafePath(".koi/plans/missing.md", baseDir, baseDir, CWD, enoFs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("file not found");
    }
  });
});
