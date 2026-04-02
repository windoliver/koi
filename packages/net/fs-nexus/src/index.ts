/**
 * @koi/fs-nexus — Nexus-backed FileSystemBackend (Layer 2).
 *
 * Delegates all file operations to a Nexus JSON-RPC server.
 * Swap the local filesystem backend for remote Nexus storage
 * with zero changes to agent code.
 */

export { createHttpTransport } from "./http-transport.js";
export { createNexusFileSystem } from "./nexus-filesystem-backend.js";
export type { HttpTransportConfig, NexusFileSystemConfig, NexusTransport } from "./types.js";
export { validateNexusFileSystemConfig } from "./validate-config.js";
