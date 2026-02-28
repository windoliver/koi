/**
 * @koi/filesystem — Cross-engine filesystem abstraction (Layer 2)
 *
 * Provides a ComponentProvider that wraps a FileSystemBackend as Tool
 * components. Both engine-claude and engine-pi discover these tools via
 * `agent.query<Tool>("tool:")` with zero engine changes.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// types — re-exported from @koi/core for convenience
export type {
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileEntryKind,
  FileListEntry,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileSearchMatch,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
} from "@koi/core";
export type { FileSystemOperation } from "./constants.js";
// constants
export { CLAUDE_SDK_FILE_TOOLS, DEFAULT_PREFIX, OPERATIONS } from "./constants.js";

// descriptor
export { descriptor } from "./descriptor.js";

// provider
export type { FileSystemProviderConfig } from "./fs-component-provider.js";
export { createFileSystemProvider } from "./fs-component-provider.js";

// tool factories — for advanced usage (custom tool composition)
export { createFsEditTool } from "./tools/edit.js";
export { createFsListTool } from "./tools/list.js";
export { createFsReadTool } from "./tools/read.js";
export { createFsSearchTool } from "./tools/search.js";
export { createFsWriteTool } from "./tools/write.js";
