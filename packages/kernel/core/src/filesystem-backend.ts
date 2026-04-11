/**
 * FileSystem backend contract — cross-engine abstraction for file operations.
 *
 * Engines discover filesystem tools via `agent.query<Tool>("tool:")` — the
 * backend is wrapped as Tool components by an L2 ComponentProvider. Both
 * engine-claude and engine-pi consume it with zero engine changes.
 *
 * Return types use `T | Promise<T>` so implementations can be sync (local FS)
 * or async (Nexus, S3, etc.) without interface changes.
 */

import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface FileReadOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly encoding?: string;
}

export interface FileReadResult {
  readonly content: string;
  readonly path: string;
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface FileWriteOptions {
  readonly createDirectories?: boolean;
  readonly overwrite?: boolean;
}

export interface FileWriteResult {
  readonly path: string;
  readonly bytesWritten: number;
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export interface FileEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface FileEditOptions {
  readonly dryRun?: boolean;
}

export interface FileEditResult {
  readonly path: string;
  readonly hunksApplied: number;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type FileEntryKind = "file" | "directory" | "symlink";

export interface FileListEntry {
  readonly path: string;
  readonly kind: FileEntryKind;
  readonly size?: number;
  /** Last modification time in milliseconds since epoch. */
  readonly modifiedAt?: number;
}

export interface FileListOptions {
  readonly recursive?: boolean;
  readonly glob?: string;
}

export interface FileListResult {
  readonly entries: readonly FileListEntry[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface FileSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface FileSearchOptions {
  readonly glob?: string;
  readonly maxResults?: number;
  readonly caseSensitive?: boolean;
}

export interface FileSearchResult {
  readonly matches: readonly FileSearchMatch[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface FileDeleteResult {
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface FileRenameResult {
  readonly from: string;
  readonly to: string;
}

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

export interface FileSystemBackend {
  readonly name: string;

  readonly read: (
    path: string,
    options?: FileReadOptions,
  ) => Result<FileReadResult, KoiError> | Promise<Result<FileReadResult, KoiError>>;

  readonly write: (
    path: string,
    content: string,
    options?: FileWriteOptions,
  ) => Result<FileWriteResult, KoiError> | Promise<Result<FileWriteResult, KoiError>>;

  readonly edit: (
    path: string,
    edits: readonly FileEdit[],
    options?: FileEditOptions,
  ) => Result<FileEditResult, KoiError> | Promise<Result<FileEditResult, KoiError>>;

  readonly list: (
    path: string,
    options?: FileListOptions,
  ) => Result<FileListResult, KoiError> | Promise<Result<FileListResult, KoiError>>;

  readonly search: (
    pattern: string,
    options?: FileSearchOptions,
  ) => Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>>;

  readonly delete?: (
    path: string,
  ) => Result<FileDeleteResult, KoiError> | Promise<Result<FileDeleteResult, KoiError>>;

  readonly rename?: (
    from: string,
    to: string,
  ) => Result<FileRenameResult, KoiError> | Promise<Result<FileRenameResult, KoiError>>;

  /**
   * Resolve a tool-input path to the absolute on-disk path the backend
   * will actually read from or write to. Pure lexical resolution: no I/O,
   * no symlink following, no permission checks.
   *
   * Return type: `string | undefined`. Implementations MUST return
   * `undefined` when the input resolves outside the workspace root
   * (traversal via `../` segments, absolute paths not matching the root,
   * platform-specific syntax like Windows drive letters, etc.). This is
   * the only defense auxiliary subsystems have against hashing arbitrary
   * host files when the tool-input path is attacker-controlled — the
   * backend's own read/write/edit calls run the full containment gauntlet
   * (symlink resolution, permission checks), but those run AFTER any
   * cross-cutting subsystem has already observed the path.
   *
   * Exists so auxiliary subsystems (notably `@koi/checkpoint`, which hashes
   * pre/post images of file ops) can hash blobs for the same path the
   * backend will write to. Without this, tool-input paths like `/src/foo.ts`
   * end up hashed against their raw form while the backend writes to
   * `<workspace-root>/src/foo.ts`, and the restore protocol silently no-ops.
   *
   * Implementations that virtualize paths (e.g., strip a workspace prefix,
   * treat leading-slash as workspace-relative) MUST implement this method.
   * Implementations that pass paths through unchanged MAY omit it; callers
   * treat `undefined` (either the method is absent or returns `undefined`)
   * as "path is not safely resolvable — skip the cross-cutting operation."
   */
  readonly resolvePath?: (path: string) => string | undefined;

  readonly dispose?: () => void | Promise<void>;
}
