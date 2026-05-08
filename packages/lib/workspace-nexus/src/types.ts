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
