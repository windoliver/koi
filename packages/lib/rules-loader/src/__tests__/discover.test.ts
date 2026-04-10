import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FILENAMES, DEFAULT_SEARCH_DIRS } from "../config.js";
import { discoverRulesFiles } from "../discover.js";

/** Narrow array element — throws if undefined (length was already asserted). */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element at index ${String(i)}`);
  return v;
}

describe("discoverRulesFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `koi-rules-test-${Date.now()}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when no rules files exist", async () => {
    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toEqual([]);
  });

  test("discovers single file at root", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Rules");

    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toHaveLength(1);
    expect(at(result, 0).path).toBe(join(tempDir, "CLAUDE.md"));
    expect(at(result, 0).depth).toBe(0);
  });

  test("discovers files at multiple depths, root-first", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "root rules");
    const child = join(tempDir, "src");
    mkdirSync(child);
    writeFileSync(join(child, "CLAUDE.md"), "child rules");

    const result = await discoverRulesFiles(child, tempDir, DEFAULT_FILENAMES, DEFAULT_SEARCH_DIRS);
    expect(result).toHaveLength(2);
    expect(at(result, 0).path).toBe(join(tempDir, "CLAUDE.md"));
    expect(at(result, 0).depth).toBe(0);
    expect(at(result, 1).path).toBe(join(child, "CLAUDE.md"));
    expect(at(result, 1).depth).toBe(1);
  });

  test("discovers files in .koi subdirectory", async () => {
    const koiDir = join(tempDir, ".koi");
    mkdirSync(koiDir);
    writeFileSync(join(koiDir, "CLAUDE.md"), "koi rules");

    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toHaveLength(1);
    expect(at(result, 0).path).toBe(join(koiDir, "CLAUDE.md"));
  });

  test("discovers both root and .koi files at same level", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "root");
    const koiDir = join(tempDir, ".koi");
    mkdirSync(koiDir);
    writeFileSync(join(koiDir, "CLAUDE.md"), "koi");

    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toHaveLength(2);
    expect(at(result, 0).path).toBe(join(tempDir, "CLAUDE.md"));
    expect(at(result, 1).path).toBe(join(koiDir, "CLAUDE.md"));
  });

  test("discovers multiple filenames", async () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "claude");
    writeFileSync(join(tempDir, "AGENTS.md"), "agents");

    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toHaveLength(2);
    expect(at(result, 0).path).toBe(join(tempDir, "CLAUDE.md"));
    expect(at(result, 1).path).toBe(join(tempDir, "AGENTS.md"));
  });

  test("stops at git root (does not walk beyond)", async () => {
    const parent = tempDir;
    writeFileSync(join(parent, "CLAUDE.md"), "parent rules");

    const gitRoot = join(parent, "repo");
    mkdirSync(gitRoot);
    writeFileSync(join(gitRoot, "CLAUDE.md"), "repo rules");

    const cwd = join(gitRoot, "src");
    mkdirSync(cwd);

    const result = await discoverRulesFiles(cwd, gitRoot, DEFAULT_FILENAMES, DEFAULT_SEARCH_DIRS);
    expect(result).toHaveLength(1);
    expect(at(result, 0).path).toBe(join(gitRoot, "CLAUDE.md"));
  });

  test("no git root scans cwd only (prevents ancestor contamination)", async () => {
    // Create parent with CLAUDE.md
    const parent = tempDir;
    writeFileSync(join(parent, "CLAUDE.md"), "parent rules");

    // Create child with its own CLAUDE.md
    const child = join(parent, "project");
    mkdirSync(child);
    writeFileSync(join(child, "CLAUDE.md"), "child rules");

    // Without git root, only cwd is scanned — parent file must not leak
    const result = await discoverRulesFiles(
      child,
      undefined,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toHaveLength(1);
    expect(at(result, 0).path).toBe(join(child, "CLAUDE.md"));
  });

  test("uses custom filenames", async () => {
    writeFileSync(join(tempDir, "RULES.md"), "custom rules");
    writeFileSync(join(tempDir, "CLAUDE.md"), "should not find");

    const result = await discoverRulesFiles(tempDir, tempDir, ["RULES.md"], ["."]);
    expect(result).toHaveLength(1);
    expect(at(result, 0).path).toBe(join(tempDir, "RULES.md"));
  });

  test("rejects symlinked rules files pointing outside repo boundary", async () => {
    // Create a file outside the repo boundary
    const outside = join(tmpdir(), `koi-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "sensitive data");

    // Symlink CLAUDE.md → outside/secret.md
    symlinkSync(join(outside, "secret.md"), join(tempDir, "CLAUDE.md"));

    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    // Symlink escaping the boundary should be rejected
    expect(result.filter((f) => f.path.includes("CLAUDE.md"))).toHaveLength(0);

    rmSync(outside, { recursive: true, force: true });
  });

  test("discovers .koi/context.md with default config", async () => {
    const koiDir = join(tempDir, ".koi");
    mkdirSync(koiDir);
    writeFileSync(join(koiDir, "context.md"), "project context");

    const result = await discoverRulesFiles(
      tempDir,
      tempDir,
      DEFAULT_FILENAMES,
      DEFAULT_SEARCH_DIRS,
    );
    expect(result).toHaveLength(1);
    expect(at(result, 0).path).toBe(join(koiDir, "context.md"));
  });
});
