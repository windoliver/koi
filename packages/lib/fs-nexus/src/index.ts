/**
 * @koi/fs-nexus — Nexus-backed FileSystemBackend via JSON-RPC.
 *
 * L2 adapter that implements the L0 FileSystemBackend contract by
 * delegating to a Nexus server. All 7 operations (read, write, edit,
 * list, search, delete, rename) work against any Nexus instance.
 */

// Local transport (subprocess bridge — no HTTP server needed)
export type { LocalTransportConfig } from "./local-transport.js";
export { createLocalTransport } from "./local-transport.js";
// Factory
export type { NexusFileSystemFullConfig } from "./nexus-filesystem-backend.js";
export { createNexusFileSystem } from "./nexus-filesystem-backend.js";

// Config & types
export type { NexusFileSystemConfig, NexusTransport } from "./types.js";

// Validation
export { validateNexusFileSystemConfig } from "./validate-config.js";
