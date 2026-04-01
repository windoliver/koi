/**
 * @koi/tools-builtin — Built-in filesystem tools for Koi agents.
 *
 * Exports factory functions that create primordial Tool instances
 * backed by a FileSystemBackend (L0 contract).
 */

export type { ParseResult } from "./parse-args.js";
export { createFsEditTool } from "./tools/edit.js";
export { createFsReadTool } from "./tools/read.js";
export { createFsWriteTool } from "./tools/write.js";
