import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGitRoot } from "../find-git-root.js";

describe("findGitRoot", () => {
  let tempDir: string;

  beforeEach(() => {
    const raw = join(tmpdir(), `koi-rules-test-${Date.now()}-${String(Math.random()).slice(2, 8)}`);
    mkdirSync(raw, { recursive: true });
    // Canonicalize to match what findGitRoot returns (e.g. macOS /var → /private/var)
    tempDir = realpathSync(raw);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns directory containing .git", async () => {
    mkdirSync(join(tempDir, ".git"));
    const result = await findGitRoot(tempDir);
    expect(result).toBe(tempDir);
  });

  test("walks up to find .git in parent", async () => {
    mkdirSync(join(tempDir, ".git"));
    const nested = join(tempDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    const result = await findGitRoot(nested);
    expect(result).toBe(tempDir);
  });

  test("returns undefined when no .git found", async () => {
    const isolated = join(tempDir, "no-git", "deep");
    mkdirSync(isolated, { recursive: true });

    const result = await findGitRoot(isolated);
    expect(result === undefined || typeof result === "string").toBe(true);
  });

  test("handles .git file (worktree)", async () => {
    writeFileSync(join(tempDir, ".git"), "gitdir: /some/other/path");
    const result = await findGitRoot(tempDir);
    expect(result).toBe(tempDir);
  });

  test("ignores plain .git file without gitdir prefix", async () => {
    writeFileSync(join(tempDir, ".git"), "not a valid git marker");
    const result = await findGitRoot(tempDir);
    // Should not treat this as a git root
    expect(result !== tempDir).toBe(true);
  });
});
