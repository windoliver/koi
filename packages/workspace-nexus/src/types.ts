/**
 * Nexus workspace backend configuration and artifact types.
 */

import type { ResolvedWorkspaceConfig, WorkspaceId } from "@koi/core";

// ---------------------------------------------------------------------------
// Backend configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a Nexus-backed workspace backend. */
export interface NexusWorkspaceBackendConfig {
  /** Nexus server URL (e.g., "http://localhost:2026"). */
  readonly nexusUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Nexus RPC base path for workspace artifacts. Default: "/workspaces". */
  readonly basePath?: string | undefined;
  /** Local directory for workspace dirs. Default: ".koi/workspaces". */
  readonly baseDir?: string | undefined;
  /** Timeout for Nexus RPC calls in ms. Default: 10_000. */
  readonly timeoutMs?: number | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Nexus artifact
// ---------------------------------------------------------------------------

/** Shape of the Nexus artifact stored per workspace. */
export interface WorkspaceArtifact {
  readonly id: WorkspaceId;
  readonly agentId: string;
  readonly hostId: string;
  readonly localPath: string;
  readonly createdAt: number;
  readonly config: ResolvedWorkspaceConfig;
  readonly status: "active" | "disposing" | "disposed";
}
