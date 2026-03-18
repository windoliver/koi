/**
 * Tests for the community registry HTTP handler.
 *
 * Uses an in-memory BrickRegistryBackend to verify all REST routes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  BrickKind,
  BrickPage,
  BrickRegistryBackend,
  BrickRegistryChangeEvent,
  BrickSearchQuery,
  ForgeProvenance,
  KoiError,
  Result,
  ToolArtifact,
} from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { createCommunityRegistryHandler } from "./handler.js";
import type { CommunityRegistryConfig, SecurityGate, SecurityGateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow a nullable response to a definite Response, failing the test if null. */
function requireResponse(res: Response | null): Response {
  expect(res).not.toBeNull();
  if (res === null) {
    throw new Error("Expected non-null Response");
  }
  return res;
}

// ---------------------------------------------------------------------------
// Default provenance for test artifacts
// ---------------------------------------------------------------------------

const TEST_PROVENANCE: ForgeProvenance = {
  source: { origin: "forged", forgedBy: "agent-1", sessionId: "session-1" },
  buildDefinition: { buildType: "koi.forge/tool/v1", externalParameters: {} },
  builder: { id: "koi.forge/pipeline/v1", version: "0.0.1" },
  metadata: {
    invocationId: "inv-test-001",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    sessionId: "session-1",
    agentId: "agent-1",
    depth: 0,
  },
  verification: {
    passed: true,
    sandbox: true,
    totalDurationMs: 1000,
    stageResults: [
      { stage: "static", passed: true, durationMs: 100 },
      { stage: "sandbox", passed: true, durationMs: 400 },
      { stage: "self_test", passed: true, durationMs: 300 },
      { stage: "trust", passed: true, durationMs: 200 },
    ],
  },
  classification: "public",
  contentMarkers: [],
  contentHash: "hash-alpha",
};

function createToolBrick(overrides: Partial<ToolArtifact> = {}): ToolArtifact {
  return {
    id: brickId("brick_test-tool"),
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance: TEST_PROVENANCE,
    version: "0.0.1",
    tags: ["math"],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  } satisfies ToolArtifact;
}

// ---------------------------------------------------------------------------
// In-memory registry backend for testing
// ---------------------------------------------------------------------------

