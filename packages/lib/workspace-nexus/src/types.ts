import type { WorkspaceBackend } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusWorkspaceServerCapabilities {
  readonly findByAgentId?: boolean;
  readonly attestSetupComplete?: boolean;
  readonly verifySetupComplete?: boolean;
  readonly invalidateSetupComplete?: boolean;
  readonly exists?: boolean;
}

export interface NexusWorkspaceBackendConfig {
  readonly transport: NexusTransport;
  readonly methodPrefix?: string | undefined;
  readonly basePath?: string | undefined;
  /**
   * Optional local backend used as a startup-only escape hatch when the
   * configured Nexus transport fails its initial health probe. Once
   * `createNexusWorkspaceBackend()` returns, the chosen authority is
   * fixed for the lifetime of the instance — runtime RPC failures are
   * NEVER routed to the fallback, since the two backends do not share
   * state and silently rerouting would orphan live Nexus survivors.
   */
  readonly fallback?: WorkspaceBackend | undefined;
  /**
   * Optional hooks the connected Nexus server is known to implement.
   * Defaults to ON: the workspace provider depends on these hooks
   * (especially `findByAgentId` and the attestation hooks) to recover
   * crash survivors safely after a restart, and hiding them silently
   * pushes callers into duplicate-allocation under
   * `cleanupPolicy="never"`. Operators who know their Nexus server
   * lacks a specific RPC set that capability to `false` to suppress
   * the hook; otherwise an unsupported RPC surfaces as a typed
   * `METHOD_NOT_FOUND` error at call time.
   */
  readonly serverCapabilities?: NexusWorkspaceServerCapabilities;
}

export interface NexusWorkspaceRecord {
  readonly id: string;
  readonly path: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface NexusWorkspaceCreateResponse {
  readonly workspace: NexusWorkspaceRecord;
}

export interface NexusWorkspaceHealthResponse {
  readonly healthy: boolean;
}

export interface NexusWorkspaceFindResponse {
  readonly workspaces: ReadonlyArray<NexusWorkspaceRecord>;
}

export interface NexusWorkspaceExistsResponse {
  readonly exists: boolean;
}

export interface NexusWorkspaceSetupCompleteResponse {
  readonly setupComplete: boolean;
}
