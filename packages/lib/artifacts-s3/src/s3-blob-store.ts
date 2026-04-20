/**
 * S3-backed `BlobStore` implementation.
 *
 * Key layout mirrors the filesystem CAS impl in `@koi/blob-cas`:
 *
 *   <prefix>/<first-2-hex-of-hash>/<full-sha256-hex>
 *
 * With an empty prefix, the key starts at `<shard>/<hash>` (no leading slash) —
 * S3 keys are not paths and a leading slash would create an empty-segment
 * component that is legal but surprising.
 *
 * Consistency: relies on S3's strong read-after-write consistency (global
 * since Dec 2020) to satisfy the `BlobStore` contract — after `put(h)`
 * resolves, `has(h)` / `get(h)` must reflect its presence.
 *
 * List is implemented in a sibling file (Task 3) once pagination is added.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BlobStore, StoreIdSentinel } from "@koi/blob-cas";
import type { S3BlobStoreConfig } from "./config.js";
import { validateS3BlobStoreConfig } from "./config.js";

/**
 * Sentinel key for the store-id pairing blob (spec §3.0 Layer 2). Chosen so
 * it cannot collide with any content-addressed blob: the CAS layout is
 * `<shard>/<hash>` (shard = 2 hex chars), and `__store_id__` is neither a
 * 2-char hex shard nor a 64-char hex hash — list() already filters it out.
 */
const STORE_ID_SENTINEL_KEY = "__store_id__";

const HASH_SHARD_LEN = 2;
const HASH_HEX_LEN = 64;
const HASH_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Compute the S3 key for a blob under the configured prefix.
 *
 * Empty prefix → `<shard>/<hash>` (no leading slash). Non-empty prefix →
 * `<prefix>/<shard>/<hash>`. The prefix has already been validated at
 * construction time to lack leading/trailing `/`.
 */
function blobKey(prefix: string, hash: string): string {
  const shard = hash.slice(0, HASH_SHARD_LEN);
  if (prefix === "") return `${shard}/${hash}`;
  return `${prefix}/${shard}/${hash}`;
}

/**
 * Hex-encode an ArrayBuffer. Used for SHA-256 digest → lowercase hex string.
 */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bytes[i] is guaranteed in bounds
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

/**
 * Detect whether an unknown error is an AWS SDK error with the given `name`
 * (used for `NoSuchKey`, `NotFound`, etc — the SDK's 404 classifiers).
 */
function hasErrorName(err: unknown, name: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { readonly name: unknown }).name === name
  );
}

function createClient(config: S3BlobStoreConfig): S3Client {
  return new S3Client({
    region: config.region,
    credentials: config.credentials,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
  });
}

/**
 * Create a `BlobStore` backed by AWS S3 (or an S3-compatible store — MinIO,
 * Cloudflare R2, etc. via `endpoint` + `forcePathStyle`).
 *
 * Config is validated synchronously at construction — misconfigured
 * credentials or bucket names are programmer errors that must surface
 * immediately, not at save time.
 */
