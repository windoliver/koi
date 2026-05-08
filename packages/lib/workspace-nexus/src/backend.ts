import type {
  AgentId,
  ResolvedWorkspaceConfig,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { createNexusWorkspaceBackendClient } from "./client.js";
import type { NexusWorkspaceBackendConfig, NexusWorkspaceRecord } from "./types.js";

const DEFAULT_PREFIX = "workspace";

function workspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

function mapWorkspace(record: NexusWorkspaceRecord): WorkspaceInfo {
  return {
    id: workspaceId(record.id),
    path: record.path,
    createdAt: record.createdAt,
    metadata: record.metadata,
  };
}

export async function createNexusWorkspaceBackend(
  config: NexusWorkspaceBackendConfig,
): Promise<WorkspaceBackend> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;

  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) {
      return config.fallback;
    }
  }

  const client = createNexusWorkspaceBackendClient(config.transport, prefix);
  let degraded = false;

  // Optional hooks are only exposed when both modes can honor them. Callers
  // (e.g. the workspace provider) treat method presence as a capability
  // signal; advertising a hook that throws once we degrade because the
  // fallback can't satisfy it would be a contract break that turns
  // recoverable flows into runtime failures during crash recovery. Policy:
  //   - No fallback configured → expose every hook (Nexus is sole authority).
  //   - Fallback configured AND fallback implements the hook → expose it.
  //   - Fallback configured AND fallback lacks the hook → omit it.
  const fallbackHas = (
    key: keyof Pick<
      WorkspaceBackend,
      | "findByAgentId"
      | "attestSetupComplete"
      | "verifySetupComplete"
      | "invalidateSetupComplete"
      | "exists"
    >,
  ): boolean => config.fallback === undefined || config.fallback[key] !== undefined;

  return {
    name: "workspace-nexus",
    isSandboxed: false,
    create: async (agentId: AgentId, resolved: ResolvedWorkspaceConfig) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.create(agentId, resolved);
      }
      const result = await client.create(agentId, resolved);
      if (!result.ok) {
        if (config.fallback === undefined) return result;
        degraded = true;
        return config.fallback.create(agentId, resolved);
      }
      return {
        ok: true,
        value: mapWorkspace(result.value.workspace),
      };
    },
    dispose: async (wsId: WorkspaceId) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.dispose(wsId);
      }
      const result = await client.dispose(wsId);
      if (!result.ok) {
        if (config.fallback === undefined) return result;
        degraded = true;
        return config.fallback.dispose(wsId);
      }
      return result;
    },
    isHealthy: async (wsId: WorkspaceId) => {
      if (degraded && config.fallback !== undefined) {
        return config.fallback.isHealthy(wsId);
      }
      const result = await client.health(wsId);
      if (!result.ok) {
        if (config.fallback === undefined) return false;
        degraded = true;
        return config.fallback.isHealthy(wsId);
      }
      return result.value.healthy;
    },
    ...(fallbackHas("findByAgentId")
      ? {
          findByAgentId: async (agentId: AgentId): Promise<readonly WorkspaceInfo[]> => {
            // Fallback discovery is only authoritative once a lifecycle op has
            // pinned ownership to it. A first read failure must NOT auto-route
            // to fallback: the fallback only knows its own inventory, so an
            // empty answer for a Nexus-owned workspace would let the provider
            // create a duplicate while the original is still live.
            if (degraded && config.fallback?.findByAgentId !== undefined) {
              const fallbackRecords = (await config.fallback.findByAgentId(agentId)) ?? [];
              return [...fallbackRecords].sort((a, b) => b.createdAt - a.createdAt);
            }
            const result = await client.findByAgentId(agentId);
            if (result.ok) {
              return result.value.map(mapWorkspace).toSorted((a, b) => b.createdAt - a.createdAt);
            }
            throw new Error(
              `Workspace backend failed to find workspaces for agent ${String(agentId)}`,
              { cause: result.error },
            );
          },
        }
      : {}),
    ...(fallbackHas("attestSetupComplete")
      ? {
          attestSetupComplete: async (wsId: WorkspaceId): Promise<void> => {
            if (degraded && config.fallback?.attestSetupComplete !== undefined) {
              await config.fallback.attestSetupComplete(wsId);
              return;
            }
            const result = await client.attestSetupComplete(wsId);
            if (result.ok) return;
            throw new Error(`Workspace backend failed to attest setup completion for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
    ...(fallbackHas("invalidateSetupComplete")
      ? {
          invalidateSetupComplete: async (wsId: WorkspaceId): Promise<void> => {
            if (degraded && config.fallback?.invalidateSetupComplete !== undefined) {
              await config.fallback.invalidateSetupComplete(wsId);
              return;
            }
            const result = await client.invalidateSetupComplete(wsId);
            if (result.ok) return;
            throw new Error(`Workspace backend failed to invalidate setup completion for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
    ...(fallbackHas("verifySetupComplete")
      ? {
          verifySetupComplete: async (wsId: WorkspaceId): Promise<boolean> => {
            // Authoritative read: a first Nexus read failure must not return
            // a fallback "false" for a Nexus-owned workspace — that would
            // trick the provider into disposing or recreating a still-live
            // workspace. Only consult fallback once ownership is pinned.
            if (degraded && config.fallback?.verifySetupComplete !== undefined) {
              return (await config.fallback.verifySetupComplete(wsId)) ?? false;
            }
            const result = await client.verifySetupComplete(wsId);
            if (result.ok) return result.value;
            throw new Error(`Workspace backend failed to verify setup completion for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
    ...(fallbackHas("exists")
      ? {
          exists: async (wsId: WorkspaceId): Promise<boolean> => {
            // Same fail-closed policy as `verifySetupComplete`.
            if (degraded && config.fallback?.exists !== undefined) {
              return (await config.fallback.exists(wsId)) ?? false;
            }
            const result = await client.exists(wsId);
            if (result.ok) return result.value;
            throw new Error(`Workspace backend failed to check existence for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
  };
}
