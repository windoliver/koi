/**
 * Pluggable blob storage contract + default filesystem implementation.
 *
 * CONSISTENCY REQUIREMENT: after put(h) resolves, every subsequent has(h) /
 * get(h) / list() MUST reflect its presence. After delete(h) resolves, every
 * subsequent has(h) / get(h) / list() MUST reflect its absence. Read-after-
 * write consistency is required; eventually-consistent backends are not
 * supported. Save-repair and startup recovery in @koi/artifacts rely on this.
 *
 * The FS impl meets this via fsync-then-rename in cas-store.ts. The S3 impl
 * in @koi/artifacts-s3 (Plan 5) meets it via S3's strong read-after-write
 * consistency (global since Dec 2020).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { blobPath, hasBlob, readBlob, writeBlobFromBytes } from "./cas-store.js";

/**
 * Backend-agnostic store-id sentinel (spec §3.0 Layer 2). The sentinel is a
 * well-known blob at the backend root that pairs the metadata DB with the
 * blob backend by UUID. Filesystem backends write `<blobDir>/.store-id`;
 * remote backends (S3, etc.) use a backend-native analogue (e.g.
 * `<prefix>/__store_id__`).
 *
 * `readStoreId()` returns `undefined` when the sentinel is absent (first
 * open). `writeStoreId(uuid)` is idempotent (overwrites any existing value)
 * and must be durable — after it resolves, a subsequent readStoreId() on
 * a fresh process must observe the new value.
 */
export interface StoreIdSentinel {
  readonly readStoreId: () => Promise<string | undefined>;
  readonly writeStoreId: (uuid: string) => Promise<void>;
}

export interface BlobStore {
  readonly put: (data: Uint8Array) => Promise<string>;
  readonly get: (hash: string) => Promise<Uint8Array | undefined>;
  readonly has: (hash: string) => Promise<boolean>;
  readonly delete: (hash: string) => Promise<boolean>;
  readonly list: () => AsyncIterable<string>;
  /**
   * Optional: backend-native store-id sentinel. Every built-in factory
   * (`createFilesystemBlobStore`, `createS3BlobStore`) populates this so
   * `@koi/artifacts` can pair DB ↔ backend without assuming a filesystem.
   * Third-party `BlobStore`s that omit it cannot be used with
   * `createArtifactStore`.
   */
  readonly sentinel?: StoreIdSentinel;
}

/**
 * Create a BlobStore backed by the filesystem CAS layout (sharded by the
 * first two hex chars of the SHA-256 hash).
 */
export function createFilesystemBlobStore(blobDir: string): BlobStore {
  return {
    put: (data) => writeBlobFromBytes(blobDir, data),
    get: (hash) => readBlob(blobDir, hash),
    has: (hash) => Promise.resolve(hasBlob(blobDir, hash)),
    delete: (hash) => deleteBlob(blobDir, hash),
    list: () => listBlobs(blobDir),
    sentinel: createFilesystemSentinel(blobDir),
  };
}

const SENTINEL_FILENAME = ".store-id";
const SENTINEL_TMP_PREFIX = ".store-id.tmp";

/**
 * Build the filesystem-backed `StoreIdSentinel`. Reads `<blobDir>/.store-id`
 * verbatim (no format validation — callers enforce UUID shape). Writes via
 * tmp + fsync + rename + fsync-dir so the sentinel is durable past power
 * loss, matching the atomic-publish contract used elsewhere in the CAS.
 */
function createFilesystemSentinel(blobDir: string): StoreIdSentinel {
  return {
    readStoreId: async () => readSentinelFromFs(blobDir),
    writeStoreId: async (uuid) => writeSentinelToFs(blobDir, uuid),
  };
}

function readSentinelFromFs(blobDir: string): string | undefined {
  const path = join(blobDir, SENTINEL_FILENAME);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8").trim();
  return content === "" ? undefined : content;
}

/**
 * Durably write the sentinel file via tmp + fsync + rename + fsync-dir.
 * Atomic replace guarantees the final pathname resolves to either the old
 * complete contents or the new complete contents — never a torn partial —
 * and fsync at each step guarantees durability under power loss.
 */
function writeSentinelToFs(blobDir: string, id: string): void {
  const target = join(blobDir, SENTINEL_FILENAME);
  const tmp = join(blobDir, `${SENTINEL_TMP_PREFIX}.${process.pid}.${crypto.randomUUID()}`);
  const data = new TextEncoder().encode(id);

  const fd = openSync(tmp, "w");
  try {
    let written = 0;
    while (written < data.byteLength) {
      written += writeSync(fd, data, written, data.byteLength - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }

  // fsync the parent directory so the rename itself is durable. Only swallow
  // known-unsupported codes (ENOSYS/EINVAL on platforms that don't support
  // dir fsync). Real I/O / permission errors propagate so bootstrap doesn't
  // report a paired store_id when the sentinel rename isn't durable.
  let dirFd: number;
  try {
    dirFd = openSync(blobDir, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOSYS" || code === "EINVAL") return;
    throw err;
  }
  try {
    fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOSYS" || code === "EINVAL") {
      // Platform doesn't support fsync on directories — tolerate.
    } else {
      throw err;
    }
  } finally {
    closeSync(dirFd);
  }
}

const HASH_SHARD_LEN = 2;
const HASH_HEX_LEN = 64;

async function deleteBlob(blobDir: string, hash: string): Promise<boolean> {
  if (hash.length !== HASH_HEX_LEN) return false;
  const path = blobPath(blobDir, hash);
  try {
    await Bun.file(path).unlink?.();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

async function* listBlobs(blobDir: string): AsyncIterable<string> {
  let shardDirs: readonly string[];
  try {
    shardDirs = readdirSync(blobDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  for (const shard of shardDirs) {
    if (shard.length !== HASH_SHARD_LEN) continue;
    const shardPath = join(blobDir, shard);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(shardPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: readonly string[];
    try {
      entries = readdirSync(shardPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.length === HASH_HEX_LEN && /^[0-9a-f]+$/.test(name)) {
        yield name;
      }
    }
  }
}