export function createS3BlobStore(config: S3BlobStoreConfig): BlobStore {
  validateS3BlobStoreConfig(config);
  const client = createClient(config);
  const bucket = config.bucket;
  const prefix = config.prefix ?? "";

  async function put(data: Uint8Array): Promise<string> {
    const hash = await sha256Hex(data);
    try {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: blobKey(prefix, hash), Body: data }),
      );
    } catch (err) {
      throw new Error(`S3 put failed for blob ${hash}`, { cause: err });
    }
    return hash;
  }

  async function get(hash: string): Promise<Uint8Array | undefined> {
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: blobKey(prefix, hash) }),
      );
      if (response.Body === undefined) {
        throw new Error(`S3 get returned no Body for blob ${hash}`);
      }
      // Body is an SdkStream (Node Readable or web ReadableStream) with a
      // transformToByteArray() helper mixed in by the SDK.
      const body = response.Body as { readonly transformToByteArray: () => Promise<Uint8Array> };
      return new Uint8Array(await body.transformToByteArray());
    } catch (err) {
      if (hasErrorName(err, "NoSuchKey")) return undefined;
      throw new Error(`S3 get failed for blob ${hash}`, { cause: err });
    }
  }

  async function has(hash: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: blobKey(prefix, hash) }));
      return true;
    } catch (err) {
      // HeadObject returns `NotFound` (not `NoSuchKey`) for missing keys —
      // keep both to tolerate SDK / compatible-store variance.
      if (hasErrorName(err, "NotFound") || hasErrorName(err, "NoSuchKey")) return false;
      throw new Error(`S3 has failed for blob ${hash}`, { cause: err });
    }
  }

  async function deleteBlob(hash: string): Promise<boolean> {
    // BlobStore contract requires `delete(missing) → false` and
    // `delete(present) → true`. S3 DeleteObject is idempotent (returns 204
    // regardless of prior existence), so we HEAD first to distinguish. The
    // extra round-trip is the cost of contract compliance — matches the FS
    // impl's ENOENT branch in @koi/blob-cas.
    const key = blobKey(prefix, hash);
    const existed = await has(hash);
    if (!existed) return false;
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err) {
      throw new Error(`S3 delete failed for blob ${hash}`, { cause: err });
    }
  }

  // List scope: configured prefix only. A non-empty prefix ships with a
  // trailing `/` so siblings (e.g. `tenant-a/blobs-other/...`) aren't matched.
  // Empty prefix omits the Prefix parameter entirely (lists bucket root).
  const listPrefix = prefix === "" ? undefined : `${prefix}/`;

  /**
   * Extract the hash from an S3 key if it matches the sharded CAS layout.
   * Returns undefined for anything else (sentinels, malformed keys, non-hex).
   *
   * Layout: `<prefix>/<shard>/<hash>` (or `<shard>/<hash>` with empty prefix).
   * The shard MUST equal the first 2 chars of the hash and the hash MUST
   * be 64 lowercase hex chars. Anything else is filtered out.
   */
  function extractHash(key: string): string | undefined {
    const stripped = listPrefix === undefined ? key : key.slice(listPrefix.length);
    const parts = stripped.split("/");
    if (parts.length !== 2) return undefined;
    const [shard, hash] = parts;
    if (shard === undefined || hash === undefined) return undefined;
    if (shard.length !== HASH_SHARD_LEN) return undefined;
    if (hash.length !== HASH_HEX_LEN) return undefined;
    if (!HASH_HEX_REGEX.test(hash)) return undefined;
    if (hash.slice(0, HASH_SHARD_LEN) !== shard) return undefined;
    return hash;
  }

  async function* list(): AsyncGenerator<string> {
    // `let` is required: ContinuationToken threads through pages. Per-page
    // yield (not per-page batch) means breaking the consumer loop doesn't
    // prefetch the next page.
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ...(listPrefix !== undefined ? { Prefix: listPrefix } : {}),
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (obj.Key === undefined) continue;
        const hash = extractHash(obj.Key);
        if (hash !== undefined) yield hash;
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  }

  // Store-id sentinel (spec §3.0). Lives at `<prefix>/__store_id__` (or
  // `__store_id__` with an empty prefix). Uses PutObject for writes and
  // GetObject for reads — S3's strong read-after-write consistency makes the
  // sentinel durable the moment `writeStoreId` resolves.
  //
  // S3's durability model: PutObject 200 OK guarantees the object is written
  // to multiple AZs before the API returns, and post-Dec-2020 read-after-write
  // consistency guarantees any subsequent GetObject on a fresh process
  // observes the new value. No client-side fsync needed — the FS impl's
  // fsync+rename discipline is replaced by the SDK's acknowledgement of
  // durable commit, satisfying the `StoreIdSentinel.writeStoreId` contract.
  const sentinelKey = prefix === "" ? STORE_ID_SENTINEL_KEY : `${prefix}/${STORE_ID_SENTINEL_KEY}`;

  const sentinel: StoreIdSentinel = {
    readStoreId: async () => {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: sentinelKey }),
        );
        if (response.Body === undefined) return undefined;
        const body = response.Body as { readonly transformToByteArray: () => Promise<Uint8Array> };
        const bytes = await body.transformToByteArray();
        return new TextDecoder().decode(bytes);
      } catch (err) {
        if (hasErrorName(err, "NoSuchKey") || hasErrorName(err, "NotFound")) return undefined;
        throw new Error("S3 get failed for store-id sentinel", { cause: err });
      }
    },
    writeStoreId: async (uuid: string) => {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: sentinelKey,
            Body: new TextEncoder().encode(uuid),
          }),
        );
      } catch (err) {
        throw new Error("S3 put failed for store-id sentinel", { cause: err });
      }
    },
  };

  return {
    put,
    get,
    has,
    delete: deleteBlob,
    list,
    sentinel,
  };
}
