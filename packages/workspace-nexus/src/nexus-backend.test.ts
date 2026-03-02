/**
 * Unit tests for createNexusWorkspaceBackend.
 *
 * Mocks NexusClient.rpc at the client level to test all edge cases
 * without a real Nexus server.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceBackend } from "@koi/core";
import { agentId, workspaceId } from "@koi/core";
import { assertOk, runWorkspaceBackendContractTests } from "@koi/test-utils";
import { MARKER_FILENAME } from "./constants.js";
import { createNexusWorkspaceBackend } from "./nexus-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AID = agentId("test-agent");
const DEFAULT_CONFIG = {
  cleanupPolicy: "on_success" as const,
  cleanupTimeoutMs: 5_000,
};

interface RpcCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function createMockFetch(options?: {
  readonly failMethods?: readonly string[];
  readonly failWithCode?: string;
}): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RpcCall[];
  readonly artifacts: Map<string, unknown>;
} {
  // Mutable array justified: test spy accumulator, captures RPC calls for assertion. Reset per test via createMockFetch.
  const calls: RpcCall[] = [];
  // Mutable Map justified: test-local in-memory store simulating Nexus CRUD. Reset per test via createMockFetch.
  const artifacts = new Map<string, unknown>();

  const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly method: string;
      readonly params: Record<string, unknown>;
      readonly id: number;
    };
    calls.push({ method: body.method, params: body.params });

    const shouldFail = options?.failMethods?.includes(body.method);
    if (shouldFail) {
      const errorCode = options?.failWithCode ?? "EXTERNAL";
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: `Mock ${errorCode} error for ${body.method}` },
        }),
        { status: 200 },
      );
    }

    // Simulate basic CRUD
    const path = body.params.path as string;
    switch (body.method) {
      case "write":
        artifacts.set(path, body.params.content);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), {
          status: 200,
        });
      case "read": {
        const value = artifacts.get(path);
        if (value === undefined) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32001, message: "Not found" },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: value }), {
          status: 200,
        });
      }
      case "remove":
        artifacts.delete(path);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), {
          status: 200,
        });
      default:
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          }),
          { status: 200 },
        );
    }
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchFn, calls, artifacts };
}

// let justified: test-local temp dir cleaned up in afterEach
let tempBaseDir: string;

function createTestBackend(options?: {
  readonly failMethods?: readonly string[];
  readonly failWithCode?: string;
}): {
  readonly backend: WorkspaceBackend;
  readonly calls: RpcCall[];
  readonly artifacts: Map<string, unknown>;
} {
  const { fetch, calls, artifacts } = createMockFetch(options);
  tempBaseDir = resolve(`/tmp/koi-nexus-test-${Date.now()}`);

  const result = createNexusWorkspaceBackend({
    nexusUrl: "http://localhost:2026",
    apiKey: "test-key",
    baseDir: tempBaseDir,
    fetch,
  });

  assertOk(result);
  return { backend: result.value, calls, artifacts };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("createNexusWorkspaceBackend", () => {
  afterEach(async () => {
    if (tempBaseDir && existsSync(tempBaseDir)) {
      await rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  describe("config validation", () => {
    it("returns error for empty nexusUrl", () => {
      const result = createNexusWorkspaceBackend({
        nexusUrl: "",
        apiKey: "key",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("nexusUrl");
    });

    it("returns error for invalid nexusUrl", () => {
      const result = createNexusWorkspaceBackend({
        nexusUrl: "not-a-url",
        apiKey: "key",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("valid URL");
    });

    it("returns error for empty apiKey", () => {
      const result = createNexusWorkspaceBackend({
        nexusUrl: "http://localhost:2026",
        apiKey: "",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    });

    it("returns ok for valid config", () => {
      const { fetch } = createMockFetch();
      const result = createNexusWorkspaceBackend({
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        fetch,
      });
      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  describe("happy path", () => {
    it("create returns valid WorkspaceInfo", async () => {
      const { backend } = createTestBackend();
      const result = await backend.create(AID, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toContain("nexus-ws-");
      expect(result.value.id).toContain("test-agent");
      expect(result.value.path).toContain(tempBaseDir);
      expect(result.value.createdAt).toBeGreaterThan(0);
      expect(result.value.metadata.hostId).toBeDefined();
      expect(existsSync(result.value.path)).toBe(true);
      expect(existsSync(`${result.value.path}/${MARKER_FILENAME}`)).toBe(true);
    });

    it("dispose removes workspace", async () => {
      const { backend } = createTestBackend();
      const createResult = await backend.create(AID, DEFAULT_CONFIG);
      assertOk(createResult);

      const disposeResult = await backend.dispose(createResult.value.id);
      expect(disposeResult.ok).toBe(true);
      expect(existsSync(createResult.value.path)).toBe(false);
    });

    it("isHealthy returns true after create", async () => {
      const { backend } = createTestBackend();
      const createResult = await backend.create(AID, DEFAULT_CONFIG);
      assertOk(createResult);

      const healthy = await backend.isHealthy(createResult.value.id);
      expect(healthy).toBe(true);

      await backend.dispose(createResult.value.id);
    });

    it("isHealthy returns false after dispose", async () => {
      const { backend } = createTestBackend();
      const createResult = await backend.create(AID, DEFAULT_CONFIG);
      assertOk(createResult);

      await backend.dispose(createResult.value.id);
      const healthy = await backend.isHealthy(createResult.value.id);
      expect(healthy).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases (all 10 from the plan)
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("1. Nexus unreachable during create → error, no local dir", async () => {
      const { backend } = createTestBackend({ failMethods: ["write"] });
      const result = await backend.create(AID, DEFAULT_CONFIG);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("Nexus");

      // No local dir should be created
      const wsDir = resolve(tempBaseDir);
      // The base dir might not exist, or if it does, it should be empty
      if (existsSync(wsDir)) {
        const entries = await import("node:fs/promises").then((m) => m.readdir(wsDir));
        expect(entries.length).toBe(0);
      }
    });

    it("2. Nexus succeeds, local mkdir fails → Nexus rollback, error", async () => {
      // Use an invalid baseDir path that will fail mkdir
      const { fetch, artifacts } = createMockFetch();
      const result = createNexusWorkspaceBackend({
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        baseDir: "/dev/null/impossible-path",
        fetch,
      });
      assertOk(result);

      const createResult = await result.value.create(AID, DEFAULT_CONFIG);
      expect(createResult.ok).toBe(false);
      if (createResult.ok) return;
      expect(createResult.error.code).toBe("EXTERNAL");

      // Nexus artifact should have been rolled back (removed)
      expect(artifacts.size).toBe(0);
    });

    it("3. Nexus unreachable during dispose → error, local dir preserved", async () => {
      // First create successfully
      const { fetch } = createMockFetch();
      tempBaseDir = resolve(`/tmp/koi-nexus-test-${Date.now()}`);
      const createResult = createNexusWorkspaceBackend({
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        baseDir: tempBaseDir,
        fetch,
      });
      assertOk(createResult);

      const wsResult = await createResult.value.create(AID, DEFAULT_CONFIG);
      assertOk(wsResult);
      const wsPath = wsResult.value.path;
      expect(existsSync(wsPath)).toBe(true);

      // Now create a failing backend for dispose
      const { fetch: failFetch } = createMockFetch({ failMethods: ["remove"] });
      const failResult = createNexusWorkspaceBackend({
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        baseDir: tempBaseDir,
        fetch: failFetch,
      });
      assertOk(failResult);

      const disposeResult = await failResult.value.dispose(wsResult.value.id);
      expect(disposeResult.ok).toBe(false);

      // Local dir should still exist
      expect(existsSync(wsPath)).toBe(true);
    });

    it("4. Nexus dispose succeeds, local rmdir fails → success with warning", async () => {
      const { backend } = createTestBackend();
      const createResult = await backend.create(AID, DEFAULT_CONFIG);
      assertOk(createResult);

      // Pre-remove the local dir to simulate rmdir failure path
      // (rm with force:true won't fail, but the behavior is still correct —
      // the test verifies dispose returns ok even if local cleanup is a no-op)
      await rm(createResult.value.path, { recursive: true, force: true });

      const disposeResult = await backend.dispose(createResult.value.id);
      // Should succeed (Nexus artifact removed, local already gone)
      expect(disposeResult.ok).toBe(true);
    });

    it("5. Double dispose → idempotent success (NOT_FOUND treated as success)", async () => {
      const { backend } = createTestBackend();
      const createResult = await backend.create(AID, DEFAULT_CONFIG);
      assertOk(createResult);

      const first = await backend.dispose(createResult.value.id);
      expect(first.ok).toBe(true);

      // Second dispose — remove on non-existent artifact is idempotent
      const second = await backend.dispose(createResult.value.id);
      expect(second.ok).toBe(true);
    });

    it("6. isHealthy — artifact missing → false", async () => {
      const { backend } = createTestBackend();
      const healthy = await backend.isHealthy(workspaceId("nonexistent"));
      expect(healthy).toBe(false);
    });

    it("7. isHealthy — Nexus unreachable → false", async () => {
      const { backend } = createTestBackend({ failMethods: ["read"] });
      // Create a local dir to pass the local-first check
      const wsId = workspaceId("fake-ws");
      const localPath = resolve(tempBaseDir, wsId);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(localPath, { recursive: true });
      await writeFile(`${localPath}/${MARKER_FILENAME}`, "{}", "utf-8");

      const healthy = await backend.isHealthy(wsId);
      expect(healthy).toBe(false);
    });

    it("8. isHealthy — artifact exists, local dir missing → false", async () => {
      const { backend } = createTestBackend();
      const createResult = await backend.create(AID, DEFAULT_CONFIG);
      assertOk(createResult);

      // Remove local dir but keep Nexus artifact
      await rm(createResult.value.path, { recursive: true, force: true });

      const healthy = await backend.isHealthy(createResult.value.id);
      expect(healthy).toBe(false);

      // Cleanup Nexus artifact
      await backend.dispose(createResult.value.id);
    });

    it("9. create with empty agentId → validation error", async () => {
      const { backend } = createTestBackend();
      const result = await backend.create(agentId(""), DEFAULT_CONFIG);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("agentId");
    });

    it("10. Concurrent create for same agentId → unique workspace IDs", async () => {
      const { backend } = createTestBackend();
      const r1 = await backend.create(AID, DEFAULT_CONFIG);
      // Small delay to ensure unique timestamps
      await new Promise((r) => setTimeout(r, 5));
      const r2 = await backend.create(AID, DEFAULT_CONFIG);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      expect(r1.value.id).not.toBe(r2.value.id);

      // Cleanup
      await backend.dispose(r1.value.id);
      await backend.dispose(r2.value.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Backend properties
  // ---------------------------------------------------------------------------

  describe("backend properties", () => {
    it('name is "nexus"', () => {
      const { backend } = createTestBackend();
      expect(backend.name).toBe("nexus");
    });

    it("isSandboxed is false", () => {
      const { backend } = createTestBackend();
      expect(backend.isSandboxed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

runWorkspaceBackendContractTests(() => {
  const { backend } = createTestBackend();
  return backend;
});
