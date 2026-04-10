import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredFile } from "../config.js";
import { loadAllRulesFiles, loadRulesFile } from "../load.js";

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element at index ${String(i)}`);
  return v;
}

describe("loadRulesFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `koi-rules-test-${Date.now()}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("loads existing file with content and token estimate", async () => {
    const path = join(tempDir, "CLAUDE.md");
    writeFileSync(path, "# Project Rules\n\nUse bun, not npm.");
    const file: DiscoveredFile = { path, realPath: path, depth: 0 };

    const result = await loadRulesFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.path).toBe(path);
    expect(result.value.depth).toBe(0);
    expect(result.value.content).toBe("# Project Rules\n\nUse bun, not npm.");
    expect(result.value.estimatedTokens).toBeGreaterThan(0);
    expect(result.value.mtimeMs).toBeGreaterThan(0);
  });

  test("returns NOT_FOUND error for missing file", async () => {
    const file: DiscoveredFile = {
      path: join(tempDir, "nonexistent.md"),
      realPath: join(tempDir, "nonexistent.md"),
      depth: 0,
    };
    const result = await loadRulesFile(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("loads empty file", async () => {
    const path = join(tempDir, "CLAUDE.md");
    writeFileSync(path, "");
    const file: DiscoveredFile = { path, realPath: path, depth: 0 };

    const result = await loadRulesFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("");
    expect(result.value.estimatedTokens).toBe(0);
  });

  test("preserves depth from discovered file", async () => {
    const path = join(tempDir, "CLAUDE.md");
    writeFileSync(path, "content");
    const file: DiscoveredFile = { path, realPath: path, depth: 3 };

    const result = await loadRulesFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.depth).toBe(3);
  });
});

describe("loadAllRulesFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `koi-rules-test-${Date.now()}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("loads multiple files in order", async () => {
    writeFileSync(join(tempDir, "a.md"), "aaa");
    writeFileSync(join(tempDir, "b.md"), "bbb");

    const aPath = join(tempDir, "a.md");
    const bPath = join(tempDir, "b.md");
    const files: readonly DiscoveredFile[] = [
      { path: aPath, realPath: aPath, depth: 0 },
      { path: bPath, realPath: bPath, depth: 1 },
    ];

    const result = await loadAllRulesFiles(files);
    expect(result).toHaveLength(2);
    expect(at(result, 0).content).toBe("aaa");
    expect(at(result, 1).content).toBe("bbb");
  });

  test("skips missing files without throwing", async () => {
    writeFileSync(join(tempDir, "a.md"), "aaa");

    const aPath = join(tempDir, "a.md");
    const missingPath = join(tempDir, "missing.md");
    const files: readonly DiscoveredFile[] = [
      { path: aPath, realPath: aPath, depth: 0 },
      { path: missingPath, realPath: missingPath, depth: 1 },
    ];

    const result = await loadAllRulesFiles(files);
    expect(result).toHaveLength(1);
    expect(at(result, 0).content).toBe("aaa");
  });

  test("returns empty array when all files missing", async () => {
    const missingPath = join(tempDir, "missing.md");
    const files: readonly DiscoveredFile[] = [
      { path: missingPath, realPath: missingPath, depth: 0 },
    ];

    const result = await loadAllRulesFiles(files);
    expect(result).toHaveLength(0);
  });
});
