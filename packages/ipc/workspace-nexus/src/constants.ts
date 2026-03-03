/**
 * Default constants for the Nexus workspace backend configuration.
 */

/** Default Nexus RPC base path for workspace artifacts. */
export const DEFAULT_BASE_PATH = "/workspaces";

/** Default local directory for workspace dirs (relative to cwd). */
export const DEFAULT_BASE_DIR = ".koi/workspaces";

/** Default timeout for Nexus RPC calls in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Marker filename written to workspace directories for lifecycle tracking. */
export const MARKER_FILENAME = ".koi-workspace";
