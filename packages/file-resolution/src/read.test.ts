import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDirectory, isInlineContent, readBoundedFile, resolveInputPath } from "./read.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  // Restore permissions before cleanup (chmod 0o000 files can't be deleted)
  try {
    const noReadFile = join(tmpDir, "no-read.md");
    await chmod(noReadFile, 0o644).catch(() => {});
    const noReadDir = join(tmpDir, "no-read-dir");
    await chmod(noReadDir, 0o755).catch(() => {});
  } catch {
    // ignore — files may not exist in most tests
  }
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readBoundedFile", () => {
  test("reads existing file content", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "hello world");
    expect(await readBoundedFile(filePath)).toBe("hello world");
  });

  test("returns undefined for non-existent file", async () => {
    expect(await readBoundedFile(join(tmpDir, "missing.md"))).toBeUndefined();
  });

  test("reads empty file as empty string", async () => {
    const filePath = join(tmpDir, "empty.md");
    await writeFile(filePath, "");
    expect(await readBoundedFile(filePath)).toBe("");
  });

  test("throws on permission error instead of returning undefined", async () => {
    // Skip on CI or if running as root (root can read anything)
    if (process.getuid?.() === 0) return;

    const filePath = join(tmpDir, "no-read.md");
    await writeFile(filePath, "secret");
    await chmod(filePath, 0o000);

    await expect(readBoundedFile(filePath)).rejects.toThrow("Failed to read file");
  });
});

describe("isDirectory", () => {
  test("returns true for existing directory", async () => {
    expect(await isDirectory(tmpDir)).toBe(true);
  });

  test("returns false for non-existent path", async () => {
    expect(await isDirectory(join(tmpDir, "nope"))).toBe(false);
  });

  test("returns false for a file path", async () => {
    const filePath = join(tmpDir, "file.txt");
    await writeFile(filePath, "content");
    expect(await isDirectory(filePath)).toBe(false);
  });

  test("throws on permission error instead of returning false", async () => {
    // Skip on CI or if running as root
    if (process.getuid?.() === 0) return;

    const dirPath = join(tmpDir, "no-read-dir");
    await mkdir(dirPath);
    await chmod(dirPath, 0o000);

    await expect(isDirectory(dirPath)).rejects.toThrow("Failed to check directory");
  });
});

describe("isInlineContent", () => {
  test("returns true for string with newline", () => {
    expect(isInlineContent("line one\nline two")).toBe(true);
  });

  test("returns false for single-line string", () => {
    expect(isInlineContent("just a path")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isInlineContent("")).toBe(false);
  });
});

describe("resolveInputPath", () => {
  test("resolves relative path against basePath", () => {
    const result = resolveInputPath("SOUL.md", "/base/dir");
    expect(result).toBe("/base/dir/SOUL.md");
  });

  test("absolute path is returned as-is", () => {
    const result = resolveInputPath("/absolute/path.md", "/base/dir");
    expect(result).toBe("/absolute/path.md");
  });
});
