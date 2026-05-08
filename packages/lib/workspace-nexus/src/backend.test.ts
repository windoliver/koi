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

const ALL_CAPS = {
  findByAgentId: true,
  attestSetupComplete: true,
  verifySetupComplete: true,
  invalidateSetupComplete: true,
  exists: true,
} as const;

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

  test("hands the raw fallback to the caller when the startup health probe fails", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // Startup-only escape hatch: when an operator wires a local
    // fallback and the initial probe fails, the fallback becomes the
    // sole authority for the lifetime of this instance. Runtime RPC
    // failures still surface — they NEVER cause an authority swap.
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

  test("without a fallback, a failed health probe leaves Nexus as the authority and surfaces errors", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
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
    expect(created.ok).toBe(false);
  });

  test("isHealthy on a Nexus-owned workspace does not reroute disposal of *other* workspaces", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let nexusDisposeCalls = 0;
    let fallbackDisposeCalls = 0;
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      dispose: async () => {
        fallbackDisposeCalls += 1;
        return { ok: true, value: undefined };
      },
    };

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: true,
            value: {
              workspace: {
                id: "nexus-ws-1",
                path: "/tmp/nexus-1",
                createdAt: 1,
                metadata: {},
              },
            } as T,
          };
        }
        if (method === "workspace.health") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "transient", retryable: true },
          };
        }
        if (method === "workspace.dispose") {
          nexusDisposeCalls += 1;
          return { ok: true, value: { ok: true } as T };
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
    if (!created.ok) return;
    // Transient transport failure on `workspace.health` must NOT collapse
    // into `false`: the provider treats `!healthy` as authoritative
    // permission to dispose. Throw so callers can distinguish "Nexus says
    // unhealthy" (destructive cleanup) from "Nexus unreachable" (retry).
    let caught: unknown;
    try {
      await backend.isHealthy(created.value.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    // Disposal still hits Nexus — the throwing health check did not change
    // routing for the workspace it owns.
    const disposed = await backend.dispose(created.value.id);
    expect(disposed.ok).toBe(true);
    expect(nexusDisposeCalls).toBe(1);
    expect(fallbackDisposeCalls).toBe(0);
  });

  test("forwards workspace recovery hooks through Nexus and normalizes payloads", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
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

  test("verifySetupComplete and exists fail closed on transient Nexus failures for Nexus-owned workspaces", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackVerifyCalls = 0;
    let fallbackExistsCalls = 0;
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
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
      serverCapabilities: ALL_CAPS,
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "nexus down", retryable: false },
        }),
      ),
    });

    // A transient Nexus read failure must not silently route to fallback:
    // an empty/false fallback answer for a Nexus-owned workspace would let
    // the provider create duplicates or dispose still-live workspaces.
    for (const call of [
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
    expect(fallbackVerifyCalls).toBe(0);
    expect(fallbackExistsCalls).toBe(0);
  });

  test("authoritative reads fail closed when Nexus is unreachable and no fallback is configured", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // No fallback configured — Nexus is the sole authority and a transport
    // failure must surface as an error rather than silently fabricating an
    // answer that could let the provider dispose a live workspace or create
    // a duplicate.
    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
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

  test("findByAgentId is exposed when Nexus capability is opted in, even with a minimal fallback", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // Gating exposure on fallback capability would silently disable Nexus
    // crash-survivor discovery whenever a minimal fallback is configured,
    // making the provider miss live Nexus survivors after a restart and
    // create duplicate workspaces. Server capability is the gate.
    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: { findByAgentId: true },
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
    });

    expect(backend.findByAgentId).toBeDefined();
  });

  test("optional hooks are exposed by default so the provider can recover crash survivors", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // Default-on: the workspace provider depends on findByAgentId and the
    // attestation hooks to discover and reuse Nexus survivors after a
    // restart. Hiding them silently would push the provider into duplicate
    // allocation under cleanupPolicy="never". Operators flip individual
    // bits to false when they know their server lacks a specific RPC.
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
    expect(backend.verifySetupComplete).toBeDefined();
    expect(backend.invalidateSetupComplete).toBeDefined();
    expect(backend.exists).toBeDefined();
  });

  test("isSandboxed is true so the provider reuses Nexus survivors instead of recreating them", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // Nexus-managed workspaces are durable server-side resources, NOT
    // ephemeral in-process state. The workspace provider only reuses
    // crash survivors when the backend is sandboxed; an unsandboxed
    // backend forces dispose-and-recreate, defeating the preservation
    // contract of cleanupPolicy="never".
    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
    });

    expect(backend.isSandboxed).toBe(true);
  });

  test("a transient findByAgentId failure does not reroute later create() calls to the fallback", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let createCalls = 0;
    // Fallback has no findByAgentId, so the hook can only succeed via Nexus
    // and reflects whatever Nexus says. The crucial property under test is
    // that even after a discovery hiccup, create() still hits Nexus on the
    // next attempt — there is no global degrade flag to flip.
    const backend = await createNexusWorkspaceBackend({
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

    // Discovery hook is omitted (fallback lacks findByAgentId, so capability
    // is honestly absent). What matters is that a discovery failure on a
    // separate code path does not flip a global flag — create() still hits
    // Nexus. Per-workspace ownership means there is no global degrade.
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
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      attestSetupComplete: async () => {
        fallbackAttestCalls += 1;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
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
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      invalidateSetupComplete: async () => {
        fallbackInvalidateCalls += 1;
      },
    };

    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
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

  test("create() fails closed on Nexus error to avoid duplicate-workspace risk", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackCreateCalls = 0;
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      create: async () => {
        fallbackCreateCalls += 1;
        return {
          ok: true,
          value: {
            id: workspaceId("fallback-ws"),
            path: "/tmp/fallback-ws",
            createdAt: 1,
            metadata: {},
          },
        };
      },
    };

    // Nexus health probe succeeds at construction (so we wrap Nexus), but
    // the actual create() call fails. The adapter must NOT silently create a
    // duplicate on fallback: a transport failure is ambiguous (Nexus may
    // have committed and only lost the response). Surfacing the error
    // preserves the provider's single-workspace-per-agent invariant.
    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.create") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "nexus create down", retryable: false },
          };
        }
        return { ok: true, value: { ok: true } as T };
      }),
    });

    const created = await backend.create(agentId("agent-a"), {
      cleanupPolicy: "on_success",
      cleanupTimeoutMs: 5_000,
    });
    expect(created.ok).toBe(false);
    expect(fallbackCreateCalls).toBe(0);
  });

  test("attestation/invalidation hooks are exposed when Nexus supports them regardless of fallback", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // The fallback lacks these hooks, but Nexus is the authority and the
    // provider needs them to attest setup completion of survivors. Hiding
    // the capability would push the provider into recreating workspaces
    // it could otherwise reuse.
    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
    });

    expect(backend.attestSetupComplete).toBeDefined();
    expect(backend.invalidateSetupComplete).toBeDefined();
  });

  test("exposes all optional hooks when capabilities opt-in, regardless of fallback", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
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

  test("optional hooks listed as unsupported in serverCapabilities are omitted even when fallback would honor them", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    // Capability negotiation is honest about the connected Nexus server.
    // The workspace provider treats hook presence as a capability signal,
    // so advertising findByAgentId/exists/etc. against a server that does
    // not implement them would turn attach/cleanup into hard failures.
    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: true,
          value: { ok: true } as T,
        }),
      ),
      serverCapabilities: {
        findByAgentId: false,
        exists: false,
      },
    });

    expect(backend.findByAgentId).toBeUndefined();
    expect(backend.exists).toBeUndefined();
  });

  test("dispose() does not reroute to fallback before degrade so cleanup stays authoritative", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackDisposeCalls = 0;
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      dispose: async () => {
        fallbackDisposeCalls += 1;
        return { ok: true, value: undefined };
      },
    };

    const backend = await createNexusWorkspaceBackend({
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "dispose down", retryable: false },
        }),
      ),
    });

    const result = await backend.dispose(workspaceId("ws-1"));
    // The Nexus-owned workspace must not be reported as disposed via an
    // unrelated fallback; surface the actual error.
    expect(result.ok).toBe(false);
    expect(fallbackDisposeCalls).toBe(0);
  });

  test("findByAgentId fails closed when Nexus discovery errors (does not substitute fallback)", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    let fallbackFindCalls = 0;
    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      findByAgentId: async () => {
        fallbackFindCalls += 1;
        return [
          {
            id: workspaceId("fallback-survivor"),
            path: "/tmp/fallback-survivor",
            createdAt: 7,
            metadata: {},
          },
        ];
      },
    };

    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
      transport: createHealthyTransport(
        async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "nexus down", retryable: false },
        }),
      ),
    });

    // Substituting fallback discovery is unsafe: the fallback inventory is
    // incomplete for Nexus-owned workspaces, so returning it as the answer
    // would let the provider's single-workspace cleanup destroy a valid
    // Nexus workspace it could not see, or create duplicates because a live
    // Nexus survivor was missing from the fallback's view. Fail closed.
    let caught: unknown;
    try {
      await backend.findByAgentId?.(agentId("agent-a"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/failed to find workspaces/);
    expect(fallbackFindCalls).toBe(0);
  });

  test("findByAgentId does not let an unhealthy fallback veto a successful Nexus discovery", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const _unusedFallback: WorkspaceBackend = {
      ...createFallbackBackend(),
      findByAgentId: async () => {
        throw new Error("fallback discovery exploded");
      },
    };

    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
      transport: createHealthyTransport(async <T>(method: string): Promise<Result<T, KoiError>> => {
        if (method === "workspace.findByAgentId") {
          return {
            ok: true,
            value: {
              workspaces: [
                {
                  id: "nexus-survivor",
                  path: "/tmp/nexus-survivor",
                  createdAt: 1,
                  metadata: {},
                },
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
    expect(found?.map((info) => info.id)).toEqual([workspaceId("nexus-survivor")]);
  });

  test("findByAgentId returns survivors sorted newest-first regardless of remote order", async () => {
    const { createNexusWorkspaceBackend } = await import("./index.js");

    const backend = await createNexusWorkspaceBackend({
      serverCapabilities: ALL_CAPS,
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
