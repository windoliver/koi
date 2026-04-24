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

  async function tryDispose(wsId: WorkspaceId): Promise<boolean> {
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    const disposeResult = await Promise.race([
      config.backend.dispose(wsId).then((r) => {
        // NOT_FOUND means workspace already gone — treat as idempotent success
        if (!r.ok && r.error.code === "NOT_FOUND") return true;
        return r.ok;
      }),
      timeout,
    ]);
    return disposeResult;
  }

  function shouldDispose(agent: Agent): boolean {
    if (policy === "never") return false;
    if (policy === "always") return true;
    // on_success: only dispose if agent terminated successfully
    return agent.terminationOutcome === "success";
  }

  return {
    name: "workspace",

    async attach(agent: Agent): Promise<AttachResult> {
      const agentId = agent.pid.id;

      // Dispose any stale workspace from a previous attach (e.g. after a crash
      // and re-attach without an intervening detach).
      const staleWsId = attached.get(agentId);
      if (staleWsId !== undefined) {
        await tryDispose(staleWsId);
        attached.delete(agentId);
      }

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
        try {
          await config.postCreate(ws);
        } catch (e: unknown) {
          // Best-effort cleanup to avoid orphaned worktree/branch on postCreate failure
          await config.backend.dispose(ws.id).catch(() => undefined);
          throw e;
        }
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

      if (!shouldDispose(agent)) {
        attached.delete(agentId);
        return;
      }

      // Only remove from tracking after confirmed successful disposal.
      // On failure or timeout, workspace remains in `attached` for retry or manual recovery.
      const disposed = await tryDispose(wsId);
      if (disposed) {
        attached.delete(agentId);
      }
    },
  };
}