function createInMemoryRegistry(): BrickRegistryBackend {
  const bricks = new Map<string, BrickArtifact>();
  const listeners = new Set<(event: BrickRegistryChangeEvent) => void>();

  function registryKey(kind: BrickKind, name: string): string {
    return `${kind}:${name}`;
  }

  function notify(event: BrickRegistryChangeEvent): void {
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  const search = (query: BrickSearchQuery): BrickPage => {
    const limit = query.limit ?? 50;
    const all = [...bricks.values()];
    const filtered = all.filter((brick) => {
      if (query.kind !== undefined && brick.kind !== query.kind) return false;
      if (query.text !== undefined) {
        const lower = query.text.toLowerCase();
        if (
          !brick.name.toLowerCase().includes(lower) &&
          !brick.description.toLowerCase().includes(lower)
        ) {
          return false;
        }
      }
      if (query.namespace !== undefined && brick.namespace !== query.namespace) return false;
      if (query.tags !== undefined && query.tags.length > 0) {
        for (const tag of query.tags) {
          if (!brick.tags.includes(tag)) return false;
        }
      }
      return true;
    });
    const startIndex = query.cursor !== undefined ? Number(query.cursor) : 0;
    const page = filtered.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const hasMore = nextIndex < filtered.length;
    return {
      items: page,
      ...(hasMore ? { cursor: String(nextIndex) } : {}),
      total: filtered.length,
    };
  };

  const get = (
    kind: BrickKind,
    name: string,
    namespace?: string,
  ): Result<BrickArtifact, KoiError> => {
    const k = registryKey(kind, name);
    const brick = bricks.get(k);
    if (brick === undefined || (namespace !== undefined && brick.namespace !== namespace)) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Brick ${kind}:${name} not found`, retryable: false },
      };
    }
    return { ok: true, value: brick };
  };

  const register = (brick: BrickArtifact): Result<void, KoiError> => {
    const k = registryKey(brick.kind, brick.name);
    bricks.set(k, brick);
    notify({ kind: "registered", brickKind: brick.kind, name: brick.name });
    return { ok: true, value: undefined };
  };

  const unregister = (kind: BrickKind, name: string): Result<void, KoiError> => {
    const k = registryKey(kind, name);
    if (!bricks.has(k)) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Brick ${kind}:${name} not found`, retryable: false },
      };
    }
    bricks.delete(k);
    notify({ kind: "unregistered", brickKind: kind, name });
    return { ok: true, value: undefined };
  };

  const onChange = (listener: (event: BrickRegistryChangeEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { search, get, register, unregister, onChange };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("createCommunityRegistryHandler", () => {
  const AUTH_TOKEN = "test-token-abc123";
  let registry: BrickRegistryBackend;
  let config: CommunityRegistryConfig;
  let handler: (req: Request) => Promise<Response | null>;
  let dispose: () => void;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    config = {
      registry,
      authTokens: new Set([AUTH_TOKEN]),
    };
    const result = createCommunityRegistryHandler(config);
    handler = result.handler;
    dispose = result.dispose;
  });

  afterEach(() => {
    dispose();
  });

  // -------------------------------------------------------------------------
  // 1. Health check
  // -------------------------------------------------------------------------

  test("GET /v1/health returns 200 with status ok", async () => {
    const res = requireResponse(await handler(new Request("http://localhost/v1/health")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  // -------------------------------------------------------------------------
  // 2. Search returns results
  // -------------------------------------------------------------------------

  test("GET /v1/bricks returns search results", async () => {
    const brick = createToolBrick();
    registry.register(brick);

    const res = requireResponse(await handler(new Request("http://localhost/v1/bricks")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: readonly unknown[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Search with kind filter
  // -------------------------------------------------------------------------

  test("GET /v1/bricks with kind filter returns matching bricks", async () => {
    const toolBrick = createToolBrick();
    registry.register(toolBrick);

    // Search for skills -- should return empty
    const res = requireResponse(
      await handler(new Request("http://localhost/v1/bricks?kind=skill")),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: readonly unknown[]; total: number };
    expect(body.items).toHaveLength(0);

    // Search for tools -- should return one
    const res2 = requireResponse(
      await handler(new Request("http://localhost/v1/bricks?kind=tool")),
    );
    const body2 = (await res2.json()) as { items: readonly unknown[]; total: number };
    expect(body2.items).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 4. Get by namespace + name
  // -------------------------------------------------------------------------

  test("GET /v1/bricks/:namespace/:name returns brick", async () => {
    const brick = createToolBrick({ namespace: "@community" });
    registry.register(brick);

    const res = requireResponse(
      await handler(new Request("http://localhost/v1/bricks/@community/test-tool?kind=tool")),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("test-tool");
  });

  // -------------------------------------------------------------------------
  // 5. Get by namespace + name returns 404 for missing
  // -------------------------------------------------------------------------

  test("GET /v1/bricks/:namespace/:name returns 404 for missing brick", async () => {
    const res = requireResponse(
      await handler(new Request("http://localhost/v1/bricks/@nobody/nonexistent?kind=tool")),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  // -------------------------------------------------------------------------
  // 6. Publish requires auth token
  // -------------------------------------------------------------------------

  test("POST /v1/bricks requires auth token", async () => {
    const brick = createToolBrick();

    // No auth header
    const res1 = requireResponse(
      await handler(
        new Request("http://localhost/v1/bricks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(brick),
        }),
      ),
    );
    expect(res1.status).toBe(401);

    // Wrong token
    const res2 = requireResponse(
      await handler(
        new Request("http://localhost/v1/bricks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer wrong-token",
          },
          body: JSON.stringify(brick),
        }),
      ),
    );
    expect(res2.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 7. Publish registers brick with valid auth
  // -------------------------------------------------------------------------

  test("POST /v1/bricks registers brick with valid auth", async () => {
    const brick = createToolBrick({ name: "published-tool" });

    const res = requireResponse(
      await handler(
        new Request("http://localhost/v1/bricks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${AUTH_TOKEN}`,
          },
          body: JSON.stringify(brick),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify it was registered
    const getResult = await registry.get("tool", "published-tool");
    expect(getResult.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. Publish rejects when security gate fails
  // -------------------------------------------------------------------------

  test("POST /v1/bricks rejects when security gate blocks", async () => {
    const gate: SecurityGate = {
      check: async (_brick: BrickArtifact): Promise<SecurityGateResult> => ({
        passed: false,
        score: 10,
        findings: ["Malicious pattern detected"],
      }),
    };

    const gatedConfig: CommunityRegistryConfig = {
      ...config,
      securityGate: gate,
    };
    const gatedHandler = createCommunityRegistryHandler(gatedConfig);

    const brick = createToolBrick({ name: "malicious-tool" });
    const res = requireResponse(
      await gatedHandler.handler(
        new Request("http://localhost/v1/bricks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${AUTH_TOKEN}`,
          },
          body: JSON.stringify(brick),
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; score: number; findings: string[] };
    expect(body.error).toContain("Security gate blocked");
    expect(body.score).toBe(10);
    expect(body.findings).toContain("Malicious pattern detected");

    // Verify it was NOT registered
    const getResult = await registry.get("tool", "malicious-tool");
    expect(getResult.ok).toBe(false);

    gatedHandler.dispose();
  });

  // -------------------------------------------------------------------------
  // 8b. Publish accepts with warning when security gate score is 30-49
  // -------------------------------------------------------------------------

  test("POST /v1/bricks accepts with warnings when gate score is 30-49", async () => {
    const gate: SecurityGate = {
      check: async (_brick: BrickArtifact): Promise<SecurityGateResult> => ({
        passed: true,
        score: 40,
        findings: ["Suspicious but acceptable pattern"],
      }),
    };

    const gatedConfig: CommunityRegistryConfig = {
      ...config,
      securityGate: gate,
    };
    const gatedHandler = createCommunityRegistryHandler(gatedConfig);

    const brick = createToolBrick({ name: "warn-tool" });
    const res = requireResponse(
      await gatedHandler.handler(
        new Request("http://localhost/v1/bricks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${AUTH_TOKEN}`,
          },
          body: JSON.stringify(brick),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings).toContain("Suspicious but acceptable pattern");

    // Verify it was registered despite warnings
    const getResult = await registry.get("tool", "warn-tool");
    expect(getResult.ok).toBe(true);

    gatedHandler.dispose();
  });

  // -------------------------------------------------------------------------
  // 8c. Publish accepts cleanly when security gate score >= 50
  // -------------------------------------------------------------------------

  test("POST /v1/bricks accepts cleanly when gate score >= 50", async () => {
    const gate: SecurityGate = {
      check: async (_brick: BrickArtifact): Promise<SecurityGateResult> => ({
        passed: true,
        score: 80,
      }),
    };

    const gatedConfig: CommunityRegistryConfig = {
      ...config,
      securityGate: gate,
    };
    const gatedHandler = createCommunityRegistryHandler(gatedConfig);

    const brick = createToolBrick({ name: "clean-tool" });
    const res = requireResponse(
      await gatedHandler.handler(
        new Request("http://localhost/v1/bricks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${AUTH_TOKEN}`,
          },
          body: JSON.stringify(brick),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; warnings?: string[] };
    expect(body.ok).toBe(true);
    expect(body.warnings).toBeUndefined();

    gatedHandler.dispose();
  });

  // -------------------------------------------------------------------------
  // 9. Batch check returns availability
  // -------------------------------------------------------------------------

  test("POST /v1/batch-check returns availability", async () => {
    const brick = createToolBrick({
      provenance: { ...TEST_PROVENANCE, contentHash: "known-hash-123" },
    });
    registry.register(brick);

    const res = requireResponse(
      await handler(
        new Request("http://localhost/v1/batch-check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hashes: ["known-hash-123", "unknown-hash-999"] }),
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updates: readonly { hash: string; available: boolean }[];
    };
    expect(body.updates).toHaveLength(2);

    const known = body.updates.find((u) => u.hash === "known-hash-123");
    const unknownEntry = body.updates.find((u) => u.hash === "unknown-hash-999");
    expect(known?.available).toBe(true);
    expect(unknownEntry?.available).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 10. Unknown routes return null
  // -------------------------------------------------------------------------

  test("unknown routes return null", async () => {
    const res1 = await handler(new Request("http://localhost/v1/unknown"));
    expect(res1).toBeNull();

    const res2 = await handler(new Request("http://localhost/other/path"));
    expect(res2).toBeNull();

    const res3 = await handler(new Request("http://localhost/v1/bricks", { method: "DELETE" }));
    expect(res3).toBeNull();
  });
});
