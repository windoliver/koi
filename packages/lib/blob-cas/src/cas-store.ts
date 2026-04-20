/**
 * Content-addressed storage (CAS) for file blobs.
 *
 * Layout (sharded for filesystem performance with many blobs):
 *   <blobDir>/<first-2-hex-of-hash>/<full-sha256-hex>
 *
 * Operations:
 *   - `hasBlob(hash)`     — does the blob already exist?
 *   - `writeBlobFromFile` — stream-hash a source file, write the blob if new,
 *                            return the hash. Idempotent: writing the same
 *                            content twice is a no-op.
 *   - `readBlob(hash)`    — read a blob's bytes back
 *
 * Hashing is streaming via `Bun.CryptoHasher` so memory stays bounded
 * regardless of file size — per design review issue 15A.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const HASH_HEX_LEN = 64; // SHA-256 hex
const HASH_SHARD_LEN = 2;

/**
 * Directory fsync. On Linux/macOS (the primary targets) a successful
 * `fsync(dir_fd)` after a rename guarantees the rename is durable past
 * power loss. Some platforms (notably Windows) don't support directory
 * fsync and report a specific error code; those are swallowed. REAL I/O
 * errors (EIO, ENOSPC, EDQUOT, etc.) propagate — a silent return on those
 * would let callers mark artifact metadata durable when the rename hasn't
 * actually landed on stable storage.
 */
// Only swallow codes that genuinely indicate the kernel/filesystem doesn't
// support fsync on a directory fd:
//   - ENOSYS: syscall not implemented (rare, some minimal kernels)
//   - EINVAL: some Linux filesystems return this for fsync(dir_fd)
// EACCES/EPERM/EIO/ENOSPC etc. are REAL failures and must propagate so the
// caller doesn't publish blob_ready=1 against a non-durable rename.
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(["ENOSYS", "EINVAL"]);

function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== undefined && DIR_FSYNC_UNSUPPORTED_CODES.has(code)) return;
    throw err;
  }
  try {
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== undefined && DIR_FSYNC_UNSUPPORTED_CODES.has(code)) {
      // Platform doesn't support fsync on the directory — tolerate.
    } else {
      throw err;
    }
  } finally {
    closeSync(fd);
  }
}

function writeAndFsync(tmpPath: string, data: Uint8Array): void {
  const fd = openSync(tmpPath, "w");
  try {
    let written = 0;
    while (written < data.byteLength) {
      written += writeSync(fd, data, written, data.byteLength - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Compute the on-disk path for a blob with the given hash.
 *
 * Exported so tests and the (future) restore protocol can locate blobs
 * without going through `readBlob`.
 */
export function blobPath(blobDir: string, hash: string): string {
  return join(blobDir, hash.slice(0, HASH_SHARD_LEN), hash);
}

/**
 * Check whether a blob with the given hash already exists in the CAS.
 */
export function hasBlob(blobDir: string, hash: string): boolean {
  if (hash.length !== HASH_HEX_LEN) return false;
  try {
    statSync(blobPath(blobDir, hash));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stream-hash a source file and write it to the CAS keyed by its content
 * hash. Returns the hex hash. Memory bound: ~64 KiB regardless of file size.
 *
 * If the blob already exists in the CAS (someone else wrote the same
 * content), this is a cheap no-op — the source file is hashed but no copy
 * is performed. Idempotent on repeat calls.
 *
 * Throws if the source path does not exist (caller is responsible for
 * `await fileExists` before calling).
 */
export async function writeBlobFromFile(blobDir: string, sourcePath: string): Promise<string> {
  // Read the source ONCE, feeding bytes into both the hasher and the tmp
  // file in a single pass. This guarantees the stored blob always matches
  // the returned hash — a two-pass approach could race an external writer
  // modifying the source between passes and store bytes that don't match
  // the declared hash, violating CAS integrity.
  const tmpDir = join(blobDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpName = `incoming.${process.pid}.${crypto.randomUUID()}`;
  const tmp = join(tmpDir, tmpName);

  const hasher = new Bun.CryptoHasher("sha256");
  const file = Bun.file(sourcePath);

  // Stream source → (hasher, tmpFd) simultaneously.
  const tmpFd = openSync(tmp, "w");
  try {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
        let written = 0;
        while (written < value.byteLength) {
          written += writeSync(tmpFd, value, written, value.byteLength - written);
        }
      }
    } finally {
      reader.releaseLock();
    }
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }

  const hash = hasher.digest("hex");

  // CAS dedup: if the blob already exists, drop the tmp and return.
  // Use sync unlink — `Bun.file(tmp).unlink()` returns a Promise whose
  // rejection would escape the surrounding sync try/catch and surface as
  // "Unhandled error between tests" in bun:test.
  if (hasBlob(blobDir, hash)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return hash;
  }

  const targetDir = join(blobDir, hash.slice(0, HASH_SHARD_LEN));
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, hash);

  try {
    renameSync(tmp, target);
  } catch (err) {
    // Concurrent-identical-writer collision: on platforms where rename-over-
    // existing fails, recover by checking the target and treating a hash-
    // match as successful dedup (CAS guarantees identical bytes for the
    // same hash). fsync the parent dir so our return is durable regardless
    // of whether the winner has already done it.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (hasBlob(blobDir, hash)) {
      fsyncDirectory(targetDir);
      return hash;
    }
    throw err;
  }

  // fsync the parent directory so the rename itself is durable.
  fsyncDirectory(targetDir);

  return hash;
}

/**
 * Hash in-memory bytes and write them to the CAS. Returns the hex hash.
 *
 * Idempotent: if the blob already exists in the CAS, this is a no-op on disk —
 * the bytes are hashed but no copy is performed. Atomic rename ensures no
 * partial blobs are ever visible.
 */
export async function writeBlobFromBytes(blobDir: string, data: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const hash = hasher.digest("hex");

  if (hasBlob(blobDir, hash)) {
    return hash;
  }

  const targetDir = join(blobDir, hash.slice(0, HASH_SHARD_LEN));
  mkdirSync(targetDir, { recursive: true });

  const target = join(targetDir, hash);
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomUUID()}`;

  // fsync-before-rename gives crash durability: the target path either
  // resolves to the fully-written blob or to nothing (ENOENT).
  writeAndFsync(tmp, data);

  try {
    renameSync(tmp, target);
  } catch (err) {
    // Publish collision: another concurrent writer may have published the
    // same hash after our hasBlob check but before our rename. On platforms
    // where rename-over-existing fails (Windows, some FUSE), recover by
    // checking the target and treating a hash-match as successful dedup.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (hasBlob(blobDir, hash)) {
      // A concurrent identical writer won. Their bytes are durable (CAS
      // guarantees content equality by hash). BUT the winner may not yet
      // have run its parent-directory fsync — if we return now and the
      // caller flips blob_ready=1, a power loss between rename and winner's
      // dir-fsync could lose the rename. Perform the dir-fsync ourselves
      // before declaring success so our return is always safely durable.
      fsyncDirectory(targetDir);
      return hash;
    }
    throw err;
  }

  // fsync the parent directory so the rename itself is durable.
  fsyncDirectory(targetDir);

  return hash;
}

/**
 * Read a blob's bytes back from the CAS. Returns `undefined` if the blob
 * does not exist.
 */
export async function readBlob(blobDir: string, hash: string): Promise<Uint8Array | undefined> {
  if (!hasBlob(blobDir, hash)) return undefined;
  const file = Bun.file(blobPath(blobDir, hash));
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}
