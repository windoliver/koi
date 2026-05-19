/**
 * FileSystemBackend-backed memory store.
 *
 * This adapter keeps the existing markdown/frontmatter MemoryStore model
 * while allowing callers to place memory records on virtual backends such
 * as Nexus. Local disk storage remains implemented by ./store.ts.
 */

import type { FileSystemBackend } from "@koi/core";
import { buildFileSystemMemoryStore } from "./backend-store-ops.js";
import type { IndexErrorCallback, MemoryStore, MemoryStoreConfig } from "./types.js";
import { DEFAULT_DEDUP_THRESHOLD } from "./types.js";

const DEFAULT_MEMORY_DIR = "/memory";

export interface FileSystemMemoryStoreConfig
  extends Omit<MemoryStoreConfig, "dir" | "onIndexError"> {
  /** Backend to use for memory markdown files. Nexus callers pass @koi/fs-nexus here. */
  readonly fs: FileSystemBackend;
  /** Backend path for memory records. Defaults to the Nexus context-plane `/memory` namespace. */
  readonly memoryDir?: string | undefined;
  /** Observability hook invoked when MEMORY.md rebuild fails after a mutation. */
  readonly onIndexError?: IndexErrorCallback | undefined;
}

export interface StoreContext {
  readonly fs: FileSystemBackend;
  readonly memoryDir: string;
  readonly threshold: number;
  readonly onIndexError: IndexErrorCallback | undefined;
}

export function createFileSystemMemoryStore(config: FileSystemMemoryStoreConfig): MemoryStore {
  const threshold = config.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
  validateThreshold(threshold);

  return buildFileSystemMemoryStore({
    fs: config.fs,
    memoryDir: normalizeMemoryDir(config.memoryDir ?? DEFAULT_MEMORY_DIR),
    threshold,
    onIndexError: config.onIndexError,
  });
}

function validateThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`dedupThreshold must be between 0 and 1, got ${String(threshold)}`);
  }
}

function normalizeMemoryDir(memoryDir: string): string {
  const trimmed = memoryDir.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new Error("memoryDir must be non-empty");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
