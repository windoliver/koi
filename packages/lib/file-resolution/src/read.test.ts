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

describe("readBoundedFile — bounded mode (maxChars)", () => {
  test("returns BoundedReadResult with content within budget", async () => {
    const filePath = join(tmpDir, "test.md");
    await writeFile(filePath, "hello world");
    const result = await readBoundedFile(filePath, 100);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.content).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.originalSize).toBe(Buffer.byteLength("hello world", "utf-8"));
  });

  test("truncates content exceeding maxChars", async () => {
    const filePath = join(tmpDir, "big.md");
    const longContent = "x".repeat(200);
    await writeFile(filePath, longContent);
    const result = await readBoundedFile(filePath, 50);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.content.length).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(200);
  });

  test("returns undefined for non-existent file in bounded mode", async () => {
    const result = await readBoundedFile(join(tmpDir, "missing.md"), 100);
    expect(result).toBeUndefined();
  });

  test("handles empty file in bounded mode", async () => {
    const filePath = join(tmpDir, "empty.md");
    await writeFile(filePath, "");
    const result = await readBoundedFile(filePath, 100);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.originalSize).toBe(0);
  });

  test("truncates multi-byte UTF-8 content by characters not bytes", async () => {
    // Each CJK character is 3 bytes in UTF-8
    const cjkContent = "\u4F60\u597D\u4E16\u754C\u6D4B\u8BD5"; // 6 chars, 18 bytes
    const filePath = join(tmpDir, "cjk.md");
    await writeFile(filePath, cjkContent);
    const result = await readBoundedFile(filePath, 4);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.content.length).toBe(4);
    expect(result.content).toBe("\u4F60\u597D\u4E16\u754C");
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(18);
  });

  test("handles 4-byte emoji characters at boundary", async () => {
    // Each emoji is 2 JS characters (surrogate pair) but 4 UTF-8 bytes
    const emoji = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}"; // 4 emoji = 8 JS chars
    const filePath = join(tmpDir, "emoji.md");
    await writeFile(filePath, emoji);
    const result = await readBoundedFile(filePath, 4);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    // 4 chars means 4 JS characters = 2 emoji
    expect(result.content.length).toBe(4);
    expect(result.truncated).toBe(true);
  });

  test("does not split surrogate pair when boundary lands on high surrogate", async () => {
    // "ab😀cd" = 6 code units. maxChars=3 lands on high surrogate of 😀
    const text = "ab\u{1F600}cd";
    const filePath = join(tmpDir, "surrogate.md");
    await writeFile(filePath, text);
    const result = await readBoundedFile(filePath, 3);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    // Should back off to 2 chars ("ab") instead of producing a dangling surrogate
    expect(result.content).toBe("ab");
    expect(result.truncated).toBe(true);
  });

  test("exact boundary — no truncation", async () => {
    const filePath = join(tmpDir, "exact.md");
    const content = "exactly10!"; // 10 chars
    await writeFile(filePath, content);
    const result = await readBoundedFile(filePath, 10);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.content).toBe("exactly10!");
    expect(result.truncated).toBe(false);
  });

  test("one char over boundary — truncates", async () => {
    const filePath = join(tmpDir, "over.md");
    const content = "exactly10!X"; // 11 chars
    await writeFile(filePath, content);
    const result = await readBoundedFile(filePath, 10);
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.content.length).toBe(10);
    expect(result.content).toBe("exactly10!");
    expect(result.truncated).toBe(true);
  });

  test("throws on permission error in bounded mode", async () => {
    if (process.getuid?.() === 0) return;

    const filePath = join(tmpDir, "no-read.md");
    await writeFile(filePath, "secret");
    await chmod(filePath, 0o000);

    await expect(readBoundedFile(filePath, 100)).rejects.toThrow("Failed to read file");
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
