/**
 * Tests for the Nexus-backed FileSystemBackend.
 *
 * Uses an in-memory mock transport that simulates Nexus JSON-RPC responses.
 * Covers: all 7 operations, path safety, error mapping, config validation.
 */

import { describe, expect, test } from "bun:test";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import type { NexusTransport } from "./types.js";
import { validateNexusFileSystemConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// In-memory mock transport
// ---------------------------------------------------------------------------

function createMockTransport(): NexusTransport & {
  readonly store: Map<string, string>;
} {
  const store = new Map<string, string>();

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    switch (method) {
      case "read": {
        const path = params.path as string;
        const content = store.get(path);
        if (content === undefined) {
          throw new Error(`Not found: ${path}`);
        }
        const offset = (params.offset as number | undefined) ?? 0;
        const limit = params.limit as number | undefined;
        const sliced =
          limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
        return { content: sliced, path, size: sliced.length } as T;
      }

      case "write": {
        const path = params.path as string;
        const content = params.content as string;
        store.set(path, content);
        return null as T;
      }

      case "capabilities": {
        // Mock server supports CAS
        return { cas: true } as T;
      }

      case "list": {
        const path = params.path as string;
        const recursive = params.recursive as boolean | undefined;
        const entries: Array<{ readonly path: string; readonly kind: string }> = [];
        for (const key of store.keys()) {
          if (key.startsWith(path === "/" ? "/" : `${path}/`) || key === path) {
            const relative = key.slice(path.length);
            if (!recursive && relative.split("/").filter(Boolean).length > 1) continue;
            entries.push({
              path: key,
              kind: "file" as const,
            });
          }
        }
        return { entries, truncated: false } as T;
      }

      case "search": {
        const pattern = params.pattern as string;
        const basePath = params.basePath as string;
        const regex = new RegExp(pattern);
        const matches: Array<{
          readonly path: string;
          readonly line: number;
          readonly text: string;
        }> = [];
        for (const [key, value] of store.entries()) {
          if (!key.startsWith(basePath)) continue;
          const lines = value.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line !== undefined && regex.test(line)) {
              matches.push({ path: key, line: i + 1, text: line });
            }
          }
        }
        return { matches, truncated: false } as T;
      }

      case "delete": {
        const path = params.path as string;
        if (!store.has(path)) {
          throw new Error(`Not found: ${path}`);
        }
        store.delete(path);
        return null as T;
      }

      case "rename": {
        const from = params.from as string;
        const to = params.to as string;
        const content = store.get(from);
        if (content === undefined) {
          throw new Error(`Not found: ${from}`);
        }
        store.delete(from);
        store.set(to, content);
        return null as T;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async function close(): Promise<void> {
    // no-op
  }

  return { call, close, store };
}

function createTestBackend(basePath?: string) {
  const transport = createMockTransport();
  const backend = createNexusFileSystem({ transport, basePath });
  return { backend, transport };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("read", () => {
  test("reads file content from Nexus", async () => {
    const { backend, transport } = createTestBackend();
    transport.store.set("/fs/hello.txt", "hello world");

    const result = await backend.read("/hello.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("hello world");
      expect(result.value.path).toBe("/hello.txt");
      expect(result.value.size).toBe(11);
    }
  });

  test("read non-existent file returns NOT_FOUND", async () => {
    const { backend } = createTestBackend();
    const result = await backend.read("/nonexistent.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("read with offset and limit", async () => {
    const { backend, transport } = createTestBackend();
    transport.store.set("/fs/data.txt", "0123456789");

    const result = await backend.read("/data.txt", { offset: 2, limit: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("23456");
    }
  });
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe("write", () => {
  test("writes content to Nexus", async () => {
    const { backend, transport } = createTestBackend();
    const result = await backend.write("/test.txt", "content");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe("/test.txt");
      expect(result.value.bytesWritten).toBe(7);
    }
    expect(transport.store.get("/fs/test.txt")).toBe("content");
  });

  test("empty content write succeeds", async () => {
    const { backend } = createTestBackend();
    const result = await backend.write("/empty.txt", "");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bytesWritten).toBe(0);
    }
  });

  test("write then read roundtrip", async () => {
    const { backend } = createTestBackend();
    await backend.write("/round.txt", "roundtrip");
    const result = await backend.read("/round.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("roundtrip");
    }
  });

  test("write without options sends overwrite: false", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const transport = createMockTransport();
    const originalCall = transport.call.bind(transport);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "write") {
        capturedParams = params;
      }
      return originalCall<T>(method, params);
    };
    (transport as { call: typeof interceptedCall }).call = interceptedCall;

    const backend = createNexusFileSystem({ transport });
    await backend.write("/defaults.txt", "data");

    expect(capturedParams).toBeDefined();
    expect(capturedParams?.overwrite).toBe(false);
    expect(capturedParams?.createDirectories).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe("edit", () => {
  test("applies single hunk", async () => {
    const { backend } = createTestBackend();
    await backend.write("/src.ts", "const x = 1;\nconst y = 2;\n");

    const result = await backend.edit("/src.ts", [
      { oldText: "const x = 1;", newText: "const x = 42;" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hunksApplied).toBe(1);
    }

    const read = await backend.read("/src.ts");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toBe("const x = 42;\nconst y = 2;\n");
    }
  });

  test("applies multiple hunks sequentially", async () => {
    const { backend } = createTestBackend();
    await backend.write("/multi.txt", "aaa bbb ccc");

    const result = await backend.edit("/multi.txt", [
      { oldText: "aaa", newText: "AAA" },
      { oldText: "ccc", newText: "CCC" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hunksApplied).toBe(2);
    }

    const read = await backend.read("/multi.txt");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toBe("AAA bbb CCC");
    }
  });

  test("edit with missing hunk returns VALIDATION error", async () => {
    const { backend } = createTestBackend();
    await backend.write("/miss.txt", "original content");

    const result = await backend.edit("/miss.txt", [
      { oldText: "nonexistent text", newText: "replacement" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("not found");
    }
  });

  test("edit with ambiguous hunk returns VALIDATION error", async () => {
    const { backend } = createTestBackend();
    await backend.write("/dup.txt", "foo bar foo");

    const result = await backend.edit("/dup.txt", [{ oldText: "foo", newText: "baz" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Ambiguous");
    }
  });

  test("dry run does not write", async () => {
    const { backend } = createTestBackend();
    await backend.write("/dry.txt", "original");

    const result = await backend.edit("/dry.txt", [{ oldText: "original", newText: "modified" }], {
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hunksApplied).toBe(1);
    }

    const read = await backend.read("/dry.txt");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.content).toBe("original");
    }
  });

  test("edit non-existent file returns NOT_FOUND", async () => {
    const { backend } = createTestBackend();
    const result = await backend.edit("/ghost.txt", [{ oldText: "a", newText: "b" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("list", () => {
  test("lists files under path", async () => {
    const { backend } = createTestBackend();
    await backend.write("/a.txt", "a");
    await backend.write("/b.txt", "b");

    const result = await backend.list("/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.value.entries.map((e) => e.path);
      expect(paths).toContain("/a.txt");
      expect(paths).toContain("/b.txt");
    }
  });

  test("list returns user-relative paths (basePath stripped)", async () => {
    const { backend } = createTestBackend("/mybase");
    await backend.write("/file.txt", "data");

    const result = await backend.list("/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const entry of result.value.entries) {
        expect(entry.path).not.toContain("mybase");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search", () => {
  test("finds matching content", async () => {
    const { backend } = createTestBackend();
    await backend.write("/searchable.txt", "find this text\nignore this");

    const result = await backend.search("find this");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.value.matches[0]?.text).toContain("find this");
    }
  });

  test("search returns user-relative paths", async () => {
    const { backend } = createTestBackend("/mybase");
    await backend.write("/note.txt", "searchable content");

    const result = await backend.search("searchable");
    expect(result.ok).toBe(true);
    if (result.ok && result.value.matches.length > 0) {
      expect(result.value.matches[0]?.path).toBe("/note.txt");
    }
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  test("deletes existing file", async () => {
    const { backend } = createTestBackend();
    expect(backend.delete).toBeDefined();
    await backend.write("/doomed.txt", "bye");

    const deleteFn = backend.delete;
    if (deleteFn === undefined) throw new Error("delete not defined");
    const result = await deleteFn("/doomed.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe("/doomed.txt");
    }

    const read = await backend.read("/doomed.txt");
    expect(read.ok).toBe(false);
  });

  test("delete non-existent file returns error", async () => {
    const { backend } = createTestBackend();
    const deleteFn = backend.delete;
    if (deleteFn === undefined) throw new Error("delete not defined");
    const result = await deleteFn("/ghost.txt");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

describe("rename", () => {
  test("renames file", async () => {
    const { backend } = createTestBackend();
    const renameFn = backend.rename;
    if (renameFn === undefined) throw new Error("rename not defined");
    await backend.write("/old.txt", "content");

    const result = await renameFn("/old.txt", "/new.txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.from).toBe("/old.txt");
      expect(result.value.to).toBe("/new.txt");
    }

    const oldRead = await backend.read("/old.txt");
    expect(oldRead.ok).toBe(false);

    const newRead = await backend.read("/new.txt");
    expect(newRead.ok).toBe(true);
    if (newRead.ok) {
      expect(newRead.value.content).toBe("content");
    }
  });

  test("rename non-existent file returns error", async () => {
    const { backend } = createTestBackend();
    const renameFn = backend.rename;
    if (renameFn === undefined) throw new Error("rename not defined");
    const result = await renameFn("/ghost.txt", "/new.txt");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("dispose does not throw", async () => {
    const { backend } = createTestBackend();
    const disposeFn = backend.dispose;
    if (disposeFn === undefined) throw new Error("dispose not defined");
    await expect(disposeFn()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe("path safety", () => {
  test("null bytes rejected", async () => {
    const { backend } = createTestBackend();
    const result = await backend.read("/file\0.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("null bytes");
    }
  });

  test("path traversal beyond basePath rejected", async () => {
    const { backend } = createTestBackend("/safe");
    const result = await backend.read("/../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("traversal");
    }
  });

  test("malformed percent-encoding rejected", async () => {
    const { backend } = createTestBackend();
    const result = await backend.read("/%ZZ/bad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("percent-encoding");
    }
  });

  test("backslash normalized to forward slash", async () => {
    const { backend, transport } = createTestBackend();
    transport.store.set("/fs/dir/file.txt", "content");

    const result = await backend.read("\\dir\\file.txt");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("error mapping", () => {
  test("timeout error is retryable", async () => {
    const transport: NexusTransport = {
      call: async () => {
        throw new Error("request timed out");
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const result = await backend.read("/any.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("connection error maps to EXTERNAL retryable", async () => {
    const transport: NexusTransport = {
      call: async () => {
        throw new Error("connection refused");
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const result = await backend.read("/any.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("permission error is not retryable", async () => {
    const transport: NexusTransport = {
      call: async () => {
        throw new Error("403 permission denied");
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const result = await backend.read("/any.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.retryable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("validateNexusFileSystemConfig", () => {
  test("valid config passes", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport });
    expect(result.ok).toBe(true);
  });

  test("empty basePath fails", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath with traversal fails", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "agents/../secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath '/' (root) fails validation", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "/" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath '///' (all slashes) fails validation", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "///" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath with backslash traversal fails validation", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "safe\\..\\other" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath with percent-encoded traversal fails validation", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "safe%2F..%2Fother" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath with malformed percent-encoding fails validation", () => {
    const transport = createMockTransport();
    const result = validateNexusFileSystemConfig({ transport, basePath: "bad%ZZpath" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("factory throws on invalid config", () => {
    // @ts-expect-error — testing runtime validation
    expect(() => createNexusFileSystem({ transport: null })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Custom basePath
// ---------------------------------------------------------------------------

describe("custom basePath", () => {
  test("uses custom basePath prefix", async () => {
    const { backend } = createTestBackend("/custom/base");

    const writeResult = await backend.write("/hello.txt", "content");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/hello.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("content");
    }
  });

  test("default basePath is fs", async () => {
    const { backend, transport } = createTestBackend();

    await backend.write("/test.txt", "data");
    // Verify it was stored under /fs/ prefix
    expect(transport.store.has("/fs/test.txt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backend name
// ---------------------------------------------------------------------------

describe("backend metadata", () => {
  test("name is nexus", () => {
    const { backend } = createTestBackend();
    expect(backend.name).toBe("nexus");
  });
});

// ---------------------------------------------------------------------------
// Mutation safety — no automatic retries for writes
// ---------------------------------------------------------------------------

describe("mutation safety", () => {
  test("write does not retry on transient failure", async () => {
    let callCount = 0;
    const transport: NexusTransport = {
      call: async <T>(method: string, _params: Record<string, unknown>): Promise<T> => {
        callCount += 1;
        if (method === "write") {
          throw new Error("connection refused");
        }
        return null as T;
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const result = await backend.write("/test.txt", "data");
    expect(result.ok).toBe(false);
    // Should only have been called once — no retries for mutations
    expect(callCount).toBe(1);
  });

  test("delete does not retry on transient failure", async () => {
    let callCount = 0;
    const transport: NexusTransport = {
      call: async () => {
        callCount += 1;
        throw new Error("request timed out");
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const deleteFn = backend.delete;
    if (deleteFn === undefined) throw new Error("delete not defined");
    const result = await deleteFn("/test.txt");
    expect(result.ok).toBe(false);
    expect(callCount).toBe(1);
  });

  test("rename does not retry on transient failure", async () => {
    let callCount = 0;
    const transport: NexusTransport = {
      call: async () => {
        callCount += 1;
        throw new Error("connection refused");
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const renameFn = backend.rename;
    if (renameFn === undefined) throw new Error("rename not defined");
    const result = await renameFn("/a.txt", "/b.txt");
    expect(result.ok).toBe(false);
    expect(callCount).toBe(1);
  });

  test("read retries on transient failure", async () => {
    let callCount = 0;
    const transport: NexusTransport = {
      call: async <T>(_method: string, _params: Record<string, unknown>): Promise<T> => {
        callCount += 1;
        if (callCount <= 2) {
          throw new Error("connection refused");
        }
        return { content: "ok", path: "/fs/test.txt", size: 2 } as T;
      },
      close: async () => {},
    };
    const backend = createNexusFileSystem({ transport });
    const result = await backend.read("/test.txt");
    expect(result.ok).toBe(true);
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });
});

// ---------------------------------------------------------------------------
// Edit CAS (content-hash compare-and-swap)
// ---------------------------------------------------------------------------

describe("edit CAS via capabilities negotiation", () => {
  test("edit sends expectedContentHash when server supports CAS", async () => {
    const { backend, transport } = createTestBackend();
    await backend.write("/cas.txt", "original");

    let capturedWriteParams: Record<string, unknown> | undefined;
    const originalCall = transport.call.bind(transport);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "write" && params.expectedContentHash !== undefined) {
        capturedWriteParams = params;
      }
      return originalCall<T>(method, params);
    };
    (transport as { call: typeof interceptedCall }).call = interceptedCall;

    const result = await backend.edit("/cas.txt", [{ oldText: "original", newText: "modified" }]);
    expect(result.ok).toBe(true);

    expect(capturedWriteParams).toBeDefined();
    expect(typeof capturedWriteParams?.expectedContentHash).toBe("string");
    expect((capturedWriteParams?.expectedContentHash as string).length).toBe(64);
  });

  test("edit dry run skips capabilities check and write", async () => {
    const { backend, transport } = createTestBackend();
    await backend.write("/cas-dry.txt", "content");

    let writeWithHashCount = 0;
    const originalCall = transport.call.bind(transport);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "write" && params.expectedContentHash !== undefined) {
        writeWithHashCount += 1;
      }
      return originalCall<T>(method, params);
    };
    (transport as { call: typeof interceptedCall }).call = interceptedCall;

    await backend.edit("/cas-dry.txt", [{ oldText: "content", newText: "new" }], { dryRun: true });
    expect(writeWithHashCount).toBe(0);
  });

  test("CAS write rejected by server returns CONFLICT", async () => {
    const { backend, transport } = createTestBackend();
    await backend.write("/cas-reject.txt", "original");

    const originalCall = transport.call.bind(transport);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "write" && params.expectedContentHash !== undefined) {
        throw new Error("409 conflict: content hash mismatch");
      }
      return originalCall<T>(method, params);
    };
    (transport as { call: typeof interceptedCall }).call = interceptedCall;

    const result = await backend.edit("/cas-reject.txt", [
      { oldText: "original", newText: "modified" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("edit blocked when server does not support CAS", async () => {
    // Create a transport where capabilities returns { cas: false }
    const transport = createMockTransport();
    const originalCall = transport.call.bind(transport);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "capabilities") {
        return { cas: false } as T;
      }
      return originalCall<T>(method, params);
    };
    (transport as { call: typeof interceptedCall }).call = interceptedCall;

    const backend = createNexusFileSystem({ transport });
    await backend.write("/no-cas.txt", "content");

    const result = await backend.edit("/no-cas.txt", [{ oldText: "content", newText: "new" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("CAS");
    }

    // File must NOT have been mutated — blocked before write
    const readResult = await backend.read("/no-cas.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("content");
    }
  });

  test("capabilities check is cached across multiple edits", async () => {
    const { backend, transport } = createTestBackend();
    await backend.write("/cached.txt", "aaa bbb");

    let capabilitiesCallCount = 0;
    const originalCall = transport.call.bind(transport);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "capabilities") {
        capabilitiesCallCount += 1;
      }
      return originalCall<T>(method, params);
    };
    (transport as { call: typeof interceptedCall }).call = interceptedCall;

    await backend.edit("/cached.txt", [{ oldText: "aaa", newText: "AAA" }]);
    await backend.write("/cached2.txt", "xxx yyy");
    await backend.edit("/cached2.txt", [{ oldText: "xxx", newText: "XXX" }]);

    // capabilities should only be called once, then cached
    expect(capabilitiesCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Flat list — extensionless files
// ---------------------------------------------------------------------------

describe("list flat response handling", () => {
  function createFlatListTransport(files: readonly string[]): NexusTransport & {
    readonly store: Map<string, string>;
  } {
    const mock = createMockTransport();
    const originalCall = mock.call.bind(mock);
    const interceptedCall = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "list") {
        return { files } as T;
      }
      return originalCall<T>(method, params);
    };
    (mock as { call: typeof interceptedCall }).call = interceptedCall;
    return mock;
  }

  test("extensionless files are listed as files, not directories", async () => {
    const transport = createFlatListTransport([
      "/fs/Dockerfile",
      "/fs/LICENSE",
      "/fs/Makefile",
      "/fs/README",
      "/fs/src/main.ts",
    ]);
    const backend = createNexusFileSystem({ transport });
    const result = await backend.list("/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const filePaths = result.value.entries.filter((e) => e.kind === "file").map((e) => e.path);
      expect(filePaths).toContain("/Dockerfile");
      expect(filePaths).toContain("/LICENSE");
      expect(filePaths).toContain("/Makefile");
      expect(filePaths).toContain("/README");

      // Non-recursive: nested path collapsed to directory
      const dirPaths = result.value.entries
        .filter((e) => e.kind === "directory")
        .map((e) => e.path);
      expect(dirPaths).toContain("/src");
    }
  });

  test("non-recursive list collapses nested paths to directories", async () => {
    const transport = createFlatListTransport([
      "/fs/a.txt",
      "/fs/src/main.ts",
      "/fs/src/lib/utils.ts",
      "/fs/docs/readme.md",
    ]);
    const backend = createNexusFileSystem({ transport });
    const result = await backend.list("/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.value.entries.map((e) => `${e.kind}:${e.path}`);
      expect(paths).toContain("file:/a.txt");
      expect(paths).toContain("directory:/src");
      expect(paths).toContain("directory:/docs");
      // Nested files should NOT appear in non-recursive listing
      expect(paths).not.toContain("file:/src/main.ts");
      expect(paths).not.toContain("file:/src/lib/utils.ts");
    }
  });

  test("recursive list emits all descendant files", async () => {
    const transport = createFlatListTransport([
      "/fs/a.txt",
      "/fs/src/main.ts",
      "/fs/src/lib/utils.ts",
      "/fs/docs/readme.md",
    ]);
    const backend = createNexusFileSystem({ transport });
    const result = await backend.list("/", { recursive: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.value.entries.map((e) => e.path);
      expect(paths).toContain("/a.txt");
      expect(paths).toContain("/src/main.ts");
      expect(paths).toContain("/src/lib/utils.ts");
      expect(paths).toContain("/docs/readme.md");
      // All should be files
      for (const entry of result.value.entries) {
        expect(entry.kind).toBe("file");
      }
    }
  });

  test("out-of-scope entries from flat list are filtered out", async () => {
    const transport = createFlatListTransport([
      "/fs/a.txt",
      "/fs/b.txt",
      "/other-tenant/secret.txt", // out of scope — wrong prefix
      "/random/path.log", // out of scope
    ]);
    const backend = createNexusFileSystem({ transport });
    const result = await backend.list("/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.value.entries.map((e) => e.path);
      expect(paths).toContain("/a.txt");
      expect(paths).toContain("/b.txt");
      // Out-of-scope entries must not appear
      expect(paths).not.toContain("/other-tenant/secret.txt");
      expect(paths).not.toContain("/random/path.log");
      expect(paths).not.toContain("/secret.txt");
      expect(paths).not.toContain("/path.log");
      expect(result.value.entries.length).toBe(2);
    }
  });
});
