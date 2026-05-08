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
  readonly fallback?: WorkspaceBackend | undefined;
  readonly methodPrefix?: string | undefined;
  readonly basePath?: string | undefined;
  /**
   * Optional hooks the connected Nexus server is known to implement.
   * Hooks not listed here are NOT advertised to callers, even if a fallback
   * could honor them — this prevents attach/cleanup from hard-failing
   * against an older or partially upgraded Nexus server. Defaults to all
   * hooks supported when omitted (matches a fully-upgraded server).
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
