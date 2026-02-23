import { describe, expect, test } from "bun:test";
import type { FileSystemBackend, KoiError, Result } from "@koi/core";
import { capturePreState } from "./capture.js";

function createMockBackend(files: ReadonlyMap<string, string>): FileSystemBackend {
  return {
    name: "mock-fs",
    read: (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `File not found: ${path}`,
            retryable: false,
          },
        } satisfies Result<never, KoiError>;
      }
      return {
        ok: true,
        value: { content, path, size: content.length },
      };
    },
    write: () => ({ ok: true, value: { path: "", bytesWritten: 0 } }),
    edit: () => ({ ok: true, value: { path: "", hunksApplied: 0 } }),
    list: () => ({
      ok: true,
      value: { entries: [], truncated: false },
    }),
    search: () => ({
      ok: true,
      value: { matches: [], truncated: false },
    }),
  };
}

describe("capturePreState", () => {
  test("returns content for existing file", async () => {
    const files = new Map([["/tmp/test.txt", "hello world"]]);
    const backend = createMockBackend(files);

    const result = await capturePreState(backend, "/tmp/test.txt", 1_048_576);
    expect(result).toBe("hello world");
  });

  test("returns undefined for non-existent file", async () => {
    const backend = createMockBackend(new Map());

    const result = await capturePreState(backend, "/tmp/missing.txt", 1_048_576);
    expect(result).toBeUndefined();
  });

  test("returns undefined when file exceeds maxSize", async () => {
    const largeContent = "x".repeat(100);
    const files = new Map([["/tmp/large.txt", largeContent]]);
    const backend = createMockBackend(files);

    // Set maxSize smaller than the file
    const result = await capturePreState(backend, "/tmp/large.txt", 50);
    expect(result).toBeUndefined();
  });

  test("returns content when file size equals maxSize", async () => {
    const content = "x".repeat(50);
    const files = new Map([["/tmp/exact.txt", content]]);
    const backend = createMockBackend(files);

    // size === maxSize should still capture (only > is rejected)
    const result = await capturePreState(backend, "/tmp/exact.txt", 50);
    expect(result).toBe(content);
  });
});
