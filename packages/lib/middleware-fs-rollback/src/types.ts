/**
 * Configuration and handle types for the filesystem rollback middleware.
 */

import type { KoiMiddleware } from "@koi/core";

/**
 * Inode-style identity captured at snapshot time. Used to detect
 * concurrent unlink/replace between snapshot and rollback — if the file
 * was replaced (different `ino`) or had its type changed (regular file
 * → symlink, etc.) we refuse to restore and surface a conflict rather
 * than silently clobbering a newer write.
 */
export interface FsStat {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
  /** Object kind. Only `"file"` is supported by rollback; others surface a conflict. */
  readonly kind: "file" | "symlink" | "dir" | "other";
}

/** Result of {@link FsSeam.read}. Distinguishes "file did not exist" from "file existed". */
export type FsReadResult =
  | { readonly existed: true; readonly bytes: Uint8Array; readonly stat: FsStat }
  | { readonly existed: false };

/**
 * Filesystem seam used by {@link createFsRollbackMiddleware} to snapshot
 * and restore the single target path. Production code uses a Bun-backed
 * default; tests inject a mock that records calls.
 *
 * `stat` returns `undefined` when the file does not currently exist (used
 * by rollback to detect "the tool created a file we didn't snapshot").
 *
 * `atomicWrite` writes `bytes` to a sibling temp file, fsyncs, then
 * renames over `path`. Atomicity matters at restore time: a short-write
 * or crash mid-restore would otherwise corrupt the only copy of the
 * pre-tool data. The default seam implements this via O_TRUNC sibling +
 * `rename`. Mocks may alias it to a plain write.
 */
export interface FsSeam {
  read(path: string): Promise<FsReadResult>;
  stat(path: string): Promise<FsStat | undefined>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  atomicWrite(path: string, bytes: Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Configuration for {@link createFsRollbackMiddleware}. */
export interface FsRollbackConfig {
  /**
   * Tool ids that should be wrapped with snapshot/restore. Default:
   * `["fs_write", "fs_edit"]`.
   *
   * **Contract**: each protected tool MUST mutate at most the single file
   * named in `request.input.path`. This middleware only snapshots that one
   * path and cannot roll back side effects elsewhere. Tools that may touch
   * multiple files (e.g. `Bash`) are out of scope and will leave partial
   * state on failure if listed here.
   */
  readonly protectedTools?: readonly string[] | undefined;
  /** Working directory used to resolve relative `path` inputs. Default: `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** Optional seam — replaces the real Bun-backed fs runner. Tests inject a mock here. */
  readonly fs?: FsSeam | undefined;
}

/** Handle returned by {@link createFsRollbackMiddleware}. */
export interface FsRollbackHandle {
  readonly middleware: KoiMiddleware;
}
