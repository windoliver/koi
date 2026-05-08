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

  // Up-front health probe is the ONLY failover boundary. If Nexus is down at
  // construction time and a fallback is configured, we hand the caller the
  // raw fallback backend — that backend is then the sole authority for every
  // workspace it manages, with no Nexus involvement and no ownership
  // ambiguity. Once we return the Nexus-routed backend below, every
  // subsequent op goes to Nexus: per-call create-time failover would risk
  // double-creating a workspace (Nexus committed but lost the response →
  // fallback also creates) and would let a fallback's incomplete inventory
  // hide live Nexus workspaces from discovery and cleanup.
  if (config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok && config.fallback !== undefined) {
      return config.fallback;
    }
  }

  const client = createNexusWorkspaceBackendClient(config.transport, prefix);

  // Optional hooks are exposed only when BOTH the connected Nexus server is
  // known to implement them AND any configured fallback can also honor them.
  // Callers (e.g. the workspace provider) treat method presence as a
  // capability signal — advertising a hook the server cannot answer would
  // turn attach/cleanup into a hard failure against an older or partially
  // upgraded Nexus server, while advertising one a fallback cannot honor
  // would break recovery flows after the up-front health-probe degrade.
  // Policy:
  //   - serverCapabilities omitted → assume a fully-upgraded server.
  //   - Hook listed as `false` (or absent) in serverCapabilities → omit.
  //   - Fallback configured AND lacks the hook → omit.
  type OptionalHook =
    | "findByAgentId"
    | "attestSetupComplete"
    | "verifySetupComplete"
    | "invalidateSetupComplete"
    | "exists";
  const serverSupports = (key: OptionalHook): boolean => {
    if (config.serverCapabilities === undefined) return true;
    return config.serverCapabilities[key] === true;
  };
  const fallbackHas = (key: OptionalHook): boolean =>
    config.fallback === undefined || config.fallback[key] !== undefined;
  const exposeHook = (key: OptionalHook): boolean => serverSupports(key) && fallbackHas(key);

  return {
    name: "workspace-nexus",
    isSandboxed: false,
    create: async (agentId: AgentId, resolved: ResolvedWorkspaceConfig) => {
      // create() does NOT fall back on a Nexus error: a transport failure is
      // ambiguous (Nexus may have committed the workspace and only lost the
      // response). Creating a second workspace on fallback in that case
      // would violate the provider's single-workspace-per-agent invariant
      // and leave one live workspace untracked.
      const result = await client.create(agentId, resolved);
      if (result.ok) return { ok: true, value: mapWorkspace(result.value.workspace) };
      return result;
    },
    dispose: async (wsId: WorkspaceId) => client.dispose(wsId),
    isHealthy: async (wsId: WorkspaceId) => {
      const result = await client.health(wsId);
      if (result.ok) return result.value.healthy;
      return false;
    },
    ...(exposeHook("findByAgentId")
      ? {
          findByAgentId: async (agentId: AgentId): Promise<readonly WorkspaceInfo[]> => {
            // Nexus is the sole discovery authority. We do NOT substitute
            // fallback survivors when Nexus errors: an unsandboxed
            // fallback's inventory is incomplete for Nexus-owned workspaces,
            // so returning it as the answer would let the provider's
            // single-workspace cleanup destroy a valid Nexus workspace it
            // could not see, or create duplicates because a live Nexus
            // survivor was missing from the fallback's view. Fail closed.
            const nexusResult = await client.findByAgentId(agentId);
            if (nexusResult.ok) {
              return [...nexusResult.value.map(mapWorkspace)].sort(
                (a, b) => b.createdAt - a.createdAt,
              );
            }
            throw new Error(
              `Workspace backend failed to find workspaces for agent ${String(agentId)}`,
              { cause: nexusResult.error },
            );
          },
        }
      : {}),
    ...(exposeHook("attestSetupComplete")
      ? {
          attestSetupComplete: async (wsId: WorkspaceId): Promise<void> => {
            const result = await client.attestSetupComplete(wsId);
            if (result.ok) return;
            throw new Error(`Workspace backend failed to attest setup completion for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
    ...(exposeHook("invalidateSetupComplete")
      ? {
          invalidateSetupComplete: async (wsId: WorkspaceId): Promise<void> => {
            const result = await client.invalidateSetupComplete(wsId);
            if (result.ok) return;
            throw new Error(`Workspace backend failed to invalidate setup completion for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
    ...(exposeHook("verifySetupComplete")
      ? {
          verifySetupComplete: async (wsId: WorkspaceId): Promise<boolean> => {
            const result = await client.verifySetupComplete(wsId);
            if (result.ok) return result.value;
            throw new Error(`Workspace backend failed to verify setup completion for ${wsId}`, {
              cause: result.error,
            });
          },
        }
      : {}),
    ...(exposeHook("exists")
      ? {
          exists: async (wsId: WorkspaceId): Promise<boolean> => {
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
