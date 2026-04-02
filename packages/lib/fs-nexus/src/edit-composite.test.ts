/**
 * Dedicated tests for the composite edit fallback (read → hunks → write).
 * Tests hunk application edge cases that the contract suite doesn't cover.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { FileSystemBackend } from "@koi/core";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import { createFakeNexusTransport } from "./test-helpers.js";

/**
 * Create a backend with edit forced to use composite fallback.
 * The fake transport returns METHOD_NOT_FOUND for "edit" RPC,
 * so the backend falls back to read → hunks → write.
 */
function createCompositeEditBackend(): FileSystemBackend {
  const transport = createFakeNexusTransport({
    failMethod: "edit",
    failCode: -32601,
    failMessage: "method not found: edit",
  });
  return createNexusFileSystem({ url: "http://fake", transport });
}

describe("composite edit fallback", () => {
  let backend: FileSystemBackend;

  beforeEach(() => {
    backend = createCompositeEditBackend();
  });

  test("single hunk happy path", async () => {
    await backend.write("/test.txt", "hello world");
    const result = await backend.edit("/test.txt", [{ oldText: "hello", newText: "goodbye" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);

    const read = await backend.read("/test.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("goodbye world");
  });

  test("multi-hunk sequential application", async () => {
    await backend.write("/test.txt", "aaa bbb ccc");
    const result = await backend.edit("/test.txt", [
      { oldText: "aaa", newText: "xxx" },
      { oldText: "xxx bbb", newText: "yyy" }, // Depends on first hunk's result
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(2);

    const read = await backend.read("/test.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("yyy ccc");
  });

  test("empty edits array returns 0 hunks applied", async () => {
    await backend.write("/test.txt", "content");
    const result = await backend.edit("/test.txt", []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(0);
  });

  test("oldText not found returns error", async () => {
    await backend.write("/test.txt", "hello world");
    const result = await backend.edit("/test.txt", [
      { oldText: "does not exist", newText: "replacement" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("dryRun returns count without mutating file", async () => {
    await backend.write("/test.txt", "hello world");
    const result = await backend.edit("/test.txt", [{ oldText: "hello", newText: "goodbye" }], {
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);

    // File should be unchanged
    const read = await backend.read("/test.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("hello world");
  });

  test("multi-line hunk", async () => {
    const content = "line1\nline2\nline3\n";
    await backend.write("/test.txt", content);
    const result = await backend.edit("/test.txt", [
      { oldText: "line1\nline2", newText: "replaced1\nreplaced2" },
    ]);
    expect(result.ok).toBe(true);

    const read = await backend.read("/test.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("replaced1\nreplaced2\nline3\n");
  });

  test("atomicity: if 2nd hunk fails, file is unchanged", async () => {
    await backend.write("/test.txt", "aaa bbb ccc");
    const result = await backend.edit("/test.txt", [
      { oldText: "aaa", newText: "xxx" },
      { oldText: "DOES_NOT_EXIST", newText: "yyy" },
    ]);
    expect(result.ok).toBe(false);

    // File should be unchanged — first hunk should NOT have been applied
    const read = await backend.read("/test.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("aaa bbb ccc");
  });

  test("file not found returns NOT_FOUND", async () => {
    const result = await backend.edit("/nonexistent.txt", [{ oldText: "a", newText: "b" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("whitespace-sensitive matching", async () => {
    await backend.write("/test.txt", "  indented  text  ");
    const result = await backend.edit("/test.txt", [
      { oldText: "  indented  text  ", newText: "replaced" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);

    const read = await backend.read("/test.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("replaced");
  });
});
