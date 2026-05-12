import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { describeWorkspaceConformance } from "@koi/workspace-conformance";
import { createNexusWorkspaceBackend } from "./backend.js";

interface StoredWorkspace {
  readonly id: string;
  readonly path: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly agentId: string;
  setupComplete: boolean;
}

// In-process emulator of the server-side workspace RPC handler. Backs the
// JSON-RPC method names the real Nexus exposes (workspace.create/dispose/
// health/findByAgentId/attestSetupComplete/...) with a Map keyed by
// workspaceId. Lives here (not in @koi/workspace-conformance) because the
// RPC shape is a detail of this adapter, not the contract.
function createFakeNexusServerTransport(): NexusTransport {
  const store = new Map<string, StoredWorkspace>();
  let counter = 0;

  return {
    kind: "http",
    health: async () => ({
      ok: true,
      value: { status: "ok", version: "1", latencyMs: 1, probed: ["version"] },
    }),
    close: () => {},
    call: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      if (method === "workspace.create") {
        const id = `ws-${++counter}`;
        const ws: StoredWorkspace = {
          id,
          path: `/tmp/${id}`,
          createdAt: Date.now(),
          metadata: {},
          agentId: params.agentId as string,
          setupComplete: false,
        };
        store.set(id, ws);
        return {
          ok: true,
          value: {
            workspace: {
              id,
              path: ws.path,
              createdAt: ws.createdAt,
              metadata: ws.metadata,
            },
          } as T,
        };
      }
      if (method === "workspace.dispose") {
        store.delete(params.workspaceId as string);
        return { ok: true, value: { ok: true } as T };
      }
      if (method === "workspace.health") {
        const ws = store.get(params.workspaceId as string);
        return { ok: true, value: { healthy: ws !== undefined } as T };
      }
      if (method === "workspace.findByAgentId") {
        const aid = params.agentId as string;
        const workspaces = [...store.values()]
          .filter((w) => w.agentId === aid)
          .map((w) => ({ id: w.id, path: w.path, createdAt: w.createdAt, metadata: w.metadata }));
        return { ok: true, value: { workspaces } as T };
      }
      if (method === "workspace.exists") {
        return { ok: true, value: { exists: store.has(params.workspaceId as string) } as T };
      }
      if (method === "workspace.attestSetupComplete") {
        const ws = store.get(params.workspaceId as string);
        if (ws !== undefined) ws.setupComplete = true;
        return { ok: true, value: { ok: true } as T };
      }
      if (method === "workspace.verifySetupComplete") {
        const ws = store.get(params.workspaceId as string);
        return { ok: true, value: { setupComplete: ws?.setupComplete ?? false } as T };
      }
      if (method === "workspace.invalidateSetupComplete") {
        const ws = store.get(params.workspaceId as string);
        if (ws !== undefined) ws.setupComplete = false;
        return { ok: true, value: { ok: true } as T };
      }
      return {
        ok: false,
        error: { code: "EXTERNAL", message: `unknown method ${method}`, retryable: false },
      };
    },
  };
}

describeWorkspaceConformance("createNexusWorkspaceBackend", async () => {
  // Each factory call gets a fresh fake server, so workspaces from previous
  // tests never leak. All optional capabilities are advertised so the suite
  // exercises findByAgentId / attestation hooks / exists.
  const transport = createFakeNexusServerTransport();
  const backend = await createNexusWorkspaceBackend({ transport });
  return { backend };
});
