import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { runFileSystemBackendContractTests } from "@koi/fs-nexus/testing";
import { createLocalFileSystem } from "./local-filesystem-backend.js";

// ---------------------------------------------------------------------------
// Shared temp directory — one per test run, cleaned up after all tests
// ---------------------------------------------------------------------------

const tmpBase = mkdtempSync(join(tmpdir(), "koi-fs-local-test-"));

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract tests — proves LocalFileSystem satisfies FileSystemBackend
// ---------------------------------------------------------------------------

describe("LocalFileSystemBackend (contract)", () => {
  // let: mutable — reset per test to isolate state
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpBase, "contract-"));
  });

  runFileSystemBackendContractTests(() => createLocalFileSystem(testDir));
});

// ---------------------------------------------------------------------------
// Local-specific tests
// ---------------------------------------------------------------------------

describe("LocalFileSystemBackend (local-specific)", () => {
  // let: mutable — reset per test to isolate state
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpBase, "local-"));
  });

  test("rejects path traversal with ..", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.read("../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("treats /etc/passwd as workspace-relative (contract convention)", async () => {
    const backend = createLocalFileSystem(testDir);
    // FileSystemBackend contract: leading "/" is stripped, path is workspace-relative.
    // /etc/passwd → <workspace>/etc/passwd → NOT_FOUND (doesn't exist in workspace).
    // Actual filesystem escape is prevented by the symlink containment check.
    const result = await backend.read("/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("accepts absolute path inside root", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("inside.txt", "hello");
    // Use realpathSync because the backend resolves the root with realpath
    // (on macOS, /var → /private/var)
    const realTestDir = realpathSync(testDir);
    const result = await backend.read(`${realTestDir}/inside.txt`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("hello");
  });

  test("rename moves file and returns correct result", async () => {
    const backend = createLocalFileSystem(testDir);
    expect(backend.rename).toBeDefined();
    await backend.write("src.txt", "content");
    const renameResult = await backend.rename?.("src.txt", "dst.txt");
    expect(renameResult).toBeDefined();
    if (renameResult === undefined) return;
    expect(renameResult.ok).toBe(true);
    if (renameResult.ok) {
      expect(renameResult.value.from).toBe("src.txt");
      expect(renameResult.value.to).toBe("dst.txt");
    }

    // Source should be gone
    const readSrc = await backend.read("src.txt");
    expect(readSrc.ok).toBe(false);

    // Destination should have the content
    const readDst = await backend.read("dst.txt");
    expect(readDst.ok).toBe(true);
    if (readDst.ok) expect(readDst.value.content).toBe("content");
  });

  test("rename creates parent directories for destination", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("flat.txt", "nested");
    const result = await backend.rename?.("flat.txt", "sub/dir/moved.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(true);

    const read = await backend.read("sub/dir/moved.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("nested");
  });

  test("rename rejects path traversal on source", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.rename?.("../../etc/passwd", "stolen.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("rename rejects path traversal on destination", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("legit.txt", "data");
    const result = await backend.rename?.("legit.txt", "../../escaped.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("write with createDirectories creates parent dirs", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.write("a/b/c/deep.txt", "deep content", {
      createDirectories: true,
    });
    expect(result.ok).toBe(true);

    const read = await backend.read("a/b/c/deep.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("deep content");
  });

  test("write with overwrite false returns CONFLICT for existing file", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("exists.txt", "original");
    const result = await backend.write("exists.txt", "replacement", { overwrite: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  test("delete rejects path traversal", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.delete?.("../../etc/important");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("dispose is a no-op", () => {
    const backend = createLocalFileSystem(testDir);
    // Should not throw
    backend.dispose?.();
  });

  test("backend name is 'local'", () => {
    const backend = createLocalFileSystem(testDir);
    expect(backend.name).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Path coercion surfacing (resolvedPath)
// ---------------------------------------------------------------------------

describe("LocalFileSystemBackend (path coercion)", () => {
  // let: mutable — reset per test to isolate state
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpBase, "coercion-"));
  });

  test("write to absolute path surfaces resolvedPath", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.write("/tmp/koi-test.txt", "hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedPath).toBe("tmp/koi-test.txt");
      expect(result.value.path).toBe("/tmp/koi-test.txt");
      expect(result.value.bytesWritten).toBe(5);
    }
  });

  test("write to relative path does not surface resolvedPath", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.write("foo.txt", "hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedPath).toBeUndefined();
    }
  });

  test("read from absolute path surfaces resolvedPath", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("tmp/koi-test.txt", "hello");
    const result = await backend.read("/tmp/koi-test.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedPath).toBe("tmp/koi-test.txt");
      expect(result.value.content).toBe("hello");
    }
  });

  test("edit on absolute path surfaces resolvedPath", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("tmp/koi-test.txt", "hello world");
    const result = await backend.edit("/tmp/koi-test.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedPath).toBe("tmp/koi-test.txt");
      expect(result.value.hunksApplied).toBe(1);
    }
  });

  test("delete on absolute path surfaces resolvedPath", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("tmp/koi-test.txt", "hello");
    const result = await backend.delete?.("/tmp/koi-test.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedPath).toBe("tmp/koi-test.txt");
    }
  });

  test("write to workspace-absolute path surfaces resolvedPath", async () => {
    const backend = createLocalFileSystem(testDir);
    const realTestDir = realpathSync(testDir);
    const result = await backend.write(`${realTestDir}/inside.txt`, "hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Workspace-absolute paths are coerced to relative
      expect(result.value.resolvedPath).toBe("inside.txt");
    }
  });
});

