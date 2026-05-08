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

  // Nexus is always the authority. We deliberately do NOT swap to a
  // fallback on a failed startup health probe: that decision happens
  // before any workspace-specific reconciliation, so a transient or
  // narrower probe failure could hide live Nexus-owned workspaces from
  // discovery/dispose and lead the provider to allocate duplicates.
  // Operators who need a no-Nexus environment construct the local
  // backend directly.
  const client = createNexusWorkspaceBackendClient(config.transport, prefix);

  // Optional hooks default to ON because the workspace provider depends
  // on `findByAgentId` (and the attestation hooks) to recover crash
  // survivors after a restart. Hiding them by default would silently
  // disable survivor discovery and push the provider into duplicate-
  // allocation under `cleanupPolicy="never"`. Operators who know their
  // Nexus server lacks a specific RPC opt that hook OUT explicitly via
  // `serverCapabilities`. Per-call METHOD_NOT_FOUND from an older
  // server still surfaces as a typed error to the caller — better a
  // loud failure than a silent dispose-and-recreate.
  //
  //   - serverCapabilities omitted → expose all hooks.
  //   - Hook listed `false` in serverCapabilities → omit.
  //   - Hook listed `true` (or absent) → expose.
  type OptionalHook =
    | "findByAgentId"
    | "attestSetupComplete"
    | "verifySetupComplete"
    | "invalidateSetupComplete"
    | "exists";
  const exposeHook = (key: OptionalHook): boolean => config.serverCapabilities?.[key] !== false;

  return {
    name: "workspace-nexus",
    // Nexus-managed workspaces are durable, server-side resources
    // backed by their own trust boundary — they are NOT in-process
    // ephemeral state. Marking the backend sandboxed lets
    // `createWorkspaceProvider()` reuse survivors after a restart
    // instead of forcing dispose-and-recreate, which would tear down
    // the very state that `cleanupPolicy="never"` is supposed to
    // preserve.
    isSandboxed: true,
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
      // Distinguish "Nexus says unhealthy" from "transport failed" — the
      // workspace provider treats a `false` return as authoritative
      // permission to dispose the survivor, so collapsing a transient
      // transport failure into `false` would let a temporary Nexus outage
      // delete a perfectly valid workspace during crash recovery. Throw on
      // transport errors so callers can treat them as transient and skip
      // destructive cleanup until Nexus is reachable again.
      const result = await client.health(wsId);
      if (result.ok) return result.value.healthy;
      throw new Error(`Workspace backend health check failed for ${wsId}`, {
        cause: result.error,
      });
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
