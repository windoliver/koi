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

  test("blocks ../../ paths by default (workspace-only mode)", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.read("../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("blocks /etc/passwd by default (workspace-only mode)", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.read("/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("allows /etc/passwd with allowExternalPaths", async () => {
    const backend = createLocalFileSystem(testDir, { allowExternalPaths: true });
    const result = await backend.read("/etc/passwd");
    expect(result.ok).toBe(true);
  });

  test("allows ../../ paths with allowExternalPaths", async () => {
    const backend = createLocalFileSystem(testDir, { allowExternalPaths: true });
    const result = await backend.read("../../etc/passwd");
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("treats leading / as workspace-relative when root dir doesn't exist", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.read("/nonexistent/file.txt");
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

  test("rename blocks ../../ source path by default", async () => {
    const backend = createLocalFileSystem(testDir);
    const result = await backend.rename?.("../../nonexistent.txt", "stolen.txt");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("rename blocks ../../ destination path by default", async () => {
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

  test("delete blocks ../../ paths by default", async () => {
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

  test("treats leading / as workspace-relative when root dir doesn't exist", () => {
    const backend = createLocalFileSystem(testDir);
    // /src doesn't exist at filesystem root → workspace-relative convention.
    const out = backend.resolvePath?.("/src/foo.ts");
    expect(out).toBeDefined();
    expect(out).toEndWith(`${sep}src${sep}foo.ts`);
    // Should be under the workspace root
    expect(out).toStartWith(realpathSync(testDir));
  });

  test("passes through absolute path when it's already under the workspace", () => {
    const backend = createLocalFileSystem(testDir);
    const abs = `${realpathSync(testDir)}${sep}src${sep}foo.ts`;
    const out = backend.resolvePath?.(abs);
    expect(out).toBe(abs);
  });

  test("returns undefined for ../ traversal (prevents checkpoint capture)", () => {
    const backend = createLocalFileSystem(testDir);
    expect(backend.resolvePath?.("../secret.txt")).toBeUndefined();
  });

  test("returns undefined for /etc/passwd (prevents checkpoint capture)", () => {
    const backend = createLocalFileSystem(testDir);
    expect(backend.resolvePath?.("/etc/passwd")).toBeUndefined();
  });

  test("returns undefined for empty path", () => {
    const backend = createLocalFileSystem(testDir);
    const out = backend.resolvePath?.("");
    expect(out).toBeUndefined();
  });

  test("returns undefined for out-of-workspace absolute path (prevents checkpoint)", () => {
    const backend = createLocalFileSystem(testDir);
    // Use /tmp which exists on both macOS and Linux, so the statSync
    // heuristic treats it as a real absolute path (not workspace-relative).
    expect(backend.resolvePath?.("/tmp/outside-file.md")).toBeUndefined();
  });
});
