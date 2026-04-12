/**
 * Drift detector tests.
 *
 * Tests cover the porcelain parser (deterministic, easy) and the git
 * spawn behavior (best-effort, must not throw on missing git or non-repo).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitStatusDriftDetector, parsePorcelain } from "../drift-detector.js";

describe("parsePorcelain", () => {
  test("empty output returns empty list", () => {
    expect(parsePorcelain("")).toEqual([]);
  });

  test("whitespace-only output returns empty list", () => {
    expect(parsePorcelain("\n\n  \n")).toEqual([]);
  });

  test("single modified file", () => {
    expect(parsePorcelain(" M src/foo.ts\n")).toEqual([" M src/foo.ts"]);
  });

  test("multiple files preserved in order", () => {
    const input = " M src/foo.ts\n?? generated/output.json\nA  src/new.ts\n";
    const result = parsePorcelain(input);
    expect(result).toEqual([" M src/foo.ts", "?? generated/output.json", "A  src/new.ts"]);
  });

  test("trailing whitespace is trimmed", () => {
    expect(parsePorcelain(" M src/foo.ts   \n")).toEqual([" M src/foo.ts"]);
  });

  test("blank lines between entries are skipped", () => {
    expect(parsePorcelain(" M a.ts\n\n M b.ts\n")).toEqual([" M a.ts", " M b.ts"]);
  });
});

describe("createGitStatusDriftDetector", () => {
  test("returns empty list for a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koi-drift-non-git-"));
    const detector = createGitStatusDriftDetector(dir);
    const result = await detector.detect();
    expect(result).toEqual([]);
  });

  test("returns empty list for a non-existent directory (no throw)", async () => {
    const detector = createGitStatusDriftDetector("/this/path/does/not/exist");
    const result = await detector.detect();
    expect(result).toEqual([]);
  });

  test("returns empty list for an empty git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koi-drift-empty-repo-"));
    // Try to init a repo. If git isn't available, fall through to the
    // empty-list path — the test still passes because the detector is
    // best-effort.
    const init = Bun.spawn(["git", "init", "-q", dir], { stdout: "pipe", stderr: "pipe" });
    await init.exited;

    const detector = createGitStatusDriftDetector(dir);
    const result = await detector.detect();
    expect(result).toEqual([]);
  });

  // Regression: codex round 3, P2 on commit 6eb8604a. The original
  // implementation awaited `proc.exited` with no timeout despite the
  // docstring claim, so a hanging git-status would block onAfterTurn
  // indefinitely. Now Promise.race + proc.kill enforces a hard cap.
  test("hanging command is killed at the configured timeout (returns [])", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koi-drift-timeout-"));
    // Use `sleep 10` as a synthetic hang — it would complete way past any
    // plausible detector timeout. With the timeout enforcement fix, the
    // detector must return [] within ~100ms, not ~10s.
    const detector = createGitStatusDriftDetector(dir, {
      command: ["sh", "-c", "sleep 10"],
      timeoutMs: 100,
    });
    const start = Date.now();
    const result = await detector.detect();
    const elapsed = Date.now() - start;
    expect(result).toEqual([]);
    // Generous upper bound for CI — the timeout is 100ms, detector should
    // return well under 1s even on a loaded runner.
    expect(elapsed).toBeLessThan(1000);
  });

  test("command that completes fast does NOT trigger the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koi-drift-fast-"));
    // `true` exits immediately with code 0, empty stdout.
    const detector = createGitStatusDriftDetector(dir, {
      command: ["true"],
      timeoutMs: 5000,
    });
    const result = await detector.detect();
    expect(result).toEqual([]);
  });
});
