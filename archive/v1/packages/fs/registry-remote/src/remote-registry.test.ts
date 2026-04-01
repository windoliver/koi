import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickPage } from "@koi/core";
import { createRemoteRegistry } from "./remote-registry.js";
import type { BatchCheckResult, RemoteRegistryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
  return {
    id: "sha256:abc123" as BrickArtifact["id"],
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "session",
    origin: { type: "forged" },
    policy: { autoApprove: true },
    lifecycle: "active",
    provenance: {
      source: { origin: "forged", forgedBy: "agent-1", sessionId: "s1" },
      buildDefinition: { buildType: "koi.forge/tool/v1", externalParameters: {} },
      builder: { id: "koi.forge/pipeline/v1" },
      metadata: {
        invocationId: "inv-1",
        startedAt: 1000,
        finishedAt: 2000,
        sessionId: "s1",
        agentId: "agent-1",
        depth: 0,
      },
      verification: {
        passed: true,
        sandbox: true,
        totalDurationMs: 100,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: "abc123",
    },
    version: "1.0.0",
    tags: ["test"],
    usageCount: 0,
    implementation: "function test() {}",
    inputSchema: {},
    ...overrides,
  } as BrickArtifact;
}

type FetchFn = typeof globalThis.fetch;

function createMockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): FetchFn {
  return handler as FetchFn;
}

