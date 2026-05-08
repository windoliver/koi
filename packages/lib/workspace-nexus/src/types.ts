import type { WorkspaceBackend } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusWorkspaceBackendConfig {
  readonly transport: NexusTransport;
  readonly fallback?: WorkspaceBackend | undefined;
  readonly methodPrefix?: string | undefined;
  readonly basePath?: string | undefined;
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
