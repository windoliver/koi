import { describe, expect, test } from "bun:test";
import type { KoiError, Result, WorkspaceBackend } from "../../../kernel/core/src/index.ts";
import type { AgentId, WorkspaceId } from "../../../kernel/core/src/index.ts";
import type { NexusTransport } from "../../../lib/nexus-client/src/index.ts";

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
        return { ok: false, error: { code: "EXTERNAL", message: `unexpected ${method}`, retryable: false } };
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
      transport: createHealthyTransport(async <T>(
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
      }),
    });

    const found = await backend.findByAgentId?.(agentId("agent-a"));
    expect(found).toHaveLength(2);
    expect(found?.[0]?.id).toBe(workspaceId("ws-1"));
    expect(found?.[0]?.metadata.source).toBe("nexus");

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

  test("recovery hooks use the fallback backend after a Nexus transport failure", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackFindCalls = 0;
    let fallbackAttestCalls = 0;
    let fallbackVerifyCalls = 0;
    let fallbackInvalidateCalls = 0;
    let fallbackExistsCalls = 0;
    let transportCalls = 0;

    const fallback: WorkspaceBackend = {
      name: "fallback-hooks",
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
      findByAgentId: async () => {
        fallbackFindCalls += 1;
        return [
          {
            id: workspaceId("fallback-ws"),
            path: "/tmp/fallback-ws",
            createdAt: 1,
            metadata: { recovered: "true" },
          },
        ];
      },
      attestSetupComplete: async () => {
        fallbackAttestCalls += 1;
      },
      verifySetupComplete: async () => {
        fallbackVerifyCalls += 1;
        return true;
      },
      invalidateSetupComplete: async () => {
        fallbackInvalidateCalls += 1;
      },
      exists: async () => {
        fallbackExistsCalls += 1;
        return true;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      fallback,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        transportCalls += 1;
        if (method === "workspace.findByAgentId") {
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: "lookup down",
              retryable: false,
            },
          };
        }
        return {
          ok: true,
          value: method === "workspace.exists"
            ? ({ exists: false } as T)
            : (method === "workspace.verifySetupComplete"
              ? ({ setupComplete: false } as T)
              : ({ ok: true } as T)),
        };
      }),
    });

    const found = await backend.findByAgentId?.(agentId("agent-a"));
    expect(found).toHaveLength(1);
    expect(found?.[0]?.id).toBe(workspaceId("fallback-ws"));

    await backend.attestSetupComplete?.(workspaceId("fallback-ws"));
    expect(await backend.verifySetupComplete?.(workspaceId("fallback-ws"))).toBe(true);
    await backend.invalidateSetupComplete?.(workspaceId("fallback-ws"));
    expect(await backend.exists?.(workspaceId("fallback-ws"))).toBe(true);

    expect(transportCalls).toBe(1);
    expect(fallbackFindCalls).toBe(1);
    expect(fallbackAttestCalls).toBe(1);
    expect(fallbackVerifyCalls).toBe(1);
    expect(fallbackInvalidateCalls).toBe(1);
    expect(fallbackExistsCalls).toBe(1);
  });
});
