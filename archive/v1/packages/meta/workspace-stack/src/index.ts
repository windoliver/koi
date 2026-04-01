/**
 * @koi/workspace-stack — L3 backend factory for Nexus-backed agent workspaces.
 *
 * Creates raw pieces (backend, enforcer, retriever) from Nexus config.
 * Callers like @koi/governance compose these into providers and middleware.
 */

export { createWorkspaceStack } from "./create-workspace-stack.js";
export type { WorkspaceStackBundle, WorkspaceStackConfig } from "./types.js";
