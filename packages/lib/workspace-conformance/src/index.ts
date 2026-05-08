import { describe, expect, test } from "bun:test";
import type { AgentId, ResolvedWorkspaceConfig, WorkspaceBackend } from "@koi/core";
import { agentId } from "@koi/core";

export interface WorkspaceFactoryHandle {
  readonly backend: WorkspaceBackend;
  readonly cleanup?: () => Promise<void> | void;
}

/**
 * Factory for fresh, never-touched WorkspaceBackend instances.
 *
 * MUST return a brand-new backend on each call so tests don't share state.
 * `cleanup` (if returned) is invoked after each test to free filesystem
 * artifacts (temp git repos, container roots, etc.).
 */
export type WorkspaceFactory = () => Promise<WorkspaceFactoryHandle> | WorkspaceFactoryHandle;

const DEFAULT_CONFIG: ResolvedWorkspaceConfig = {
  cleanupPolicy: "always",
  cleanupTimeoutMs: 5_000,
};

/**
 * Run the shared WorkspaceBackend contract suite against `factory`.
 *
 * Both `@koi/workspace` (git worktrees) and `@koi/workspace-nexus` must pass
 * this suite — divergence is a contract bug, not a backend quirk.
 *
 * Optional methods (`findByAgentId`, `attestSetupComplete`, `exists`, ...)
 * are skipped when the backend exposes `undefined` — gating on capability,
 * not on backend identity.
 */
export function describeWorkspaceConformance(label: string, factory: WorkspaceFactory): void {
  describe(`WorkspaceBackend conformance: ${label}`, () => {
    test("declares a non-empty `name` and a boolean `isSandboxed`", async () => {
      const { backend, cleanup } = await factory();
      try {
        expect(typeof backend.name).toBe("string");
        expect(backend.name.length).toBeGreaterThan(0);
        expect(typeof backend.isSandboxed).toBe("boolean");
      } finally {
        await cleanup?.();
      }
    });

    test("create returns a workspace with id/path/createdAt/metadata", async () => {
      const { backend, cleanup } = await factory();
      const aid: AgentId = agentId("conformance-create");
      try {
        const result = await backend.create(aid, DEFAULT_CONFIG);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ws = result.value;
        expect(typeof ws.id).toBe("string");
        expect(ws.id.length).toBeGreaterThan(0);
        expect(typeof ws.path).toBe("string");
        expect(typeof ws.createdAt).toBe("number");
        expect(ws.metadata).toBeDefined();
        await backend.dispose(ws.id);
      } finally {
        await cleanup?.();
      }
    });

    test("isHealthy returns true for a freshly-created workspace", async () => {
      const { backend, cleanup } = await factory();
      const aid: AgentId = agentId("conformance-healthy");
      try {
        const created = await backend.create(aid, DEFAULT_CONFIG);
        if (!created.ok) return;
        expect(await backend.isHealthy(created.value.id)).toBe(true);
        await backend.dispose(created.value.id);
      } finally {
        await cleanup?.();
      }
    });

    test("second dispose does not throw and returns a typed Result", async () => {
      // The L0 contract does not mandate idempotency on dispose — git-worktree
      // returns NOT_FOUND on second call while a Nexus server may return ok.
      // Both are valid; the contract guarantee is only that dispose returns a
      // typed Result instead of throwing, so callers can branch on the error
      // code rather than wrapping in try/catch.
      const { backend, cleanup } = await factory();
      const aid: AgentId = agentId("conformance-dispose");
      try {
        const created = await backend.create(aid, DEFAULT_CONFIG);
        if (!created.ok) return;
        const first = await backend.dispose(created.value.id);
        expect(first.ok).toBe(true);
        const second = await backend.dispose(created.value.id);
        // Either ok (idempotent) or a typed error (NOT_FOUND-style). Must not throw.
        if (!second.ok) expect(typeof second.error.code).toBe("string");
      } finally {
        await cleanup?.();
      }
    });

    test("exists (when supported) flips to false after dispose", async () => {
      const { backend, cleanup } = await factory();
      try {
        if (backend.exists === undefined) return; // capability-gated
        const created = await backend.create(agentId("conformance-exists"), DEFAULT_CONFIG);
        if (!created.ok) return;
        expect(await backend.exists(created.value.id)).toBe(true);
        await backend.dispose(created.value.id);
        expect(await backend.exists(created.value.id)).toBe(false);
      } finally {
        await cleanup?.();
      }
    });

    test("findByAgentId (when supported) lists survivors for the same agent", async () => {
      const { backend, cleanup } = await factory();
      try {
        if (backend.findByAgentId === undefined) return; // capability-gated
        const aid = agentId("conformance-find");
        const created = await backend.create(aid, DEFAULT_CONFIG);
        if (!created.ok) return;
        const survivors = await backend.findByAgentId(aid);
        expect(survivors.some((s) => s.id === created.value.id)).toBe(true);
        await backend.dispose(created.value.id);
      } finally {
        await cleanup?.();
      }
    });

    test("attestation hooks (when supported) form a consistent triple", async () => {
      const { backend, cleanup } = await factory();
      try {
        if (
          backend.attestSetupComplete === undefined ||
          backend.verifySetupComplete === undefined ||
          backend.invalidateSetupComplete === undefined
        ) {
          return; // capability-gated; partial sets are an adapter contract violation
          // surfaced by the typed METHOD_NOT_FOUND path, not this conformance test.
        }
        const created = await backend.create(agentId("conformance-attest"), DEFAULT_CONFIG);
        if (!created.ok) return;
        expect(await backend.verifySetupComplete(created.value.id)).toBe(false);
        await backend.attestSetupComplete(created.value.id);
        expect(await backend.verifySetupComplete(created.value.id)).toBe(true);
        await backend.invalidateSetupComplete(created.value.id);
        expect(await backend.verifySetupComplete(created.value.id)).toBe(false);
        await backend.dispose(created.value.id);
      } finally {
        await cleanup?.();
      }
    });
  });
}
