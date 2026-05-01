/**
 * Atomic PRD write helpers: durable temp-write, CAS check, rename, and
 * parent-directory fsync. Extracted from prd-store.ts so the read-side
 * (parse + validate) and the write-side (durability + concurrency) live
 * in cohesive modules.
 */

import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { conflict, internal } from "@koi/core";
import { extractMessage } from "@koi/errors";
import type { PRDFile } from "./types.js";

/**
 * Atomic write with optimistic concurrency control: re-reads the file just
 * before rename and refuses if its bytes differ from `originalRaw`. Returns
 * CONFLICT on a lost-update race (another writer wrote in between), giving
 * the caller a chance to retry against the new state instead of silently
 * overwriting it.
 */
export async function writePRDIfUnchanged(
  path: string,
  originalRaw: string,
  newPrd: PRDFile,
): Promise<Result<void, KoiError>> {
  // Write tmp first, then re-read-and-check just before rename. This
  // narrows the TOCTOU window between the CAS check and the rename to a
  // single syscall — anything more than that requires real exclusion
  // (file locking) which is the deployment-layer's responsibility per
  // this module's documented contract.
  // Random suffix so two concurrent writers don't collide on the same
  // `${path}.tmp` and produce ENOENT instead of a clean CONFLICT.
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    // Crash-durable write: open + write + fsync + close on the tmp file
    // BEFORE rename. Bun.write() returns once the data is in the page
    // cache, not when it's on disk — a host crash between markDoneMany()
    // returning success and the kernel flushing would silently lose
    // committed completion state. fsync the data, then rename, then
    // fsync the parent directory to make the rename itself durable.
    await writeTmpDurable(tmpPath, newPrd);
    const casResult = await casCheck(path, originalRaw);
    if (!casResult.ok) return casResult;
    await rename(tmpPath, path);
    await fsyncParentDir(path);
    return { ok: true, value: undefined };
  } catch (e: unknown) {
    // All low-level FS faults (open, writeFile, sync, rename, dir-fsync)
    // are converted to a Result so callers can branch on r.ok instead of
    // having ENOSPC/EIO/EROFS surface as uncaught rejections — every
    // exported mutator declares Promise<Result<...>> and must honor it.
    return {
      ok: false,
      error: internal(`Failed to write PRD file at ${path}: ${extractMessage(e)}`, e),
    };
  } finally {
    // If we returned without renaming (CONFLICT, error, or success
    // path), make sure no tmp file is left behind.
    if (await Bun.file(tmpPath).exists()) {
      await Bun.file(tmpPath)
        .delete()
        .catch(() => undefined);
    }
  }
}

async function writeTmpDurable(tmpPath: string, newPrd: PRDFile): Promise<void> {
  const tmpHandle = await open(tmpPath, "w");
  try {
    await tmpHandle.writeFile(JSON.stringify(newPrd, null, 2));
    await tmpHandle.sync();
  } finally {
    await tmpHandle.close();
  }
}

async function casCheck(path: string, originalRaw: string): Promise<Result<void, KoiError>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return {
      ok: false,
      error: conflict(path, `PRD file disappeared between read and write: ${path}`),
    };
  }
  const currentRaw = await file.text();
  if (currentRaw !== originalRaw) {
    return {
      ok: false,
      error: conflict(
        path,
        `PRD file changed between read and write (concurrent writer detected): ${path}`,
      ),
    };
  }
  return { ok: true, value: undefined };
}

async function fsyncParentDir(path: string): Promise<void> {
  // fsync the parent directory so the rename's directory-entry update
  // is also durable. Without this, a crash after rename can leave the
  // file pointing at the OLD inode on next mount even though the new
  // bytes are safely on disk. Only swallow "operation unsupported"
  // codes (FUSE, network mounts); real I/O failures still propagate
  // through the outer catch and become INTERNAL Result errors.
  try {
    const dirHandle = await open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (e: unknown) {
    const code = (e as { readonly code?: unknown }).code;
    const unsupported =
      code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS" || code === "EPERM";
    if (!unsupported) throw e;
  }
}
