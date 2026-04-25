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
  // Fall back to a filesystem sibling marker ONLY for sandboxed backends where OS-level isolation
  // prevents the workspace process from writing outside its sandbox. Unsandboxed backends without
  // explicit attestation support must not be trusted for crash-survivor reuse.
  function setupCompletePath(ws: WorkspaceInfo): string {
    return join(dirname(ws.path), `${ws.id}.setup-ok`);
  }

  async function markSetupComplete(ws: WorkspaceInfo): Promise<void> {
    if (config.backend.attestSetupComplete) {
      await config.backend.attestSetupComplete(ws.id);
    } else if (config.backend.isSandboxed) {
      await writeFile(setupCompletePath(ws), "", "utf8");
    }
    // Unsandboxed backends without attestation: skip silently.
    // isSetupComplete returns false for such backends, so crash-survivor reuse will
    // always fall through to dispose+recreate — attestation is not needed.
  }

  async function isSetupComplete(ws: WorkspaceInfo): Promise<boolean> {
    if (config.backend.verifySetupComplete) {
      return config.backend.verifySetupComplete(ws.id);
    }
    // For unsandboxed backends without attestation, the filesystem marker is writable by the
    // workspace process — refuse to trust it and force workspace recreation instead.
    if (!config.backend.isSandboxed) return false;
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
        let recoveredInfo: WorkspaceInfo | undefined;
        if (staleInfo === undefined && config.backend.findByAgentId) {
          recoveredInfo = await config.backend.findByAgentId(agentId);
        }

        const staleInfo2 = staleInfo ?? recoveredInfo;
        const isFromCrashRecovery = staleInfo === undefined && recoveredInfo !== undefined;

        // Under "never" policy: reuse the preserved workspace rather than discarding it.
        // In-process reuse (staleInfo from attached map) is always trusted.
        // Crash-survivor reuse (from findByAgentId) requires backend-level recovery proof:
        // the backend must implement verifySetupComplete, which attests both ownership and
        // setup completion in a form the provider trusts. Backends without this method
        // cannot provide a non-forgeable recovery signal; their survivors are disposed+recreated.
        // When reusing a crash survivor, postCreate is re-run to repair any setup drift
        // (e.g. files deleted after setup). Callers using cleanupPolicy="never" must ensure
        // postCreate is idempotent.
        if (staleInfo2 !== undefined && policy === "never") {
          const wsId = staleInfo2.id;
          const hasTrustedRecovery =
            !isFromCrashRecovery || config.backend.verifySetupComplete !== undefined;
          if (!setupFailed.has(wsId) && hasTrustedRecovery) {
            const [healthy, setupComplete] = await Promise.all([
              config.backend.isHealthy(wsId),
              isSetupComplete(staleInfo2),
            ]);
            if (healthy && setupComplete) {
              if (isFromCrashRecovery && config.postCreate) {
                try {
                  await config.postCreate(staleInfo2);
                } catch (e: unknown) {
                  const didDispose = await tryDispose(wsId);
                  if (!didDispose) {
                    setupFailed.add(wsId);
                    attached.set(agentId, staleInfo2);
                    throw new Error(
                      `Crash-survivor postCreate failed; cleanup also timed out: workspace ${wsId} is still alive`,
                      { cause: e },
                    );
                  }
                  attached.delete(agentId);
                  throw e;
                }
              }
              attached.set(agentId, staleInfo2);
              return makeResult(staleInfo2);
            }
          }
          setupFailed.delete(wsId);
          attached.delete(agentId);
          // Unhealthy, setup incomplete, or no trusted recovery proof — dispose + recreate
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

        // Attest setup completion — only for "never" policy, which is the only path
        // that reuses a crash-surviving workspace. Other policies always dispose on recovery.
        if (policy === "never") {
          try {
            await markSetupComplete(ws);
          } catch (e: unknown) {
            const didDispose = await tryDispose(ws.id);
            if (!didDispose) {
              setupFailed.add(ws.id);
              attached.set(agentId, ws);
              throw new Error(
                `Workspace attestation failed; cleanup also timed out: workspace ${ws.id} is still alive`,
                { cause: e },
              );
            }
            throw e;
          }
        }

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
        // Filesystem marker cleanup — only written for sandboxed backends without backend
        // attestation; backends with verifySetupComplete clean up in their own dispose().
        if (
          policy === "never" &&
          !config.backend.verifySetupComplete &&
          config.backend.isSandboxed
        ) {
          await rm(setupCompletePath(wsInfo), { force: true });
        }
      }
    },
  };
}
