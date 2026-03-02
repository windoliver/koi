/**
 * Contract test suite for WorkspaceBackend implementations.
 *
 * Validates that any backend implementation satisfies the WorkspaceBackend
 * contract defined in @koi/core. Use this in backend-specific test files
 * to ensure behavioral consistency across git, docker, nexus, etc.
 */

import { describe, expect, it } from "bun:test";
import type { WorkspaceBackend } from "@koi/core";
import { agentId, workspaceId } from "@koi/core";

const DEFAULT_CONFIG = {
  cleanupPolicy: "on_success" as const,
  cleanupTimeoutMs: 5_000,
};

const AGENT = agentId("contract-test-agent");

/**
 * Run the standard WorkspaceBackend contract tests.
 *
 * @param createBackend - Factory that returns a fresh backend for each test.
 */
export function runWorkspaceBackendContractTests(
  createBackend: () => WorkspaceBackend | Promise<WorkspaceBackend>,
): void {
  describe("WorkspaceBackend contract", () => {
    it("create returns valid WorkspaceInfo with correct types", async () => {
      const backend = await createBackend();
      const result = await backend.create(AGENT, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ws = result.value;
      expect(typeof ws.id).toBe("string");
      expect(ws.id.length).toBeGreaterThan(0);
      expect(typeof ws.path).toBe("string");
      expect(ws.path.length).toBeGreaterThan(0);
      expect(typeof ws.createdAt).toBe("number");
      expect(ws.createdAt).toBeGreaterThan(0);
      expect(ws.metadata).toBeDefined();
      expect(typeof ws.metadata).toBe("object");

      // Cleanup
      await backend.dispose(ws.id);
    });

    it("create returns unique IDs for different agentIds", async () => {
      const backend = await createBackend();
      const agent2 = agentId("contract-test-agent-2");
      const result1 = await backend.create(AGENT, DEFAULT_CONFIG);
      const result2 = await backend.create(agent2, DEFAULT_CONFIG);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value.id).not.toBe(result2.value.id);

      // Cleanup
      await backend.dispose(result1.value.id);
      await backend.dispose(result2.value.id);
    });

    it("dispose succeeds for existing workspace", async () => {
      const backend = await createBackend();
      const createResult = await backend.create(AGENT, DEFAULT_CONFIG);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const disposeResult = await backend.dispose(createResult.value.id);
      expect(disposeResult.ok).toBe(true);
    });

    it("dispose on already-disposed workspace is idempotent or returns NOT_FOUND", async () => {
      const backend = await createBackend();
      const createResult = await backend.create(AGENT, DEFAULT_CONFIG);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const firstDispose = await backend.dispose(createResult.value.id);
      expect(firstDispose.ok).toBe(true);

      // Second dispose: either succeeds (idempotent) or returns NOT_FOUND
      const secondDispose = await backend.dispose(createResult.value.id);
      if (!secondDispose.ok) {
        expect(secondDispose.error.code).toBe("NOT_FOUND");
      }
    });

    it("isHealthy returns true after create", async () => {
      const backend = await createBackend();
      const result = await backend.create(AGENT, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const healthy = await backend.isHealthy(result.value.id);
      expect(healthy).toBe(true);

      // Cleanup
      await backend.dispose(result.value.id);
    });

    it("isHealthy returns false after dispose", async () => {
      const backend = await createBackend();
      const result = await backend.create(AGENT, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await backend.dispose(result.value.id);
      const healthy = await backend.isHealthy(result.value.id);
      expect(healthy).toBe(false);
    });

    it("isHealthy returns false for nonexistent workspace", async () => {
      const backend = await createBackend();
      const healthy = await backend.isHealthy(workspaceId("nonexistent-ws-id"));
      expect(healthy).toBe(false);
    });
  });
}
