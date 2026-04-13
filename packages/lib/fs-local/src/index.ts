/**
 * @koi/fs-local — Local filesystem FileSystemBackend.
 *
 * L2 adapter that implements the L0 FileSystemBackend contract using
 * Bun.file/Bun.write and node:fs/promises. Scoped to a root directory
 * with path traversal prevention.
 */

export { createLocalFileSystem, type LocalFileSystemOptions } from "./local-filesystem-backend.js";
