import { beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/fs-nexus";
import type { AtifDocument } from "./atif-types.js";
import { createNexusAtifDelegate } from "./nexus-delegate.js";

// ---------------------------------------------------------------------------
// Stub transport backed by a Map (simulates Nexus VFS in-memory)
// ---------------------------------------------------------------------------

interface StubTransportOptions {
  /** Inject errors for specific methods. Called before normal handling. */
  readonly errorInjector?: (
    method: string,
    params: Record<string, unknown>,
  ) => Result<unknown, KoiError> | undefined;
}

function createStubTransport(options?: StubTransportOptions): NexusTransport {
  const files = new Map<string, string>();

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    // Check error injector first
    const injected = options?.errorInjector?.(method, params);
    if (injected !== undefined) return injected as Result<T, KoiError>;

    const path = params.path as string | undefined;

    if (method === "read") {
      if (path === undefined || !files.has(path)) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "File not found", retryable: false },
        };
      }
      return { ok: true, value: files.get(path) as T };
    }

    if (method === "write") {
      if (path === undefined) {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "Missing path", retryable: false },
        };
      }
      files.set(path, params.content as string);
      return { ok: true, value: null as T };
    }

    if (method === "glob") {
      const pattern = params.pattern as string;
      // Simple glob: basePath/*.atif.json → match files under that prefix
      const prefix = pattern.replace("/*.atif.json", "/");
      const matches = [...files.keys()].filter(
        (k) => k.startsWith(prefix) && k.endsWith(".atif.json"),
      );
      return { ok: true, value: matches as T };
    }

    if (method === "exists") {
      return { ok: true, value: (path !== undefined && files.has(path)) as T };
    }

    if (method === "delete") {
      if (path === undefined || !files.has(path)) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "File not found", retryable: false },
        };
      }
      files.delete(path);
      return { ok: true, value: null as T };
    }

    return {
      ok: false,
      error: { code: "EXTERNAL", message: `Unknown method: ${method}`, retryable: false },
    };
  }

  return {
    call,
    subscribe: () => () => {},
    submitAuthCode: () => {},
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const DOC: AtifDocument = {
  schema_version: "ATIF-v1.6",
  session_id: "test-session",
  agent: { name: "test-agent" },
  steps: [
    {
      step_id: 0,
      source: "agent",
      timestamp: new Date().toISOString(),
      model_name: "test-model",
      message: "hello",
      outcome: "success",
      duration_ms: 100,
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusAtifDelegate", () => {
  // let: transport changes per test when error injection is needed
  let transport: NexusTransport;

  beforeEach(() => {
    transport = createStubTransport();
  });

  test("write and read round-trip", async () => {
    const delegate = createNexusAtifDelegate({ transport });
    await delegate.write("doc1", DOC);
    const result = await delegate.read("doc1");
    expect(result).toBeDefined();
    expect(result?.session_id).toBe("test-session");
    expect(result?.steps).toHaveLength(1);
  });

  test("read returns undefined for missing document", async () => {
    const delegate = createNexusAtifDelegate({ transport });
    const result = await delegate.read("nonexistent");
    expect(result).toBeUndefined();
  });

  test("list returns all document IDs via glob", async () => {
    const delegate = createNexusAtifDelegate({ transport });
    await delegate.write("alpha", DOC);
    await delegate.write("beta", DOC);
    await delegate.write("gamma", DOC);
    const ids = await delegate.list();
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).toContain("gamma");
    expect(ids).toHaveLength(3);
  });

  test("delete removes a document", async () => {
    const delegate = createNexusAtifDelegate({ transport });
    await delegate.write("to-delete", DOC);
    const deleted = await delegate.delete("to-delete");
    expect(deleted).toBe(true);
    const result = await delegate.read("to-delete");
    expect(result).toBeUndefined();
  });

  test("delete returns false for missing document", async () => {
    const delegate = createNexusAtifDelegate({ transport });
    const deleted = await delegate.delete("never-existed");
    expect(deleted).toBe(false);
  });

  test("handles special characters in docId (emoji, slashes, dots)", async () => {
    const delegate = createNexusAtifDelegate({ transport });
    const ids = ["session-🐟", "../traversal", ".hidden", "a/b/c"];
    for (const id of ids) {
      await delegate.write(id, { ...DOC, session_id: id });
    }
    const listed = await delegate.list();
    for (const id of ids) {
      expect(listed).toContain(id);
      const doc = await delegate.read(id);
      expect(doc?.session_id).toBe(id);
    }
  });

  test("decodes structured {content, metadata} envelope response", async () => {
    // Nexus read may return { content: string, metadata? } instead of raw string
    const envelopeTransport = createStubTransport({
      errorInjector(method, params) {
        if (method === "read" && (params.path as string).includes("envelope-doc")) {
          return {
            ok: true,
            value: { content: JSON.stringify(DOC), metadata: { size: 123 } },
          };
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: envelopeTransport });
    const result = await delegate.read("envelope-doc");
    expect(result).toBeDefined();
    expect(result?.session_id).toBe("test-session");
    expect(result?.steps).toHaveLength(1);
  });

  test("decodes bytes envelope response", async () => {
    // Create a transport that returns bytes-envelope format on read
    const bytesTransport = createStubTransport({
      errorInjector(method, params) {
        if (method === "read" && (params.path as string).includes("bytes-doc")) {
          const encoded = Buffer.from(JSON.stringify(DOC)).toString("base64");
          return {
            ok: true,
            value: { __type__: "bytes", data: encoded },
          };
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: bytesTransport });
    // Need to write first so exists check passes for other operations
    // But read directly uses the injected bytes response
    const result = await delegate.read("bytes-doc");
    expect(result).toBeDefined();
    expect(result?.session_id).toBe("test-session");
  });

  test("retries write on RATE_LIMIT error", async () => {
    // let: tracks call count to fail first attempt
    let writeCallCount = 0;
    const rateLimitTransport = createStubTransport({
      errorInjector(method) {
        if (method === "write") {
          writeCallCount++;
          if (writeCallCount === 1) {
            return {
              ok: false,
              error: { code: "RATE_LIMIT", message: "Too many requests", retryable: true },
            };
          }
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: rateLimitTransport });
    // Should succeed on retry (second attempt)
    await delegate.write("rate-limited", DOC);
    expect(writeCallCount).toBe(2);
  });

  test("throws on auth/permission error (not swallowed as undefined)", async () => {
    const authTransport = createStubTransport({
      errorInjector(method) {
        if (method === "read") {
          return {
            ok: false,
            error: { code: "PERMISSION", message: "Access denied", retryable: false },
          };
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: authTransport });
    await expect(delegate.read("forbidden")).rejects.toThrow("Access denied");
  });

  test("delete propagates permission errors (not masked as false)", async () => {
    const permTransport = createStubTransport({
      errorInjector(method) {
        if (method === "delete") {
          return {
            ok: false,
            error: { code: "PERMISSION", message: "Access denied", retryable: false },
          };
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: permTransport });
    await expect(delegate.delete("some-doc")).rejects.toThrow("Access denied");
  });

  test("throws on EXTERNAL error (not swallowed as undefined)", async () => {
    const externalTransport = createStubTransport({
      errorInjector(method) {
        if (method === "read") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "Server error", retryable: false },
          };
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: externalTransport });
    await expect(delegate.read("broken")).rejects.toThrow("Server error");
  });

  test("custom basePath is used in file paths", async () => {
    const delegate = createNexusAtifDelegate({
      transport,
      basePath: "custom/prefix",
    });
    await delegate.write("doc1", DOC);
    const result = await delegate.read("doc1");
    expect(result).toBeDefined();
    // List should also work under the custom path
    const ids = await delegate.list();
    expect(ids).toContain("doc1");
  });

  test("glob response with matches wrapper is handled", async () => {
    const wrappedGlobTransport = createStubTransport({
      errorInjector(method) {
        if (method === "glob") {
          return {
            ok: true,
            value: { matches: ["trajectories/doc1.atif.json", "trajectories/doc2.atif.json"] },
          };
        }
        return undefined;
      },
    });
    const delegate = createNexusAtifDelegate({ transport: wrappedGlobTransport });
    const ids = await delegate.list();
    expect(ids).toContain("doc1");
    expect(ids).toContain("doc2");
    expect(ids).toHaveLength(2);
  });
});

describe("createNexusAtifDelegate basePath validation", () => {
  const transport = createStubTransport();

  test("rejects empty basePath", () => {
    expect(() => createNexusAtifDelegate({ transport, basePath: "" })).toThrow("must not be empty");
  });

  test("rejects basePath with '..' segments", () => {
    expect(() => createNexusAtifDelegate({ transport, basePath: "../escape" })).toThrow(
      "must not contain '..'",
    );
    expect(() => createNexusAtifDelegate({ transport, basePath: "a/../../b" })).toThrow(
      "must not contain '..'",
    );
  });

  test("rejects basePath with trailing slash", () => {
    expect(() => createNexusAtifDelegate({ transport, basePath: "trajectories/" })).toThrow(
      "must not end with '/'",
    );
  });

  test("accepts valid basePath", () => {
    expect(() =>
      createNexusAtifDelegate({ transport, basePath: "agents/my-agent/trajectories" }),
    ).not.toThrow();
  });
});
