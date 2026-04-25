import { access, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

  // Map agent.pid.id → WorkspaceInfo for cleanup/reuse on detach/attach
  const attached = new Map<AgentId, WorkspaceInfo>();
  // Tracks agents with an in-progress attach to prevent concurrent double-creation
  const inFlight = new Set<AgentId>();
  // Workspaces whose postCreate failed and cleanup also failed — must not be reused
  const setupFailed = new Set<WorkspaceId>();

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

  function makeResult(ws: WorkspaceInfo): AttachResult {
    // WORKSPACE is a SubsystemToken<WorkspaceInfo> — a branded string — use it as the map key
    const components = new Map<string, unknown>([[WORKSPACE as string, ws]]);
    return { components, skipped: [] };
  }

  // Prefer backend-level attestation (e.g. git ref) which the workspace process cannot spoof.
  // Fall back to a filesystem sibling marker only when the backend does not implement attestation
  // (acceptable for sandboxed backends where filesystem isolation is enforced at the OS level).
  function setupCompletePath(ws: WorkspaceInfo): string {
    return join(dirname(ws.path), `${ws.id}.setup-ok`);
  }

  async function markSetupComplete(ws: WorkspaceInfo): Promise<void> {
    if (config.backend.attestSetupComplete) {
      await config.backend.attestSetupComplete(ws.id);
    } else {
      await writeFile(setupCompletePath(ws), "", "utf8");
    }
  }

  async function isSetupComplete(ws: WorkspaceInfo): Promise<boolean> {
    if (config.backend.verifySetupComplete) {
      return config.backend.verifySetupComplete(ws.id);
    }
    try {
      await access(setupCompletePath(ws));
      return true;
    } catch {
      return false;
    }
  }

  return {
    name: "workspace",

    async attach(agent: Agent): Promise<AttachResult> {
      const agentId = agent.pid.id;

      // Prevent concurrent attach for the same agent — second caller gets a clear error
      // rather than silently leaking the workspace created by the first call.
      if (inFlight.has(agentId)) {
        throw new Error(`Concurrent attach for agent ${agentId} is not allowed`);
      }
      inFlight.add(agentId);

      try {
        const staleInfo = attached.get(agentId);

        // Scan for workspaces that survived a process restart (not in the in-memory map).
        let staleInfo2 = staleInfo;
        if (staleInfo2 === undefined && config.backend.findByAgentId) {
          staleInfo2 = await config.backend.findByAgentId(agentId);
        }

        // Under "never" policy: reuse the preserved workspace rather than discarding it.
        // Requires: healthy (git-validated) AND setup proved complete via out-of-worktree marker.
        // The marker is written after postCreate succeeds and lives outside the worktree so
        // agent code cannot spoof it. In-memory setupFailed catches failures within this process.
        if (staleInfo2 !== undefined && policy === "never") {
          const wsId = staleInfo2.id;
          if (!setupFailed.has(wsId)) {
            const [healthy, setupComplete] = await Promise.all([
              config.backend.isHealthy(wsId),
              isSetupComplete(staleInfo2),
            ]);
            if (healthy && setupComplete) {
              attached.set(agentId, staleInfo2);
              return makeResult(staleInfo2);
            }
          }
          setupFailed.delete(wsId);
          attached.delete(agentId);
          // Unhealthy or setup incomplete — fall through to dispose + recreate
        }

        if (staleInfo2 !== undefined) {
          const disposed = await tryDispose(staleInfo2.id);
          if (!disposed) {
            throw new Error(
              `Cannot reattach agent ${agentId}: previous workspace ${staleInfo2.id} could not be disposed`,
            );
          }
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
            // Route rollback through timeout-bounded disposal (same as normal cleanup)
            const didDispose = await tryDispose(ws.id);
            if (!didDispose) {
              // Cleanup timed out or failed — keep tracking for retry; mark as setup-failed
              // so a "never" policy reuse path does not silently resurrect a broken workspace.
              setupFailed.add(ws.id);
              attached.set(agentId, ws);
              throw new Error(
                `Workspace setup failed; cleanup also timed out or failed: workspace ${ws.id} is still alive`,
                { cause: e },
              );
            }
            throw e;
          }
        }

        // Write setup-complete marker outside the worktree so crash recovery can
        // confirm setup completed without replaying postCreate on the recovered workspace.
        await markSetupComplete(ws);

        attached.set(agentId, ws);
        return makeResult(ws);
      } finally {
        inFlight.delete(agentId);
      }
    },

    async detach(agent: Agent): Promise<void> {
      const agentId = agent.pid.id;
      const wsInfo = attached.get(agentId);
      if (!wsInfo) return;

      if (!shouldDispose(agent)) {
        // Intentionally preserved — keep tracking so a later attach for the
        // same agent can reuse the workspace under "never" or reclaim it otherwise.
        return;
      }

      // Only remove from tracking after confirmed successful disposal.
      // On failure or timeout, workspace remains in `attached` for retry or manual recovery.
      const disposed = await tryDispose(wsInfo.id);
      if (disposed) {
        attached.delete(agentId);
        setupFailed.delete(wsInfo.id);
        // Filesystem marker cleanup — only needed when the backend uses the filesystem fallback.
        // Backends with verifySetupComplete clean up their own attestation in dispose().
        if (!config.backend.verifySetupComplete) {
          await rm(setupCompletePath(wsInfo), { force: true });
        }
      }
    },
  };
}
