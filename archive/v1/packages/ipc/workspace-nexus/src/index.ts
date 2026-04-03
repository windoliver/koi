/**
 * @koi/workspace-nexus — Nexus-backed workspace backend.
 *
 * L2 feature package. Provides a WorkspaceBackend implementation that stores
 * workspace metadata in a Raft-replicated Nexus server for cross-device state sync.
 */

export { createNexusWorkspaceBackend } from "./nexus-backend.js";
export type { NexusWorkspaceBackendConfig, WorkspaceArtifact } from "./types.js";
