/**
 * WorkspaceProvider — ComponentProvider that attaches workspace isolation to agents.
 *
 * Delegates to a WorkspaceBackend strategy for the actual isolation mechanism.
 * Implements attach/detach lifecycle with configurable cleanup policies.
 */

import type { Agent, ComponentProvider, KoiError, ProcessState, Result } from "@koi/core";
import { WORKSPACE } from "@koi/core";
import type { CleanupPolicy, WorkspaceProviderConfig } from "./types.js";
import { type ValidatedWorkspaceConfig, validateWorkspaceConfig } from "./validate-config.js";

/**
 * Create a ComponentProvider that attaches workspace isolation to agents.
 *
 * Validates config at factory time and returns Result.error if invalid.
 * The returned provider delegates to the configured WorkspaceBackend.
 */
export function createWorkspaceProvider(
  config: WorkspaceProviderConfig,
): Result<ComponentProvider, KoiError> {
  const validated = validateWorkspaceConfig(config);
  if (!validated.ok) return validated;

  const { config: resolved, backend, postCreate } = validated.value;

  // Mutable Map justified: internal tracking state encapsulated in closure,
  // not exposed to callers. Functional alternative would require
  // closure-over-reassignment which is equally mutable.
  const workspaces = new Map<string, string>();

  const provider: ComponentProvider = {
    name: "workspace",

    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const result = await backend.create(agent.pid.id, resolved);
      if (!result.ok) {
        throw new Error(
          `Workspace backend "${backend.name}" failed to create workspace: ${result.error.message}`,
          { cause: result.error },
        );
      }

      const workspace = result.value;

      if (postCreate) {
        try {
          await postCreate(workspace);
        } catch (e: unknown) {
          // Clean up the created workspace before propagating
          await backend.dispose(workspace.id);
          throw new Error("postCreate hook failed", { cause: e });
        }
      }

      workspaces.set(agent.pid.id, workspace.id);

      const key: string = WORKSPACE;
      return new Map([[key, workspace]]);
    },

    detach: async (agent: Agent): Promise<void> => {
      const workspaceId = workspaces.get(agent.pid.id);
      if (workspaceId === undefined) return;

      workspaces.delete(agent.pid.id);

      const shouldCleanup = resolveCleanup(resolved.cleanupPolicy, agent.state);
      if (!shouldCleanup) return;

      await disposeWithTimeout(backend, workspaceId, resolved.cleanupTimeoutMs);
    },
  };

  return { ok: true, value: provider };
}

function resolveCleanup(policy: CleanupPolicy, agentState: ProcessState): boolean {
  switch (policy) {
    case "always":
      return true;
    case "never":
      return false;
    case "on_success":
      return agentState === "terminated";
  }
}

async function disposeWithTimeout(
  backend: ValidatedWorkspaceConfig["backend"],
  workspaceId: string,
  timeoutMs: number,
): Promise<void> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  // Catch rejections on the dispose promise so that if timeout wins the race,
  // the abandoned promise doesn't cause an unhandled rejection.
  const disposePromise = backend.dispose(workspaceId).catch((e: unknown) => ({
    ok: false as const,
    error: {
      code: "EXTERNAL" as const,
      message: `dispose threw: ${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
    },
  }));
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timerId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const raceResult = await Promise.race([disposePromise, timeoutPromise]);

  if (timerId !== undefined) clearTimeout(timerId);

  if (raceResult === "timeout") {
    console.warn(`[workspace] dispose for ${workspaceId} exceeded ${timeoutMs}ms timeout`);
    return;
  }

  if (typeof raceResult === "object" && !raceResult.ok) {
    console.warn(`[workspace] dispose for ${workspaceId} failed: ${raceResult.error.message}`);
  }
}
