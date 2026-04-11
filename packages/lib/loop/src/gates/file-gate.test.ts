import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifierContext } from "../types.js";
import { createFileGate } from "./file-gate.js";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "koi-loop-file-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const ctx: VerifierContext = {
  iteration: 1,
  workingDir: "/tmp",
  signal: new AbortController().signal,
};

describe("createFileGate", () => {
  test("passes on string match", async () => {
    const path = join(workDir, "a.txt");
    await writeFile(path, "hello world", "utf8");
    const result = await createFileGate(path, "hello").check(ctx);
    expect(result.ok).toBe(true);
  });

  test("passes on regex match", async () => {
    const path = join(workDir, "b.txt");
    await writeFile(path, "foo-123-bar", "utf8");
    const result = await createFileGate(path, /\d+/).check(ctx);
    expect(result.ok).toBe(true);
  });

  test("file_missing when file does not exist", async () => {
    const result = await createFileGate(join(workDir, "nope"), "x").check(ctx);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("file_missing");
  });

  test("file_no_match when content mismatches", async () => {
    const path = join(workDir, "c.txt");
    await writeFile(path, "nothing", "utf8");
    const result = await createFileGate(path, "something").check(ctx);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("file_no_match");
  });

  test("relative path resolves against ctx.workingDir, not process.cwd()", async () => {
    // Write a file in workDir. A relative-path gate with ctx.workingDir
    // pointing at workDir must find it; the test process's actual cwd is
    // irrelevant and would not contain this file.
    const fileName = "rel-marker.txt";
    await writeFile(join(workDir, fileName), "relative-ok", "utf8");
    const gate = createFileGate(fileName, "relative-ok");
    const result = await gate.check({
      iteration: 1,
      workingDir: workDir,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
  });

  test("relative path honors workingDir when cwd differs", async () => {
    // Point workingDir at a nonexistent subdir so the relative path would
    // NOT resolve to the test's cwd. The gate must fail with file_missing
    // using the fully-resolved path from ctx.workingDir.
    const gate = createFileGate("not-there.txt", "x");
    const result = await gate.check({
      iteration: 1,
      workingDir: "/tmp/koi-loop-nonexistent-wd",
      signal: new AbortController().signal,
    });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("file_missing");
    expect(result.details).toContain("/tmp/koi-loop-nonexistent-wd");
  });

  test("absolute path is honored as-is regardless of workingDir", async () => {
    const absPath = join(workDir, "abs.txt");
    await writeFile(absPath, "abs-ok", "utf8");
    const gate = createFileGate(absPath, "abs-ok");
    const result = await gate.check({
      iteration: 1,
      workingDir: "/some/unrelated/path",
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
  });

  test("regression: stateful /g regex does not flip pass→fail across iterations", async () => {
    // RegExp.prototype.test() mutates lastIndex for /g and /y flags. A
    // naive implementation would reuse the caller's regex instance, so
    // the same unchanged file could pass on iteration 1 and fail on
    // iteration 2 — a real retry-path bug because the whole loop is
    // built around invoking the same verifier repeatedly.
    const path = join(workDir, "regex-stateful.txt");
    await writeFile(path, "foo-123-bar", "utf8");
    const gate = createFileGate(path, /\d+/g);

    // Call three times in a row with unchanged content. All three must
    // return the same result — not flip based on lastIndex state.
    for (let i = 0; i < 3; i++) {
      const result = await gate.check(ctx);
      expect(result.ok).toBe(true);
    }
  });

  test("regression: stateful /y regex also does not flip across iterations", async () => {
    const path = join(workDir, "regex-sticky.txt");
    await writeFile(path, "match-here", "utf8");
    const gate = createFileGate(path, /match/y);

    for (let i = 0; i < 3; i++) {
      const result = await gate.check(ctx);
      expect(result.ok).toBe(true);
    }
  });

  test("multiline and case-insensitive flags are preserved when cloning", async () => {
    const path = join(workDir, "regex-flags.txt");
    await writeFile(path, "hello\nWORLD", "utf8");
    // /gmi — stateful flags stripped, m + i preserved
    const gate = createFileGate(path, /world/gim);
    const result = await gate.check(ctx);
    expect(result.ok).toBe(true);
  });
});
