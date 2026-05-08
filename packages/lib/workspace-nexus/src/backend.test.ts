import { describe, expect, test } from "bun:test";
import type { AgentId, KoiError, Result, WorkspaceBackend, WorkspaceId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

function createHealthyTransport(call: NexusTransport["call"]): NexusTransport {
  return {
    kind: "http",
    call,
    health: async () => ({
      ok: true,
      value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
    }),
    close: () => {},
  };
}

function agentId(id: string): AgentId {
  return id as AgentId;
}

function workspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

function createFallbackBackend(): WorkspaceBackend {
  return {
    name: "fallback",
    isSandboxed: false,
    create: async () => ({
      ok: true,
      value: {
        id: workspaceId("fallback-ws"),
        path: "/tmp/fallback-ws",
        createdAt: 1,
        metadata: {},
      },
    }),
    dispose: async () => ({ ok: true, value: undefined }),
    isHealthy: async () => true,
  };
}

describe("createNexusWorkspaceBackend", () => {
  test("creates and disposes a workspace through Nexus", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: true,
            value: {
              workspace: {
                id: "ws-1",
                path: "/tmp/ws-1",
                createdAt: 1,
                metadata: {},
              },
            } as T,
          };
        }
        if (method === "workspace.dispose") {
          return { ok: true, value: { ok: true } as T };
        }
        if (method === "workspace.health") {
          return { ok: true, value: { healthy: true } as T };
        }
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false },
        };
      }),
    });

    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.id).toBe(workspaceId("ws-1"));
      expect(await backend.isHealthy(created.value.id)).toBe(true);
      const disposed = await backend.dispose(created.value.id);
      expect(disposed.ok).toBe(true);
    }
  });

  test("uses fallback backend when health check fails", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      fallback: createFallbackBackend(),
      transport: {
        kind: "http",
        call: async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        health: async () => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        close: () => {},
      },
    });

    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.id).toBe(workspaceId("fallback-ws"));
  });

  test("degraded mode is sticky after runtime failure", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let createShouldFail = true;
    const backend = await createNexusWorkspaceBackend({
      fallback: createFallbackBackend(),
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create" && createShouldFail) {
          createShouldFail = false;
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "down", retryable: false },
          };
        }
        return {
          ok: true,
          value: {
            workspace: {
              id: "ws-ignored",
              path: "/tmp/ws-ignored",
              createdAt: 1,
              metadata: {},
            },
          } as T,
        };
      }),
    });

    const first = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.id).toBe(workspaceId("fallback-ws"));
    }

    const second = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.id).toBe(workspaceId("fallback-ws"));
    }
  });

  test("forwards workspace recovery hooks through Nexus and normalizes payloads", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(
        async <T>(
          method: string,
          params: Record<string, unknown>,
        ): Promise<Result<T, KoiError>> => {
          calls.push({ method, params });
          if (method === "workspace.findByAgentId") {
            return {
              ok: true,
              value: {
                workspaces: [
                  {
                    id: "ws-1",
                    path: "/tmp/ws-1",
                    createdAt: 1,
                    metadata: { source: "nexus" },
                  },
                  {
                    id: "ws-2",
                    path: "/tmp/ws-2",
                    createdAt: 2,
                    metadata: {},
                  },
                ],
              } as T,
            };
          }
          if (method === "workspace.attestSetupComplete") {
            return { ok: true, value: { ok: true } as T };
          }
          if (method === "workspace.verifySetupComplete") {
            return { ok: true, value: { setupComplete: true } as T };
          }
          if (method === "workspace.invalidateSetupComplete") {
            return { ok: true, value: { ok: true } as T };
          }
          if (method === "workspace.exists") {
            return { ok: true, value: { exists: false } as T };
          }
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: `unexpected ${method}`,
              retryable: false,
            },
          };
        },
      ),
    });

    const found = await backend.findByAgentId?.(agentId("agent-a"));
    expect(found).toHaveLength(2);
    // Newest-first ordering: ws-2 (createdAt=2) before ws-1 (createdAt=1).
    expect(found?.[0]?.id).toBe(workspaceId("ws-2"));
    expect(found?.[1]?.id).toBe(workspaceId("ws-1"));
    expect(found?.[1]?.metadata.source).toBe("nexus");

    await backend.attestSetupComplete?.(workspaceId("ws-1"));
    expect(await backend.verifySetupComplete?.(workspaceId("ws-1"))).toBe(true);
    await backend.invalidateSetupComplete?.(workspaceId("ws-1"));
    expect(await backend.exists?.(workspaceId("ws-1"))).toBe(false);

    expect(calls.map((entry) => entry.method)).toEqual([
      "workspace.findByAgentId",
      "workspace.attestSetupComplete",
      "workspace.verifySetupComplete",
      "workspace.invalidateSetupComplete",
      "workspace.exists",
    ]);
    expect(calls[0]?.params).toEqual({ agentId: agentId("agent-a") });
    expect(calls[1]?.params).toEqual({ workspaceId: workspaceId("ws-1") });
    expect(calls[2]?.params).toEqual({ workspaceId: workspaceId("ws-1") });
    expect(calls[3]?.params).toEqual({ workspaceId: workspaceId("ws-1") });
    expect(calls[4]?.params).toEqual({ workspaceId: workspaceId("ws-1") });
  });

  test("authoritative reads fail closed on transient Nexus failures even when the fallback implements them", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackFindCalls = 0;
    let fallbackVerifyCalls = 0;
    let fallbackExistsCalls = 0;
    const fallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      findByAgentId: async () => {
        fallbackFindCalls += 1;
        return [];
      },
      verifySetupComplete: async () => {
        fallbackVerifyCalls += 1;
        return false;
      },
      exists: async () => {
        fallbackExistsCalls += 1;
        return false;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "nexus down", retryable: false },
        }),
      ),
    });

    // While Nexus is the authority, a transient read failure must not silently
    // route to fallback: an empty/false fallback answer for a Nexus-owned
    // workspace would let the provider create duplicates or dispose still-live
    // workspaces. Read hooks only consult fallback once `degraded` has been
    // pinned by a lifecycle op (create/dispose/isHealthy).
    for (const call of [
      () => backend.findByAgentId?.(agentId("agent-a")),
      () => backend.verifySetupComplete?.(workspaceId("ws-1")),
      () => backend.exists?.(workspaceId("ws-1")),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
    }
    expect(fallbackFindCalls).toBe(0);
    expect(fallbackVerifyCalls).toBe(0);
    expect(fallbackExistsCalls).toBe(0);
  });

  test("authoritative reads use fallback once a lifecycle op has pinned ownership to it", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackVerifyCalls = 0;
    const fallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      verifySetupComplete: async () => {
        fallbackVerifyCalls += 1;
        return true;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "create down", retryable: false },
          };
        }
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `nexus down: ${method}`, retryable: false },
        };
      }),
    });

    // Pin ownership to fallback via a lifecycle op.
    await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    // Now the read hook can authoritatively use fallback state.
    expect(await backend.verifySetupComplete?.(workspaceId("fallback-ws"))).toBe(true);
    expect(fallbackVerifyCalls).toBe(1);
  });

  test("authoritative reads fail closed when Nexus is unreachable and no fallback is configured", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // No fallback configured — Nexus is the sole authority and a transport
    // failure must surface as an error rather than silently fabricating an
    // answer that could let the provider dispose a live workspace or create
    // a duplicate.
    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "nexus down", retryable: false },
        }),
      ),
    });

    for (const call of [
      () => backend.findByAgentId?.(agentId("agent-a")),
      () => backend.verifySetupComplete?.(workspaceId("ws-1")),
      () => backend.exists?.(workspaceId("ws-1")),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
    }
  });

  test("findByAgentId is omitted when the fallback cannot replicate it (capability is honest)", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // Fallback is configured but lacks findByAgentId. We do not advertise the
    // hook because callers (e.g. the workspace provider) treat method
    // presence as a capability signal — a hook that throws once we degrade
    // because the fallback can't honor it would be a contract break that
    // turns a recoverable flow into a runtime failure.
    const backend = await createNexusWorkspaceBackend({
      fallback: createFallbackBackend(),
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
    });

    expect(backend.findByAgentId).toBeUndefined();
  });

  test("a transient findByAgentId failure does not reroute later create() calls to the fallback", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let createCalls = 0;
    const fallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      findByAgentId: async () => [],
    };
    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.findByAgentId") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "lookup down", retryable: false },
          };
        }
        if (method === "workspace.create") {
          createCalls += 1;
          return {
            ok: true,
            value: {
              workspace: {
                id: `nexus-ws-${createCalls}`,
                path: `/tmp/nexus-${createCalls}`,
                createdAt: createCalls,
                metadata: {},
              },
            } as T,
          };
        }
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false },
        };
      }),
    });

    // The hook fails closed rather than fabricating a fallback survivor list.
    let caught: unknown;
    try {
      await backend.findByAgentId?.(agentId("agent-a"));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);

    // Subsequent lifecycle ops must still consult Nexus, not the fallback.
    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.id).toBe(workspaceId("nexus-ws-1"));
  });

  test("attestSetupComplete surfaces Nexus failure rather than landing only in fallback state", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackAttestCalls = 0;
    const fallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      attestSetupComplete: async () => {
        fallbackAttestCalls += 1;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "attest down", retryable: false },
        }),
      ),
    });

    let caught: unknown;
    try {
      await backend.attestSetupComplete?.(workspaceId("ws-1"));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(fallbackAttestCalls).toBe(0);
  });

  test("invalidateSetupComplete surfaces Nexus failure rather than diverging from later reads", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackInvalidateCalls = 0;
    const fallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      invalidateSetupComplete: async () => {
        fallbackInvalidateCalls += 1;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "invalidate down", retryable: false },
        }),
      ),
    });

    let caught: unknown;
    try {
      await backend.invalidateSetupComplete?.(workspaceId("ws-1"));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(fallbackInvalidateCalls).toBe(0);
  });

  test("after create() degrades, attest and verify both pin to the fallback backend", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let attestedFallback = 0;
    let verifiedFallback = 0;
    const fallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      attestSetupComplete: async () => {
        attestedFallback += 1;
      },
      verifySetupComplete: async () => {
        verifiedFallback += 1;
        return true;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "create down", retryable: false },
          };
        }
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `nexus should not be called after degrade: ${method}`,
            retryable: false,
          },
        };
      }),
    });

    // First create() fails on Nexus → backend flips to degraded, returns fallback workspace.
    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(true);

    // Both attest (write) and verify (read) must now land on fallback so setup
    // state stays internally consistent for the fallback-owned workspace.
    await backend.attestSetupComplete?.(workspaceId("fallback-ws"));
    expect(await backend.verifySetupComplete?.(workspaceId("fallback-ws"))).toBe(true);

    expect(attestedFallback).toBe(1);
    expect(verifiedFallback).toBe(1);
  });

  test("attestation/invalidation hooks are omitted when the fallback cannot replicate them", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      fallback: createFallbackBackend(),
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
    });

    expect(backend.attestSetupComplete).toBeUndefined();
    expect(backend.invalidateSetupComplete).toBeUndefined();
  });

  test("exposes optional hooks when no fallback is configured (Nexus is the sole authority)", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
    });

    expect(backend.findByAgentId).toBeDefined();
    expect(backend.attestSetupComplete).toBeDefined();
    expect(backend.invalidateSetupComplete).toBeDefined();
    expect(backend.verifySetupComplete).toBeDefined();
    expect(backend.exists).toBeDefined();
  });

  test("findByAgentId returns survivors sorted newest-first regardless of remote order", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.findByAgentId") {
          return {
            ok: true,
            value: {
              workspaces: [
                { id: "ws-old", path: "/tmp/old", createdAt: 1, metadata: {} },
                { id: "ws-new", path: "/tmp/new", createdAt: 5, metadata: {} },
                { id: "ws-mid", path: "/tmp/mid", createdAt: 3, metadata: {} },
              ],
            } as T,
          };
        }
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false },
        };
      }),
    });

    const found = await backend.findByAgentId?.(agentId("agent-a"));
    expect(found?.map((info) => info.id)).toEqual([
      workspaceId("ws-new"),
      workspaceId("ws-mid"),
      workspaceId("ws-old"),
    ]);
  });
});
