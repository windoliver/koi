/**
 * Nexus-backed workspace backend.
 *
 * Creates local temp directories for agent workspaces and persists
 * workspace metadata to Nexus for cross-device state sync.
 *
 * Ordering invariant:
 *   create:  Nexus-first (save artifact), then local (mkdir)
 *   dispose: Nexus-first (delete artifact), then local (rmdir)
 *
 * This ensures a crash between steps leaves Nexus as source of truth,
 * and ephemeral local dirs can be recreated.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type {
  AgentId,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { workspaceId } from "@koi/core";
import { createNexusClient } from "@koi/nexus-client";
import {
  DEFAULT_BASE_DIR,
  DEFAULT_BASE_PATH,
  DEFAULT_TIMEOUT_MS,
  MARKER_FILENAME,
} from "./constants.js";
import { createNexusWorkspaceClient } from "./nexus-workspace-client.js";
import type { NexusWorkspaceBackendConfig, WorkspaceArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Nexus-backed workspace backend.
 *
 * Validates config at factory time and returns Result.error if invalid.
 * The returned backend stores workspace metadata in Nexus and creates
 * local directories for the actual workspace files.
 */
export function createNexusWorkspaceBackend(
  config: NexusWorkspaceBackendConfig,
): Result<WorkspaceBackend, KoiError> {
  // Validate required config
  if (!config.nexusUrl || config.nexusUrl.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusWorkspaceBackendConfig.nexusUrl is required and must be non-empty",
        retryable: false,
      },
    };
  }

  try {
    new URL(config.nexusUrl);
  } catch (_e: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `NexusWorkspaceBackendConfig.nexusUrl is not a valid URL: ${config.nexusUrl}`,
        retryable: false,
      },
    };
  }

  if (!config.apiKey || config.apiKey.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "NexusWorkspaceBackendConfig.apiKey is required and must be non-empty",
        retryable: false,
      },
    };
  }

  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const baseDir = resolve(config.baseDir ?? DEFAULT_BASE_DIR);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const nexusClient = createNexusClient({
    baseUrl: config.nexusUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  const wsClient = createNexusWorkspaceClient(nexusClient, basePath, timeoutMs);
  const hostId = hostname();

  const backend: WorkspaceBackend = {
    name: "nexus",
    isSandboxed: false,

    create: async (
      agentId: AgentId,
      wsConfig: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo, KoiError>> => {
      // Validate agentId
      if (!agentId || String(agentId).trim().length === 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "agentId is required and must be non-empty",
            retryable: false,
          },
        };
      }

      const createdAt = Date.now();
      const suffix = crypto.randomUUID().slice(0, 8);
      const wsId = workspaceId(`nexus-ws-${agentId}-${createdAt}-${suffix}`);
      const localPath = resolve(baseDir, wsId);

      // Defense-in-depth: verify resolved path stays under baseDir
      if (!localPath.startsWith(baseDir)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Resolved workspace path escapes base directory: ${localPath}`,
            retryable: false,
          },
        };
      }

      const artifact: WorkspaceArtifact = {
        id: wsId,
        agentId: String(agentId),
        hostId,
        localPath,
        createdAt,
        config: wsConfig,
        status: "active",
      };

      // Nexus-first: save artifact to Nexus
      const saveResult = await wsClient.saveWorkspaceArtifact(artifact);
      if (!saveResult.ok) {
        return {
          ok: false,
          error: {
            code: saveResult.error.code,
            message: `Failed to save workspace artifact to Nexus: ${saveResult.error.message}`,
            retryable: saveResult.error.retryable,
            cause: saveResult.error,
          },
        };
      }

      // Local-second: create directory
      try {
        await mkdir(localPath, { recursive: true });
      } catch (e: unknown) {
        // Rollback: delete Nexus artifact
        await wsClient.removeWorkspaceArtifact(wsId).catch((rollbackErr: unknown) => {
          console.warn(
            `[workspace-nexus] Rollback: failed to remove Nexus artifact for ${wsId}: ${
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            }`,
          );
        });

        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to create local workspace directory: ${
              e instanceof Error ? e.message : String(e)
            }`,
            retryable: false,
            cause: e,
          },
        };
      }

      // Write marker file
      const marker = JSON.stringify({
        id: wsId,
        agentId: String(agentId),
        createdAt,
        hostId,
      });

      try {
        await writeFile(`${localPath}/${MARKER_FILENAME}`, marker, "utf-8");
      } catch (e: unknown) {
        // Non-fatal: marker is for debugging, workspace is still functional
        console.warn(
          `[workspace-nexus] Failed to write marker file for ${wsId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      return {
        ok: true,
        value: {
          id: wsId,
          path: localPath,
          createdAt,
          metadata: {
            hostId,
            nexusUrl: config.nexusUrl,
          },
        },
      };
    },

    dispose: async (wsId: WorkspaceId): Promise<Result<void, KoiError>> => {
      // Nexus-first: delete artifact
      const removeResult = await wsClient.removeWorkspaceArtifact(wsId);
      if (!removeResult.ok) {
        return {
          ok: false,
          error: {
            code: removeResult.error.code,
            message: `Failed to remove workspace artifact from Nexus: ${removeResult.error.message}`,
            retryable: removeResult.error.retryable,
            cause: removeResult.error,
          },
        };
      }

      // Local-second: remove directory
      const localPath = resolve(baseDir, wsId);
      try {
        await rm(localPath, { recursive: true, force: true });
      } catch (e: unknown) {
        // Local dir removal failure is non-fatal — Nexus artifact is already gone
        console.warn(
          `[workspace-nexus] Failed to remove local directory ${localPath}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      return { ok: true, value: undefined };
    },

    isHealthy: async (wsId: WorkspaceId): Promise<boolean> => {
      // Local-first short-circuit: if local dir or marker doesn't exist, unhealthy
      const localPath = resolve(baseDir, wsId);
      if (!existsSync(localPath) || !existsSync(`${localPath}/${MARKER_FILENAME}`)) {
        return false;
      }

      // Check Nexus artifact exists
      const loadResult = await wsClient.loadWorkspaceArtifact(wsId);
      if (!loadResult.ok) {
        // Nexus unreachable → fail-closed
        return false;
      }

      return loadResult.value !== undefined;
    },
  };

  return { ok: true, value: backend };
}
