/**
 * Filesystem routes unit tests — validates request handling and error mapping.
 */

import { describe, expect, test } from "bun:test";
import type { FileSystemBackend, KoiError, KoiErrorCode, Result } from "@koi/core";
import { handleFsDelete, handleFsList, handleFsRead, handleFsSearch } from "./filesystem.js";

function ok<T>(value: T): Result<T, KoiError> {
  return { ok: true, value };
}

function err(code: KoiErrorCode, message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code, message, retryable: false, context: {} },
  };
}

function createMockFs(overrides?: Partial<FileSystemBackend>): FileSystemBackend {
  return {
    name: "test-fs",
    read: () => ok({ content: "hello", path: "/test.txt", size: 5 }),
    write: () => ok({ path: "/test.txt", bytesWritten: 5 }),
    edit: () => ok({ path: "/test.txt", hunksApplied: 0 }),
    list: () =>
      ok({
        entries: [
          { path: "/agents/a1", kind: "directory" as const },
          { path: "/agents/a1/bricks", kind: "directory" as const },
        ],
        truncated: false,
      }),
    search: () => ok({ matches: [], truncated: false }),
    delete: () => ok({ path: "/test.txt" }),
    ...overrides,
  };
}

function makeReq(url: string, method = "GET"): Request {
  return new Request(`http://localhost${url}`, { method });
}

describe("handleFsList", () => {
  test("returns directory listing with default path", async () => {
    const fs = createMockFs();
    const res = await handleFsList(makeReq("/fs/list"), {}, fs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect((body.data as Record<string, unknown>).entries as unknown[]).toHaveLength(2);
  });

  test("passes path query parameter", async () => {
    let capturedPath: string | undefined;
    const fs = createMockFs({
      list: (path) => {
        capturedPath = path;
        return ok({ entries: [], truncated: false });
      },
    });
    await handleFsList(makeReq("/fs/list?path=/agents/a1"), {}, fs);
    expect(capturedPath).toBe("/agents/a1");
  });

  test("returns 404 for NOT_FOUND error", async () => {
    const fs = createMockFs({
      list: () => err("NOT_FOUND", "Path not found"),
    });
    const res = await handleFsList(makeReq("/fs/list?path=/missing"), {}, fs);
    expect(res.status).toBe(404);
  });
});

describe("handleFsRead", () => {
  test("returns file content", async () => {
    const fs = createMockFs();
    const res = await handleFsRead(makeReq("/fs/read?path=/test.txt"), {}, fs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).content).toBe("hello");
  });

  test("returns 400 when path is missing", async () => {
    const fs = createMockFs();
    const res = await handleFsRead(makeReq("/fs/read"), {}, fs);
    expect(res.status).toBe(400);
  });

  test("returns 404 for NOT_FOUND error", async () => {
    const fs = createMockFs({
      read: () => err("NOT_FOUND", "File not found"),
    });
    const res = await handleFsRead(makeReq("/fs/read?path=/missing"), {}, fs);
    expect(res.status).toBe(404);
  });
});

describe("handleFsSearch", () => {
  test("returns search results", async () => {
    const fs = createMockFs({
      search: () =>
        ok({
          matches: [{ path: "/a.txt", line: 1, text: "match" }],
          truncated: false,
        }),
    });
    const res = await handleFsSearch(makeReq("/fs/search?q=match"), {}, fs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.data as Record<string, unknown>).matches as unknown[]).toHaveLength(1);
  });

  test("returns 400 when query is missing", async () => {
    const fs = createMockFs();
    const res = await handleFsSearch(makeReq("/fs/search"), {}, fs);
    expect(res.status).toBe(400);
  });
});

describe("handleFsDelete", () => {
  test("deletes file", async () => {
    const fs = createMockFs();
    const res = await handleFsDelete(makeReq("/fs/file?path=/test.txt", "DELETE"), {}, fs);
    expect(res.status).toBe(200);
  });

  test("returns 400 when path is missing", async () => {
    const fs = createMockFs();
    const res = await handleFsDelete(makeReq("/fs/file", "DELETE"), {}, fs);
    expect(res.status).toBe(400);
  });

  test("returns 501 when delete is not supported", async () => {
    const fs = createMockFs();
    // Remove delete to simulate a backend that doesn't support it
    const { delete: _, ...fsWithoutDelete } = fs;
    const res = await handleFsDelete(
      makeReq("/fs/file?path=/test.txt", "DELETE"),
      {},
      fsWithoutDelete as FileSystemBackend,
    );
    expect(res.status).toBe(501);
  });
});
