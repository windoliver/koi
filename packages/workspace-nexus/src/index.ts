/**
 * @koi/workspace-nexus — Nexus-backed workspace backend.
 *
 * L2 feature package. Provides a WorkspaceBackend that stores workspace
 * metadata in Nexus for cross-device workspace state sync.
 */

export { createNexusWorkspaceBackend } from "./nexus-backend.js";
export type { NexusWorkspaceBackendConfig, WorkspaceArtifact } from "./types.js";