// ---------------------------------------------------------------------------
// Symlink escape prevention
// ---------------------------------------------------------------------------

describe("LocalFileSystemBackend (symlink containment)", () => {
  // let: mutable — reset per test to isolate state
  let testDir: string;
  // let: mutable — outside dir for symlink targets
  let outsideDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpBase, "symlink-"));
    outsideDir = mkdtempSync(join(tmpBase, "outside-"));
    // Create a secret file outside the workspace
    writeFileSync(join(outsideDir, "secret.txt"), "sensitive data");
  });

  test("read via symlink to outside directory is rejected", async () => {
    // Create a symlink inside workspace pointing outside
    symlinkSync(outsideDir, join(testDir, "escape-link"));
    const backend = createLocalFileSystem(testDir);
    const result = await backend.read("escape-link/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("write via symlink to outside directory is rejected", async () => {
    symlinkSync(outsideDir, join(testDir, "escape-link"));
    const backend = createLocalFileSystem(testDir);
    const result = await backend.write("escape-link/pwned.txt", "malicious");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("edit via symlink to outside file is rejected", async () => {
    // Symlink directly to the outside file
    symlinkSync(join(outsideDir, "secret.txt"), join(testDir, "linked-secret.txt"));
    const backend = createLocalFileSystem(testDir);
    const result = await backend.edit("linked-secret.txt", [
      { oldText: "sensitive", newText: "pwned" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("delete via symlink to outside file is rejected", async () => {
    symlinkSync(join(outsideDir, "secret.txt"), join(testDir, "linked-secret.txt"));
    const backend = createLocalFileSystem(testDir);
    const result = await backend.delete?.("linked-secret.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("rename via symlink escape on source is rejected", async () => {
    symlinkSync(join(outsideDir, "secret.txt"), join(testDir, "linked-secret.txt"));
    const backend = createLocalFileSystem(testDir);
    const result = await backend.rename?.("linked-secret.txt", "stolen.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("list via symlink to outside directory is rejected", async () => {
    symlinkSync(outsideDir, join(testDir, "escape-link"));
    const backend = createLocalFileSystem(testDir);
    const result = await backend.list("escape-link");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("search does not index files via symlink to outside directory", async () => {
    symlinkSync(outsideDir, join(testDir, "escape-link"));
    // Also create a real file inside workspace so search has something to find
    const backend = createLocalFileSystem(testDir);
    await backend.write("real.txt", "findme in workspace");
    const result = await backend.search("sensitive");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // "sensitive data" is in the outside file — should NOT appear in results
      expect(result.value.matches.length).toBe(0);
    }
  });

  test("search finds real workspace files but not symlinked outside files", async () => {
    symlinkSync(outsideDir, join(testDir, "escape-link"));
    const backend = createLocalFileSystem(testDir);
    await backend.write("real.txt", "findme here");
    const result = await backend.search("findme");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should find workspace file but not follow symlink to outside
      const paths = result.value.matches.map((m) => m.path);
      expect(paths.some((p) => p.includes("real.txt"))).toBe(true);
      expect(paths.some((p) => p.includes("escape-link"))).toBe(false);
    }
  });

  test("in-workspace symlink is allowed (target inside root)", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("real-file.txt", "real content");
    // Create a symlink inside the workspace pointing to another workspace file
    symlinkSync(join(testDir, "real-file.txt"), join(testDir, "in-workspace-link.txt"));
    const result = await backend.read("in-workspace-link.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("real content");
  });

  test("normal files still work after symlink hardening", async () => {
    const backend = createLocalFileSystem(testDir);
    await backend.write("normal.txt", "safe content");
    const result = await backend.read("normal.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("safe content");
  });

  test("nested directory creation still works after symlink hardening", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.write("a/b/c/deep.txt", "nested");
    expect(result.ok).toBe(true);
    const read = await backend.read("a/b/c/deep.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("nested");
  });
});

// ---------------------------------------------------------------------------
// resolvePath — containment boundary for cross-cutting subsystems
// ---------------------------------------------------------------------------

describe("resolvePath", () => {
  const testDir = mkdtempSync(join(tmpdir(), "fs-local-resolve-"));

  test("returns absolute path for workspace-relative input", () => {
    const backend = createLocalFileSystem(testDir);
    const out = backend.resolvePath?.("src/foo.ts");
    expect(out).toBeDefined();
    expect(out).toEndWith(`${sep}src${sep}foo.ts`);
  });

  test("strips leading slash and resolves relative to workspace root", () => {
    const backend = createLocalFileSystem(testDir);
    const out = backend.resolvePath?.("/src/foo.ts");
    expect(out).toBeDefined();
    expect(out).toEndWith(`${sep}src${sep}foo.ts`);
  });

  test("passes through absolute path when it's already under the workspace", () => {
    const backend = createLocalFileSystem(testDir);
    const abs = `${realpathSync(testDir)}${sep}src${sep}foo.ts`;
    const out = backend.resolvePath?.(abs);
    expect(out).toBe(abs);
  });

  test("returns undefined for `../` traversal that escapes the workspace", () => {
    const backend = createLocalFileSystem(testDir);
    expect(backend.resolvePath?.("../secret.txt")).toBeUndefined();
    expect(backend.resolvePath?.("../../etc/passwd")).toBeUndefined();
    expect(backend.resolvePath?.("src/../../escape")).toBeUndefined();
  });

  test("treats leading `/path` as workspace-relative (not absolute host path)", () => {
    // `/etc/passwd` does NOT escape — the leading slash is stripped and the
    // path is resolved relative to the workspace root, yielding
    // `<workspace>/etc/passwd`. This is a legitimate workspace-relative
    // path (a file named `passwd` under `<workspace>/etc/`). It is NOT an
    // access to the host `/etc/passwd`.
    const backend = createLocalFileSystem(testDir);
    const resolved = backend.resolvePath?.("/etc/passwd");
    expect(resolved).toBeDefined();
    expect(resolved).toStartWith(realpathSync(testDir));
    expect(resolved).toEndWith(`${sep}etc${sep}passwd`);
  });

  test("returns the workspace root for empty path (container root)", () => {
    const backend = createLocalFileSystem(testDir);
    const out = backend.resolvePath?.("");
    expect(out).toBe(realpathSync(testDir));
  });
});
