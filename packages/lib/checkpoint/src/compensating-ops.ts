/**
 * Compensating ops — pure functions that compute the file-system operations
 * needed to undo a sequence of `FileOpRecord`s, plus the helper that applies
 * those ops to disk.
 *
 * Inversion table:
 *   create(post=A)         →  delete file
 *   edit(pre=A, post=B)    →  restore file to A
 *   delete(pre=A)          →  restore file to A
 *
 * The application order matters when the same path is touched by multiple
 * ops. Compensating ops are applied in reverse `eventIndex` order — the
 * newest op is undone first, the oldest last. Because `eventIndex` is
 * monotonic across the entire session, this works across snapshots without
 * any per-snapshot reasoning.
 *
 * The application step is **idempotent**: re-running the same set of ops
 * after a partial failure converges on the target state. This is what makes
 * the four-step restore protocol crash-safe without 2PC (#1625 issue 9A).
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompensatingOp, FileOpRecord, FileSystemBackend, SnapshotNode } from "@koi/core";
import { hasBlob, readBlob } from "./cas-store.js";
import type { CheckpointPayload } from "./types.js";

/**
 * Convert a single `FileOpRecord` into the compensating op that undoes it.
 *
 * Pure function — does not touch the filesystem.
 */
export function toCompensating(op: FileOpRecord): CompensatingOp {
  const backendField = op.backend !== undefined ? { backend: op.backend } : {};
  switch (op.kind) {
    case "create":
      return { kind: "delete", path: op.path, ...backendField };
    case "edit":
      return { kind: "restore", path: op.path, contentHash: op.preContentHash, ...backendField };
    case "delete":
      return { kind: "restore", path: op.path, contentHash: op.preContentHash, ...backendField };
  }
}

/**
 * Compute the full list of compensating ops needed to undo every file op
 * across a sequence of snapshots, ordered from newest to oldest by event
 * index. This is the order in which the ops should be applied to the
 * filesystem.
 *
 * Input: the snapshots between the current head and the rewind target,
 * in any order. Order is determined by the `eventIndex` on each FileOpRecord.
 *
 * Output: compensating ops in reverse event-index order — newest op
 * undone first.
 */
export function computeCompensatingOps(
  snapshotsToUndo: readonly SnapshotNode<CheckpointPayload>[],
): readonly CompensatingOp[] {
  const allOps: FileOpRecord[] = [];
  for (const snapshot of snapshotsToUndo) {
    for (const op of snapshot.data.fileOps) {
      allOps.push(op);
    }
  }
  // Sort newest-first by eventIndex. Stable sort isn't required because
  // eventIndex is unique within a session.
  allOps.sort((a, b) => b.eventIndex - a.eventIndex);
  return allOps.map(toCompensating);
}

/**
 * Result of applying a single compensating op. Used by the crash-injection
 * harness to assert convergence after partial failures.
 */
export type ApplyResult =
  | { readonly kind: "applied"; readonly path: string }
  | { readonly kind: "skipped-already-current"; readonly path: string }
  | { readonly kind: "skipped-missing-blob"; readonly path: string; readonly contentHash: string }
  | { readonly kind: "error"; readonly path: string; readonly cause: unknown };

/**
 * Apply compensating ops to disk, in order. Idempotent: re-running converges
 * on the target state.
 *
 * Each restore op:
 *   1. If the target file already has content matching `contentHash`, skip.
 *   2. Otherwise, read the blob from CAS and write it via tmp + atomic rename.
 *
 * Each delete op:
 *   1. unlink the path. Missing file is fine — already deleted.
 *
 * When `backends` is provided, ops that carry a `backend` field (and are NOT
 * "local") are dispatched to the matching `FileSystemBackend` entry rather than
 * using direct local I/O. Falls back to local I/O when:
 *   - `backends` is not provided, or
 *   - the op has no `backend` field, or
 *   - `op.backend` is `"local"`, or
 *   - the backend name is not present in the map.
 *
 * Errors on individual ops are surfaced in the result list rather than
 * thrown, so a partial failure can be inspected and re-tried. The caller
 * decides whether to abort the restore based on the results.
 */
