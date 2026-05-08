import type {
  AgentId,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
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

  async function callOrFallback<T>(
    clientCall: () => Promise<Result<T, KoiError>>,
    fallbackCall: () => Promise<T>,
    failureMessage: string,
  ): Promise<T> {
    if (degraded && config.fallback !== undefined) {
      return fallbackCall();
    }
    const result = await clientCall();
    if (result.ok) return result.value;
    if (config.fallback === undefined) {
      throw new Error(failureMessage, { cause: result.error });
    }
    degraded = true;
    return fallbackCall();
  }

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
    findByAgentId: async (agentId: AgentId) =>
      callOrFallback(
        () => client.findByAgentId(agentId),
        async () => config.fallback?.findByAgentId?.(agentId) ?? [],
        `Workspace backend failed to find workspaces for agent ${String(agentId)}`,
      ).then((records) => records.map(mapWorkspace)),
    attestSetupComplete: async (wsId: WorkspaceId) =>
      callOrFallback(
        () => client.attestSetupComplete(wsId),
        async () => {
          await config.fallback?.attestSetupComplete?.(wsId);
          return undefined;
        },
        `Workspace backend failed to attest setup completion for ${wsId}`,
      ),
    verifySetupComplete: async (wsId: WorkspaceId) =>
      callOrFallback(
        () => client.verifySetupComplete(wsId),
        async () => config.fallback?.verifySetupComplete?.(wsId) ?? false,
        `Workspace backend failed to verify setup completion for ${wsId}`,
      ),
    invalidateSetupComplete: async (wsId: WorkspaceId) =>
      callOrFallback(
        () => client.invalidateSetupComplete(wsId),
        async () => {
          await config.fallback?.invalidateSetupComplete?.(wsId);
          return undefined;
        },
        `Workspace backend failed to invalidate setup completion for ${wsId}`,
      ),
    exists: async (wsId: WorkspaceId) =>
      callOrFallback(
        () => client.exists(wsId),
        async () => config.fallback?.exists?.(wsId) ?? false,
        `Workspace backend failed to check existence for ${wsId}`,
      ),
  };
}
