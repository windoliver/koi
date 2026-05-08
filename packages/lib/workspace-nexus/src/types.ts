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
   * Defaults to OFF: hooks not explicitly listed here are NOT advertised,
   * because the provider treats method presence as a capability signal
   * and would attempt RPCs that an older server cannot answer — turning a
   * mixed-version rollout into a hard outage. Operators flip individual
   * bits to `true` once they have confirmed server support.
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
