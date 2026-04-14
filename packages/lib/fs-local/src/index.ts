/**
 * @koi/fs-local — Local filesystem FileSystemBackend.
 *
 * L2 adapter that implements the L0 FileSystemBackend contract using
 * Bun.file/Bun.write and node:fs/promises. Security boundary is the
 * permission middleware — the backend is pure I/O with symlink
 * hardening as defense-in-depth for workspace paths.
 */

export type { LocalFileSystemOptions } from "./local-filesystem-backend.js";
export { createLocalFileSystem } from "./local-filesystem-backend.js";
export type { ResolvedFsPath, ResolveFsPathOptions } from "./path-resolution.js";
export { resolveFsPath, resolveFsPathWithCoercion } from "./path-resolution.js";
