/**
 * WorkspaceProvider — ComponentProvider that attaches workspace isolation to agents.
 *
 * Delegates to a WorkspaceBackend strategy for the actual isolation mechanism.
 * Implements attach/detach lifecycle with configurable cleanup policies.
 */

import type {
  Agent,
  CleanupPolicy,
  ComponentProvider,
  KoiError,
  Result,
  WorkspaceId,
} from "@koi/core";
import { skillToken, WORKSPACE } from "@koi/core";
import { WORKSPACE_SKILL, WORKSPACE_SKILL_NAME } from "./skill.js";
import type { WorkspaceProviderConfig } from "./types.js";
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

  const { config: resolved, backend, postCreate, pruneStale } = validated.value;

  // Mutable Map justified: internal tracking state encapsulated in closure,
  // not exposed to callers. Functional alternative would require
  // closure-over-reassignment which is equally mutable.
  const workspaces = new Map<string, WorkspaceId>();

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
          // Best-effort cleanup — don't mask the original error
          try {
            await backend.dispose(workspace.id);
          } catch (disposeErr: unknown) {
            console.warn(
              `[workspace] dispose during postCreate cleanup failed: ${
                disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
              }`,
            );
          }
          throw new Error("postCreate hook failed", { cause: e });
        }
      }

      workspaces.set(agent.pid.id, workspace.id);

      return new Map<string, unknown>([
        [WORKSPACE as string, workspace],
        [skillToken(WORKSPACE_SKILL_NAME) as string, WORKSPACE_SKILL],
      ]);
    },

    detach: async (agent: Agent): Promise<void> => {
      const workspaceId = workspaces.get(agent.pid.id);
      if (workspaceId === undefined) return;

      const shouldCleanup = resolveCleanup(resolved.cleanupPolicy, agent);
      if (!shouldCleanup) {
        // Preserve mapping so workspace can still be found for retry/inspection
        console.warn(
          `[workspace] preserved workspace ${workspaceId} for agent ${agent.pid.id} ` +
            `(policy=${resolved.cleanupPolicy}, outcome=${agent.terminationOutcome ?? "unknown"})`,
        );

        if (pruneStale) {
          try {
            await pruneStale();
          } catch (e: unknown) {
            console.warn(
              `[workspace] pruneStale failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return;
      }

      await disposeWithTimeout(backend, workspaceId, resolved.cleanupTimeoutMs);

      // Delete mapping only after disposal completes — preserves retry ability on failure
      workspaces.delete(agent.pid.id);
    },
  };

  return { ok: true, value: provider };
}

function resolveCleanup(policy: CleanupPolicy, agent: Agent): boolean {
  switch (policy) {
    case "always":
      return true;
    case "never":
      return false;
    case "on_success":
      // Fail-closed: only clean up when we can confirm success.
      // undefined outcome on a terminated agent → preserve workspace.
      return agent.state === "terminated" && agent.terminationOutcome === "success";
  }
}

async function disposeWithTimeout(
  backend: ValidatedWorkspaceConfig["backend"],
  wsId: WorkspaceId,
  timeoutMs: number,
): Promise<void> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  // Catch rejections on the dispose promise so that if timeout wins the race,
  // the abandoned promise doesn't cause an unhandled rejection.
  const disposePromise = backend.dispose(wsId).catch((e: unknown) => ({
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
    console.warn(`[workspace] dispose for ${wsId} exceeded ${timeoutMs}ms timeout`);
    return;
  }

  if (typeof raceResult === "object" && !raceResult.ok) {
    console.warn(`[workspace] dispose for ${wsId} failed: ${raceResult.error.message}`);
  }
}