export async function applyCompensatingOps(
  ops: readonly CompensatingOp[],
  blobDir: string,
  backends?: ReadonlyMap<string, FileSystemBackend>,
): Promise<readonly ApplyResult[]> {
  const results: ApplyResult[] = [];

  for (const op of ops) {
    const backend = resolveBackend(op.backend, backends);

    if (op.kind === "delete") {
      if (backend !== undefined) {
        results.push(await applyDeleteViaBackend(backend, op.path));
      } else {
        results.push(applyDelete(op.path));
      }
      continue;
    }
    // restore
    if (backend !== undefined) {
      results.push(await applyRestoreViaBackend(backend, blobDir, op.path, op.contentHash));
    } else {
      results.push(await applyRestore(blobDir, op.path, op.contentHash));
    }
  }

  return results;
}

/**
 * Resolve the optional `FileSystemBackend` for an op. Returns `undefined` when
 * local I/O should be used.
 */
function resolveBackend(
  backendName: string | undefined,
  backends: ReadonlyMap<string, FileSystemBackend> | undefined,
): FileSystemBackend | undefined {
  if (backends === undefined || backendName === undefined || backendName === "local") {
    return undefined;
  }
  return backends.get(backendName);
}

function applyDelete(path: string): ApplyResult {
  try {
    unlinkSync(path);
    return { kind: "applied", path };
  } catch (cause: unknown) {
    // ENOENT = file already gone, which is the desired post-state. Idempotent.
    if (isNotFound(cause)) {
      return { kind: "skipped-already-current", path };
    }
    return { kind: "error", path, cause };
  }
}

async function applyRestore(
  blobDir: string,
  path: string,
  contentHash: string,
): Promise<ApplyResult> {
  // Idempotent shortcut: if the file already matches the target content,
  // skip the restore. Cheap check that avoids re-writing huge files on
  // partial-restore retries.
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      const hasher = new Bun.CryptoHasher("sha256");
      const reader = file.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
        }
      } finally {
        reader.releaseLock();
      }
      if (hasher.digest("hex") === contentHash) {
        return { kind: "skipped-already-current", path };
      }
    }
  } catch {
    // If the existence check or hash fails, fall through to the full
    // restore path — it will surface a real error if there is one.
  }

  // Need to actually write the blob.
  if (!hasBlob(blobDir, contentHash)) {
    return { kind: "skipped-missing-blob", path, contentHash };
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBlob(blobDir, contentHash);
  } catch (cause: unknown) {
    return { kind: "error", path, cause };
  }
  if (bytes === undefined) {
    return { kind: "skipped-missing-blob", path, contentHash };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
    return { kind: "applied", path };
  } catch (cause: unknown) {
    return { kind: "error", path, cause };
  }
}

async function applyDeleteViaBackend(
  backend: FileSystemBackend,
  path: string,
): Promise<ApplyResult> {
  if (backend.delete === undefined) {
    // Backend does not support delete — fall back to local unlink.
    return applyDelete(path);
  }
  try {
    const result = await backend.delete(path);
    if (!result.ok) {
      // Treat "not found" as idempotent success.
      if (result.error.code === "NOT_FOUND") {
        return { kind: "skipped-already-current", path };
      }
      return { kind: "error", path, cause: result.error };
    }
    return { kind: "applied", path };
  } catch (cause: unknown) {
    return { kind: "error", path, cause };
  }
}

async function applyRestoreViaBackend(
  backend: FileSystemBackend,
  blobDir: string,
  path: string,
  contentHash: string,
): Promise<ApplyResult> {
  if (!hasBlob(blobDir, contentHash)) {
    return { kind: "skipped-missing-blob", path, contentHash };
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBlob(blobDir, contentHash);
  } catch (cause: unknown) {
    return { kind: "error", path, cause };
  }
  if (bytes === undefined) {
    return { kind: "skipped-missing-blob", path, contentHash };
  }

  try {
    // FileSystemBackend.write accepts a string; decode bytes as UTF-8.
    const content = new TextDecoder().decode(bytes);
    const result = await backend.write(path, content, { createDirectories: true, overwrite: true });
    if (!result.ok) {
      return { kind: "error", path, cause: result.error };
    }
    return { kind: "applied", path };
  } catch (cause: unknown) {
    return { kind: "error", path, cause };
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}
