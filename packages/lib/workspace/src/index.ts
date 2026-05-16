export type { GitWorktreeBackendConfig } from "./git-backend.js";
export { createGitWorktreeBackend } from "./git-backend.js";
export type {
  GitWorktreeOverlayManager,
  GitWorktreeOverlayManagerConfig,
  OverlayAcceptResult,
  OverlayFileSystemConfig,
  WorkspaceOverlay,
} from "./overlay.js";
export { createGitWorktreeOverlayManager, createOverlayFileSystem } from "./overlay.js";
export type { WorkspaceProviderConfig } from "./provider.js";
export { createWorkspaceProvider } from "./provider.js";
