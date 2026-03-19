import { describe, expect, test } from "bun:test";
import type { BrickArtifact } from "@koi/core";
import { publishBrick } from "./publish.js";
import type { IntegrityVerifier, PublishOptions, PublishResult } from "./types.js";

/** Always-passing integrity verifier for tests that focus on HTTP behavior. */
const passingVerifier: IntegrityVerifier = () => ({ ok: true, kind: "ok" });

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

function createOptions(fetchFn: FetchFn): PublishOptions {
  return {
    registryUrl: "https://registry.example.com",
    authToken: "pub-token-123",
    fetch: fetchFn,
    timeoutMs: 5000,
    verifyIntegrity: passingVerifier,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publishBrick", () => {
  test("successful publish returns PublishResult", async () => {
    const brick = createMockBrick();
    const publishResult: PublishResult = {
      id: brick.id,
      kind: "tool",
      name: "test-tool",
      url: "https://registry.example.com/bricks/test-tool",
      publishedAt: "2026-01-01T00:00:00Z",
    };

    const mockFetch = createMockFetch(async () => {
      return new Response(JSON.stringify(publishResult), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("test-tool");
      expect(result.value.url).toBe("https://registry.example.com/bricks/test-tool");
      expect(result.value.publishedAt).toBe("2026-01-01T00:00:00Z");
    }
  });

  test("sends brick as JSON body with auth header", async () => {
    const brick = createMockBrick();
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetch = createMockFetch(async (url, init) => {
      capturedUrl = url;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          id: brick.id,
          kind: "tool",
          name: "test-tool",
          url: "https://registry.example.com/bricks/test-tool",
          publishedAt: "2026-01-01T00:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    await publishBrick(brick, createOptions(mockFetch));

    expect(capturedUrl).toContain("/v1/bricks");
    expect(capturedHeaders.Authorization).toBe("Bearer pub-token-123");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(JSON.parse(capturedBody).name).toBe("test-tool");
  });

  test("missing auth token on server returns PERMISSION error", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("Authentication required");
    }
  });

  test("server error returns EXTERNAL error with status", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("500");
    }
  });

  test("conflict returns CONFLICT error", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Brick already exists", { status: 409 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("brick without provenance returns VALIDATION error", async () => {
    // Create a brick without provenance by using undefined
    const brick = createMockBrick();
    const brickNoProvenance = { ...brick, provenance: undefined } as unknown as BrickArtifact;

    const mockFetch = createMockFetch(async () => {
      return new Response("{}", { status: 200 });
    });

    const result = await publishBrick(brickNoProvenance, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("provenance");
    }
  });

  test("default passthrough verifier allows publish", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response(
        JSON.stringify({
          id: brick.id,
          kind: brick.kind,
          name: brick.name,
          url: "https://registry.example.com/v1/bricks/_/test-tool",
          publishedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // No verifyIntegrity — passthrough allows publish
    const result = await publishBrick(brick, {
      registryUrl: "https://registry.example.com",
      authToken: "pub-token-123",
      fetch: mockFetch,
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
  });

  test("integrity check failure returns VALIDATION error", async () => {
    const brick = createMockBrick();
    const failingVerifier: IntegrityVerifier = () => ({
      ok: false,
      kind: "content_mismatch",
    });

    const mockFetch = createMockFetch(async () => {
      return new Response("{}", { status: 200 });
    });

    const result = await publishBrick(brick, {
      ...createOptions(mockFetch),
      verifyIntegrity: failingVerifier,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("integrity");
    }
  });

  test("forbidden returns PERMISSION error", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Forbidden", { status: 403 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("Insufficient permissions");
    }
  });

  test("payload too large returns VALIDATION error", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Payload Too Large", { status: 413 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("too large");
    }
  });

  test("unknown HTTP error returns EXTERNAL error", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Bad Gateway", { status: 502 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("network error returns error with cause", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to fetch");
    }
  });

  test("timeout returns TIMEOUT error", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async (_url, init) => {
      // Simulate timeout by waiting for the signal to abort
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            const err = new DOMException("The operation was aborted.", "AbortError");
            reject(err);
          });
        }
      });
    });

    const result = await publishBrick(brick, {
      ...createOptions(mockFetch),
      timeoutMs: 1, // 1ms timeout to trigger quickly
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("non-standard 4xx error returns non-retryable EXTERNAL", async () => {
    const brick = createMockBrick();
    const mockFetch = createMockFetch(async () => {
      return new Response("Gone", { status: 410 });
    });

    const result = await publishBrick(brick, createOptions(mockFetch));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });
});
