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

  readonly dispose?: () => void | Promise<void>;
}