function createConfig(fetchFn: FetchFn): RemoteRegistryConfig {
  return {
    baseUrl: "https://registry.example.com",
    authToken: "test-token",
    fetch: fetchFn,
    timeoutMs: 5000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRemoteRegistry", () => {
  describe("search", () => {
    test("sends correct query params", async () => {
      let capturedUrl = "";
      const mockFetch = createMockFetch(async (url) => {
        capturedUrl = url;
        const page: BrickPage = { items: [], total: 0 };
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      await registry.search({
        kind: "tool",
        text: "search term",
        tags: ["ai", "code"],
        namespace: "@author",
        limit: 10,
        cursor: "abc",
      });

      expect(capturedUrl).toContain("/v1/bricks?");
      expect(capturedUrl).toContain("kind=tool");
      expect(capturedUrl).toContain("text=search+term");
      expect(capturedUrl).toContain("tags=ai%2Ccode");
      expect(capturedUrl).toContain("namespace=%40author");
      expect(capturedUrl).toContain("limit=10");
      expect(capturedUrl).toContain("cursor=abc");
    });

    test("returns parsed BrickPage", async () => {
      const brick = createMockBrick();
      const page: BrickPage = { items: [brick], total: 1 };

      const mockFetch = createMockFetch(async () => {
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.search({ text: "test" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.name).toBe("test-tool");
      expect(result.total).toBe(1);
    });

    test("ETag caching sends If-None-Match header", async () => {
      let requestCount = 0;
      let capturedHeaders: Record<string, string> = {};
      const page: BrickPage = { items: [], total: 0 };

      const mockFetch = createMockFetch(async (_url, init) => {
        requestCount++;
        const headers = init?.headers as Record<string, string> | undefined;
        capturedHeaders = headers ?? {};

        if (requestCount === 1) {
          return new Response(JSON.stringify(page), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ETag: '"etag-v1"',
            },
          });
        }

        // Second request: return 304
        return new Response(null, { status: 304 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));

      // First request — no If-None-Match
      await registry.search({ text: "test" });
      expect(capturedHeaders["If-None-Match"]).toBeUndefined();

      // Second request — should send If-None-Match with cached ETag
      const result = await registry.search({ text: "test" });
      expect(capturedHeaders["If-None-Match"]).toBe('"etag-v1"');
      expect(result).toEqual(page);
    });

    test("throws on server error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));

      await expect(registry.search({ text: "test" })).rejects.toThrow(
        "Remote registry search failed",
      );
    });
  });

  describe("get", () => {
    test("returns parsed BrickArtifact", async () => {
      const brick = createMockBrick();
      const mockFetch = createMockFetch(async () => {
        return new Response(JSON.stringify(brick), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "test-tool");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("test-tool");
        expect(result.value.kind).toBe("tool");
      }
    });

    test("returns NOT_FOUND for missing brick", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Not Found", { status: 404 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("sends namespace in URL path", async () => {
      let capturedUrl = "";
      const brick = createMockBrick();
      const mockFetch = createMockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify(brick), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      await registry.get("tool", "my-tool", "@author");

      expect(capturedUrl).toContain("/v1/bricks/%40author/my-tool");
      expect(capturedUrl).toContain("kind=tool");
    });

    test("uses _ for no namespace", async () => {
      let capturedUrl = "";
      const brick = createMockBrick();
      const mockFetch = createMockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify(brick), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      await registry.get("tool", "my-tool");

      expect(capturedUrl).toContain("/v1/bricks/_/my-tool");
    });
  });

  describe("loadByHash", () => {
    test("hits correct endpoint", async () => {
      let capturedUrl = "";
      const brick = createMockBrick();
      const mockFetch = createMockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify(brick), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.loadByHash("deadbeef");

      expect(capturedUrl).toContain("/v1/bricks/hash/deadbeef");
      expect(result.ok).toBe(true);
    });

    test("returns NOT_FOUND for missing hash", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Not Found", { status: 404 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.loadByHash("missing-hash");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("batchCheck", () => {
    test("sends POST with hashes array", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedMethod = "";
      const batchResult: BatchCheckResult = {
        existing: ["hash1"],
        missing: ["hash2"],
      };

      const mockFetch = createMockFetch(async (url, init) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "";
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return new Response(JSON.stringify(batchResult), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.batchCheck(["hash1", "hash2"]);

      expect(capturedUrl).toContain("/v1/batch-check");
      expect(capturedMethod).toBe("POST");
      expect(JSON.parse(capturedBody)).toEqual({ hashes: ["hash1", "hash2"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.existing).toEqual(["hash1"]);
        expect(result.value.missing).toEqual(["hash2"]);
      }
    });
  });

  describe("dispose", () => {
    test("clears cache without error", () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("{}", { status: 200 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      // Should not throw
      registry.dispose();
    });
  });

  describe("error handling", () => {
    test("rate limit returns RATE_LIMIT error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Too Many Requests", { status: 429 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "some-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RATE_LIMIT");
        expect(result.error.retryable).toBe(true);
      }
    });

    test("permission denied returns PERMISSION error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Forbidden", { status: 403 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "some-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PERMISSION");
      }
    });

    test("conflict returns CONFLICT error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Conflict", { status: 409 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "some-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.retryable).toBe(true);
      }
    });

    test("server error returns retryable EXTERNAL error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "some-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.retryable).toBe(true);
      }
    });

    test("unknown 4xx returns non-retryable EXTERNAL error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Gone", { status: 410 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "some-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.retryable).toBe(false);
      }
    });

    test("network error returns error", async () => {
      const mockFetch = createMockFetch(async () => {
        throw new TypeError("Network request failed");
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.get("tool", "some-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Network request failed");
      }
    });

    test("timeout returns TIMEOUT error", async () => {
      const mockFetch = createMockFetch(async (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        });
      });

      const config: RemoteRegistryConfig = {
        baseUrl: "https://registry.example.com",
        authToken: "test-token",
        fetch: mockFetch,
        timeoutMs: 1, // 1ms to trigger quickly
      };
      const registry = createRemoteRegistry(config);
      const result = await registry.get("tool", "test-tool");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
        expect(result.error.retryable).toBe(true);
      }
    });

    test("batchCheck server error returns error", async () => {
      const mockFetch = createMockFetch(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      const result = await registry.batchCheck(["hash1"]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
      }
    });
  });

  describe("auth header", () => {
    test("sends Authorization header when authToken provided", async () => {
      let capturedHeaders: Record<string, string> = {};
      const mockFetch = createMockFetch(async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const registry = createRemoteRegistry(createConfig(mockFetch));
      await registry.search({});

      expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    });

    test("omits Authorization header when no authToken", async () => {
      let capturedHeaders: Record<string, string> = {};
      const mockFetch = createMockFetch(async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const config: RemoteRegistryConfig = {
        baseUrl: "https://registry.example.com",
        fetch: mockFetch,
      };
      const registry = createRemoteRegistry(config);
      await registry.search({});

      expect(capturedHeaders.Authorization).toBeUndefined();
    });
  });
});
