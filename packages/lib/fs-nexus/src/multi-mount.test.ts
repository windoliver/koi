import { describe, expect, test } from "bun:test";
import { createNexusMultiMountFileSystem } from "./multi-mount.js";
import type { NexusTransport } from "./types.js";

/**
 * Stub transport that records calls and returns scripted responses.
 * Each call is logged as `{ method, params }` in `calls[]`.
 */
function stubTransport(
  responseMap: Record<string, unknown> = {},
): NexusTransport & { readonly calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  return {
    mounts: [],
    calls,
    call: async <T>(method: string, params: unknown) => {
      calls.push({ method, params });
      const response = responseMap[method];
      if (response === undefined) {
        return {
          ok: false as const,
          error: {
            code: "NOT_FOUND" as const,
            message: `mock: no response for ${method}`,
            retryable: false,
          },
        };
      }
      return { ok: true as const, value: response as T };
    },
    subscribe: () => () => {},
    close: () => {},
    submitAuthCode: () => {},
  };
}

describe("createNexusMultiMountFileSystem", () => {
  test("list('/') returns synthetic mount entries", async () => {
    const transport = stubTransport();
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/workspace", "/gdrive"],
    });
    const result = await backend.list("/");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toEqual([
      { path: "/local/workspace", kind: "directory" },
      { path: "/gdrive", kind: "directory" },
    ]);
    // Synthetic listing must not hit transport
    expect(transport.calls).toEqual([]);
  });

  test("read routes to the backend whose mount prefix matches", async () => {
    const transport = stubTransport({
      read: { content: "hello", metadata: { size: 5 } },
    });
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/workspace", "/gdrive"],
    });
    const result = await backend.read("/gdrive/file.txt");
    expect(result.ok).toBe(true);
    // The sub-backend computes its own fullPath. We care that it was called —
    // the path it sent to transport will start with `/gdrive/`.
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.method).toBe("read");
    expect((call?.params as { path: string }).path).toBe("/gdrive/file.txt");
  });

  test("read on mount root (exact prefix match) routes to backend root", async () => {
    const transport = stubTransport({
      read: { content: "", metadata: { size: 0 } },
    });
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/workspace", "/gdrive"],
    });
    const result = await backend.read("/gdrive");
    expect(result.ok).toBe(true);
    const call = transport.calls[0];
    expect((call?.params as { path: string }).path).toBe("/gdrive");
  });

  test("returns NOT_FOUND with mount hint when prefix matches nothing", async () => {
    const transport = stubTransport();
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/workspace", "/gdrive"],
    });
    const result = await backend.read("/s3/bucket/file");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("/local/workspace");
    expect(result.error.message).toContain("/gdrive");
    expect(transport.calls).toEqual([]);
  });

  test("list on non-root path routes to correct backend", async () => {
    const transport = stubTransport({
      list: {
        files: [{ path: "/local/workspace/a.txt", size: 3, is_directory: false }],
        has_more: false,
      },
    });
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/workspace", "/gdrive"],
    });
    const result = await backend.list("/local/workspace");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toHaveLength(1);
    expect(transport.calls[0]?.method).toBe("list");
  });

  test("write routes and passes namespaced path to transport", async () => {
    const transport = stubTransport({
      write: { bytes_written: 11 },
    });
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/ws", "/gdrive"],
    });
    const result = await backend.write("/local/ws/hello.txt", "hello world");
    expect(result.ok).toBe(true);
    const call = transport.calls[0];
    expect(call?.method).toBe("write");
    expect((call?.params as { path: string }).path).toBe("/local/ws/hello.txt");
  });

  test("rename across mounts is rejected", async () => {
    const transport = stubTransport();
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/ws", "/gdrive"],
    });
    const rename = backend.rename;
    if (rename === undefined) throw new Error("rename missing");
    const result = await rename("/local/ws/a.txt", "/gdrive/b.txt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("different namespaces");
  });

  test("sibling-prefix collision: /local/ws must not match /local/wsX", async () => {
    const transport = stubTransport({
      read: { content: "x", metadata: { size: 1 } },
    });
    const backend = createNexusMultiMountFileSystem({
      transport,
      mountPoints: ["/local/ws", "/gdrive"],
    });
    const result = await backend.read("/local/wsOTHER/file");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(transport.calls).toEqual([]);
  });

  test("validates mountPoints: rejects empty list", () => {
    const transport = stubTransport();
    expect(() => createNexusMultiMountFileSystem({ transport, mountPoints: [] })).toThrow(
      "at least one mountPoint",
    );
  });

  test("validates mountPoints: rejects duplicate", () => {
    const transport = stubTransport();
    expect(() => createNexusMultiMountFileSystem({ transport, mountPoints: ["/a", "/a"] })).toThrow(
      "duplicate",
    );
  });

  test("validates mountPoints: rejects missing leading slash", () => {
    const transport = stubTransport();
    expect(() => createNexusMultiMountFileSystem({ transport, mountPoints: ["local"] })).toThrow(
      "must begin with '/'",
    );
  });

  test("validates mountPoints: rejects bare '/'", () => {
    const transport = stubTransport();
    expect(() => createNexusMultiMountFileSystem({ transport, mountPoints: ["/"] })).toThrow(
      "empty namespace",
    );
  });
});
