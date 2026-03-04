/**
 * @koi/filesystem-nexus — Nexus-backed FileSystemBackend (Layer 2).
 *
 * Delegates all file operations to a Nexus JSON-RPC server.
 * Agents get semantic search (Nexus indexes on write) and per-file
 * permissions (via ReBAC tuples) for free.
 */

export { createNexusFileSystem } from "./nexus-filesystem-backend.js";
export type { NexusFileSystemConfig } from "./types.js";
export { validateNexusFileSystemConfig } from "./validate-config.js";
