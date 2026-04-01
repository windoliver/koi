/**
 * Thin RPC wrapper for workspace artifact CRUD operations on Nexus.
 *
 * Wraps NexusClient.rpc calls with timeout protection via Promise.race.
 */

import type { KoiError, Result, WorkspaceId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import type { WorkspaceArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Nexus workspace client — thin layer over NexusClient.rpc. */
export interface NexusWorkspaceClient {
  readonly saveWorkspaceArtifact: (artifact: WorkspaceArtifact) => Promise<Result<void, KoiError>>;
  readonly loadWorkspaceArtifact: (
    wsId: WorkspaceId,
  ) => Promise<Result<WorkspaceArtifact | undefined, KoiError>>;
  readonly removeWorkspaceArtifact: (wsId: WorkspaceId) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus workspace client for artifact CRUD. */
export function createNexusWorkspaceClient(
  client: NexusClient,
  basePath: string,
  timeoutMs: number,
): NexusWorkspaceClient {
  function withTimeout<T>(promise: Promise<Result<T, KoiError>>): Promise<Result<T, KoiError>> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<Result<T, KoiError>>((resolve) => {
      timerId = setTimeout(
        () =>
          resolve({
            ok: false,
            error: {
              code: "TIMEOUT",
              message: `Nexus RPC timed out after ${timeoutMs}ms`,
              retryable: true,
              context: { timeoutMs },
            },
          }),
        timeoutMs,
      );
    });
    return Promise.race([promise, timer]).finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    });
  }

  return {
    saveWorkspaceArtifact: async (artifact) => {
      const path = `${basePath}/${artifact.id}`;
      const result = await withTimeout(client.rpc<void>("write", { path, content: artifact }));
      if (!result.ok) return result;
      return { ok: true, value: undefined };
    },

    loadWorkspaceArtifact: async (
      wsId: WorkspaceId,
    ): Promise<Result<WorkspaceArtifact | undefined, KoiError>> => {
      const path = `${basePath}/${wsId}`;
      const result = await withTimeout(client.rpc<WorkspaceArtifact | null>("read", { path }));
      if (!result.ok) {
        // NOT_FOUND → artifact doesn't exist, return undefined
        if (result.error.code === "NOT_FOUND") {
          return { ok: true, value: undefined };
        }
        return result;
      }
      const value: WorkspaceArtifact | undefined = result.value ?? undefined;
      return { ok: true, value };
    },

    removeWorkspaceArtifact: async (wsId) => {
      const path = `${basePath}/${wsId}`;
      const result = await withTimeout(client.rpc<void>("remove", { path }));
      if (!result.ok) {
        // NOT_FOUND → artifact already removed, treat as success (idempotent)
        if (result.error.code === "NOT_FOUND") {
          return { ok: true, value: undefined };
        }
        return result;
      }
      return { ok: true, value: undefined };
    },
  };
}
