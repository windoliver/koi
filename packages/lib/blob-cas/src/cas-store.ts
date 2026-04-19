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
  writeSync,
} from "node:fs";
import { join } from "node:path";

const HASH_HEX_LEN = 64; // SHA-256 hex
const HASH_SHARD_LEN = 2;
const STREAM_CHUNK = 64 * 1024; // 64 KiB streaming reads

/**
 * Best-effort directory fsync. Some platforms (Windows) don't support fsync
 * on directories; those errors are swallowed since the Linux/macOS path is
 * the primary target. On Linux/macOS a successful `fsync(dir_fd)` after a
 * rename guarantees the rename is durable past power loss.
 */
function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort — not every platform supports dir fsync */
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
  // Stream-hash the source file via Bun.CryptoHasher.
  const file = Bun.file(sourcePath);
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
  const hash = hasher.digest("hex");

  // CAS dedup: if the blob already exists, we're done.
  if (hasBlob(blobDir, hash)) {
    return hash;
  }

  // Otherwise, copy the source bytes into the CAS via tmp + rename for atomicity.
  const targetDir = join(blobDir, hash.slice(0, HASH_SHARD_LEN));
  mkdirSync(targetDir, { recursive: true });

  const target = join(targetDir, hash);
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomUUID()}`;

  // Bun.file().arrayBuffer() reads the whole file into memory; for large
  // files we instead pipe via stream. We use the streaming pattern unless
  // the file is small enough to amortize the syscall cost.
  if (file.size < STREAM_CHUNK * 4) {
    // Small file: one read + write is cheaper than streaming setup. Write
    // via openSync/writeSync/fsync so the blob is crash-durable.
    const buf = await file.arrayBuffer();
    writeAndFsync(tmp, new Uint8Array(buf));
  } else {
    // Large file: stream chunks, then fsync the temp file.
    const handle = Bun.file(sourcePath);
    const writer = Bun.file(tmp).writer();
    const stream = handle.stream();
    const r = stream.getReader();
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        writer.write(value);
      }
      await writer.end();
    } finally {
      r.releaseLock();
    }
    // fsync the streamed temp file.
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  // Atomic rename onto the final path. If another process already wrote
  // the same hash between our hasBlob check and the rename, the rename
  // simply replaces an identical file (CAS guarantees content equality).
  try {
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup of the tmp file on rename failure.
    try {
      Bun.file(tmp).unlink?.();
    } catch {
      /* ignore */
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
    try {
      Bun.file(tmp).unlink?.();
    } catch {
      /* ignore */
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
