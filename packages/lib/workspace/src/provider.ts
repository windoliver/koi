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

  // Attempt to reuse a single crash-survivor candidate. Returns true if the candidate was
  // successfully reused (caller should return its result). Returns false if the candidate
  // failed validation and was disposed — caller should try the next candidate or create fresh.
  // Throws only for unrecoverable errors (e.g. cleanup timed out on a poisoned workspace).
  async function tryReuseCrashSurvivor(
    agentId: AgentId,
    candidate: WorkspaceInfo,
  ): Promise<AttachResult | false> {
    const wsId = candidate.id;
    if (setupFailed.has(wsId)) {
      await tryDispose(wsId);
      return false;
    }
    const [healthy, setupComplete] = await Promise.all([
      config.backend.isHealthy(wsId),
      isSetupComplete(candidate),
    ]);
    if (!healthy || !setupComplete) {
      setupFailed.delete(wsId);
      await tryDispose(wsId);
      return false;
    }
    // Found a valid survivor — re-run postCreate to repair any setup drift
    // (e.g. files deleted after setup). Callers using cleanupPolicy="never" must ensure
    // postCreate is idempotent.
    if (config.postCreate) {
      try {
        await config.postCreate(candidate);
      } catch (e: unknown) {
        const didDispose = await tryDispose(wsId);
        if (!didDispose) {
          setupFailed.add(wsId);
          attached.set(agentId, candidate);
          throw new Error(
            `Crash-survivor postCreate failed; cleanup also timed out: workspace ${wsId} is still alive`,
            { cause: e },
          );
        }
        setupFailed.delete(wsId);
        return false; // postCreate failed but disposed — try next candidate
      }
    }
    attached.set(agentId, candidate);
    return makeResult(candidate);
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
        const crashSurvivors: ReadonlyArray<WorkspaceInfo> =
          staleInfo === undefined && config.backend.findByAgentId
            ? await config.backend.findByAgentId(agentId)
            : [];

        if (policy === "never") {
          // In-process reuse: workspace was preserved from last detach — always trusted.
          if (staleInfo !== undefined) {
            const wsId = staleInfo.id;
            if (!setupFailed.has(wsId)) {
              const [healthy, setupComplete] = await Promise.all([
                config.backend.isHealthy(wsId),
                isSetupComplete(staleInfo),
              ]);
              if (healthy && setupComplete) {
                attached.set(agentId, staleInfo);
                return makeResult(staleInfo);
              }
            }
            setupFailed.delete(wsId);
            attached.delete(agentId);
            // Unhealthy/incomplete — dispose and fall through to create
            const disposed = await tryDispose(wsId);
            if (!disposed) {
              throw new Error(
                `Cannot reattach agent ${agentId}: workspace ${wsId} could not be disposed`,
              );
            }
          }

          // Crash-survivor reuse: try candidates newest-first.
          // Only sandboxed backends can guarantee the agent process cannot forge the attestation
          // signal (e.g. an unsandboxed git-worktree agent can write refs/koi-setup-ok/* directly).
          if (config.backend.isSandboxed && crashSurvivors.length > 0) {
            for (const candidate of crashSurvivors) {
              const reused = await tryReuseCrashSurvivor(agentId, candidate);
              if (reused !== false) {
                // Dispose any remaining older survivors before returning
                for (const other of crashSurvivors) {
                  if (other.id !== candidate.id) await tryDispose(other.id);
                }
                return reused;
              }
            }
            // All candidates exhausted — fall through to create
          } else {
            // Unsandboxed or no survivors: dispose all crash survivors (not trusted / not present)
            for (const survivor of crashSurvivors) {
              await tryDispose(survivor.id);
            }
          }
        } else {
          // Non-"never" policy: dispose in-process workspace if present (it wasn't cleaned up
          // on last detach, e.g. because the previous tryDispose timed out).
          if (staleInfo !== undefined) {
            const disposed = await tryDispose(staleInfo.id);
            if (!disposed) {
              throw new Error(
                `Cannot reattach agent ${agentId}: previous workspace ${staleInfo.id} could not be disposed`,
              );
            }
            attached.delete(agentId);
          }
          // Crash survivors under non-"never" policy are not reused — best-effort dispose.
          for (const survivor of crashSurvivors) {
            await tryDispose(survivor.id);
          }
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
