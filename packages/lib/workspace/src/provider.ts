import type {
  Agent,
  AgentId,
  AttachResult,
  CleanupPolicy,
  ComponentProvider,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { DEFAULT_CLEANUP_POLICY, DEFAULT_CLEANUP_TIMEOUT_MS, WORKSPACE } from "@koi/core";

export interface WorkspaceProviderConfig {
  readonly backend: WorkspaceBackend;
  readonly cleanupPolicy?: CleanupPolicy;
  readonly cleanupTimeoutMs?: number;
  readonly postCreate?: (ws: WorkspaceInfo) => Promise<void>;
}

export function createWorkspaceProvider(config: WorkspaceProviderConfig): ComponentProvider {
  const policy = config.cleanupPolicy ?? DEFAULT_CLEANUP_POLICY;
  const timeoutMs = config.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;

  // Map agent.pid.id → workspace ID for cleanup on detach
  const attached = new Map<AgentId, WorkspaceId>();

  async function disposeWithTimeout(wsId: WorkspaceId): Promise<void> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Workspace dispose timed out")), timeoutMs),
    );
    await Promise.race([config.backend.dispose(wsId), timeout]);
  }

  return {
    name: "workspace",

    async attach(agent: Agent): Promise<AttachResult> {
      const agentId = agent.pid.id;

      const result = await config.backend.create(agentId, {
        cleanupPolicy: policy,
        cleanupTimeoutMs: timeoutMs,
      });

      if (!result.ok) {
        throw new Error(`Workspace backend failed to create workspace: ${result.error.message}`, {
          cause: result.error,
        });
      }

      const ws = result.value;

      if (config.postCreate) {
        await config.postCreate(ws);
      }

      attached.set(agentId, ws.id);

      // WORKSPACE is a SubsystemToken<WorkspaceInfo> — a branded string — use it as the map key
      const components = new Map<string, unknown>([[WORKSPACE as string, ws]]);
      return { components, skipped: [] };
    },

    async detach(agent: Agent): Promise<void> {
      const agentId = agent.pid.id;
      const wsId = attached.get(agentId);
      if (!wsId) return;

      attached.delete(agentId);

      if (policy === "never") return;

      await disposeWithTimeout(wsId).catch(() => {
        // Dispose errors are non-fatal on detach
      });
    },
  };
}
