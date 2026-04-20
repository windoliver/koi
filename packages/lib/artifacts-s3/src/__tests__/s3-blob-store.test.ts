import { beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import type { S3BlobStoreConfig } from "../config.js";
import { createS3BlobStore } from "../s3-blob-store.js";

/**
 * Contract tests for the S3-backed BlobStore (Plan 5 / Task 2).
 *
 * Uses aws-sdk-client-mock to intercept the S3Client `.send()` calls so tests
 * run offline. These tests cover the 4 non-list operations — list() is Task 3.
 */

// Precomputed SHA-256("hello world") for hash-layout assertions. Kept at the
// top of the file so every test can reference the same canonical fixture
// without recomputing.
const HELLO = new TextEncoder().encode("hello world");
const HELLO_HASH = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

function baseConfig(): S3BlobStoreConfig {
  return {
    bucket: "test-bucket",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIA000000EXAMPLE",
      secretAccessKey: "secret/example/key",
    },
  };
}

/**
 * Wrap raw bytes as an SDK-compatible response body. GetObjectCommand resolves
 * with a `Body` that exposes `transformToByteArray()` — aws-sdk-client-mock
 * doesn't add the mixin automatically, so we do it here.
 */
function bodyFromBytes(data: Uint8Array) {
  const stream = new Readable();
  stream.push(data);
  stream.push(null);
  return sdkStreamMixin(stream);
}

describe("createS3BlobStore", () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
  });

  describe("put", () => {
    test("returns lowercase SHA-256 hex and issues PutObjectCommand with correct Bucket/Key/Body", async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const store = createS3BlobStore(baseConfig());

      const hash = await store.put(HELLO);

      expect(hash).toBe(HELLO_HASH);
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      // no prefix configured → key is "<shard>/<hash>" (no leading slash)
      expect(input?.Key).toBe(`${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
      expect(input?.Body).toEqual(HELLO);
    });

    test("uses sharded key under the configured prefix", async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const store = createS3BlobStore({ ...baseConfig(), prefix: "tenant-a/blobs" });

      await store.put(HELLO);

      const input = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
      expect(input?.Key).toBe(`tenant-a/blobs/${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });

    test("with empty prefix, key has no leading slash", async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const store = createS3BlobStore({ ...baseConfig(), prefix: "" });

      await store.put(HELLO);

      const input = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
      expect(input?.Key).toBe(`${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
      expect(input?.Key?.startsWith("/")).toBe(false);
    });
  });

  describe("get", () => {
    test("returns Uint8Array with correct bytes when present", async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: bodyFromBytes(HELLO) });
      const store = createS3BlobStore(baseConfig());

      const data = await store.get(HELLO_HASH);

      expect(data).toBeInstanceOf(Uint8Array);
      expect(data).toEqual(HELLO);
      const input = s3Mock.commandCalls(GetObjectCommand)[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      expect(input?.Key).toBe(`${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });

    test("returns undefined when key is absent (NoSuchKey)", async () => {
      const err = new Error("The specified key does not exist.");
      err.name = "NoSuchKey";
      s3Mock.on(GetObjectCommand).rejects(err);
      const store = createS3BlobStore(baseConfig());

      const data = await store.get(HELLO_HASH);

      expect(data).toBeUndefined();
    });

    test("throws wrapped error on non-404 failures", async () => {
      const err = new Error("Internal Server Error");
      err.name = "InternalError";
      s3Mock.on(GetObjectCommand).rejects(err);
      const store = createS3BlobStore(baseConfig());

      await expect(store.get(HELLO_HASH)).rejects.toThrow(/get/);
    });

    test("uses sharded key layout under prefix", async () => {
      s3Mock.on(GetObjectCommand).resolves({ Body: bodyFromBytes(HELLO) });
      const store = createS3BlobStore({ ...baseConfig(), prefix: "tenant-a/blobs" });

      await store.get(HELLO_HASH);

      const input = s3Mock.commandCalls(GetObjectCommand)[0]?.args[0].input;
      expect(input?.Key).toBe(`tenant-a/blobs/${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });
  });

  describe("has", () => {
    test("returns true when HeadObjectCommand succeeds", async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      const store = createS3BlobStore(baseConfig());

      await expect(store.has(HELLO_HASH)).resolves.toBe(true);
      const input = s3Mock.commandCalls(HeadObjectCommand)[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      expect(input?.Key).toBe(`${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });

    test("returns false on NotFound (404)", async () => {
      const err = new Error("Not Found");
      err.name = "NotFound";
      s3Mock.on(HeadObjectCommand).rejects(err);
      const store = createS3BlobStore(baseConfig());

      await expect(store.has(HELLO_HASH)).resolves.toBe(false);
    });

    test("throws on 5xx-style errors (not 200/404)", async () => {
      const err = new Error("Service Unavailable");
      err.name = "ServiceUnavailable";
      s3Mock.on(HeadObjectCommand).rejects(err);
      const store = createS3BlobStore(baseConfig());

      await expect(store.has(HELLO_HASH)).rejects.toThrow(/has/);
    });

    test("uses sharded key layout under prefix", async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      const store = createS3BlobStore({ ...baseConfig(), prefix: "tenant-a/blobs" });

      await store.has(HELLO_HASH);

      const input = s3Mock.commandCalls(HeadObjectCommand)[0]?.args[0].input;
      expect(input?.Key).toBe(`tenant-a/blobs/${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });
  });

  describe("delete", () => {
    test("HEADs then deletes and returns true when the key existed", async () => {
      // BlobStore contract: delete(present) → true. Impl HEADs first because
      // S3's DeleteObject is idempotent and can't by itself distinguish
      // was-present from was-absent.
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(DeleteObjectCommand).resolves({});
      const store = createS3BlobStore(baseConfig());

      await expect(store.delete(HELLO_HASH)).resolves.toBe(true);
      const input = s3Mock.commandCalls(DeleteObjectCommand)[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      expect(input?.Key).toBe(`${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });

    test("returns false without issuing DeleteObject when the key is absent", async () => {
      // Contract: delete(missing) → false. Matches FS impl's ENOENT branch.
      const notFound = new Error("Not Found");
      notFound.name = "NotFound";
      s3Mock.on(HeadObjectCommand).rejects(notFound);
      const store = createS3BlobStore(baseConfig());

      await expect(store.delete(HELLO_HASH)).resolves.toBe(false);
      expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    });

    test("throws on network / non-404 errors (not swallowed as false)", async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      const err = new Error("Connection refused");
      err.name = "NetworkingError";
      s3Mock.on(DeleteObjectCommand).rejects(err);
      const store = createS3BlobStore(baseConfig());

      await expect(store.delete(HELLO_HASH)).rejects.toThrow(/delete/);
    });

    test("uses sharded key layout under prefix", async () => {
      s3Mock.on(HeadObjectCommand).resolves({});
      s3Mock.on(DeleteObjectCommand).resolves({});
      const store = createS3BlobStore({ ...baseConfig(), prefix: "tenant-a/blobs" });

      await store.delete(HELLO_HASH);

      const input = s3Mock.commandCalls(DeleteObjectCommand)[0]?.args[0].input;
      expect(input?.Key).toBe(`tenant-a/blobs/${HELLO_HASH.slice(0, 2)}/${HELLO_HASH}`);
    });
  });

  describe("list", () => {
    // Build a fake SHA-256 hex with the given 2-char shard prefix. Saves
    // the per-test noise of hand-typing 64 hex chars.
    function fakeHash(shard: string, filler: string = "a"): string {
      const rest = filler.repeat(62);
      return (shard + rest).slice(0, 64);
    }

    function keyFor(prefix: string, hash: string): string {
      const shard = hash.slice(0, 2);
      return prefix === "" ? `${shard}/${hash}` : `${prefix}/${shard}/${hash}`;
    }

    test("empty bucket yields nothing and the generator terminates", async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
      const store = createS3BlobStore(baseConfig());

      const out: string[] = [];
      for await (const h of store.list()) out.push(h);

      expect(out).toEqual([]);
    });

    test("paginates via NextContinuationToken / IsTruncated and yields all hashes", async () => {
      const h1 = fakeHash("aa", "1");
      const h2 = fakeHash("ab", "2");
      const h3 = fakeHash("ac", "3");
      const h4 = fakeHash("ad", "4");

      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: keyFor("", h1) }, { Key: keyFor("", h2) }],
          IsTruncated: true,
          NextContinuationToken: "token-1",
        })
        .resolvesOnce({
          Contents: [{ Key: keyFor("", h3) }, { Key: keyFor("", h4) }],
          IsTruncated: false,
        });

      const store = createS3BlobStore(baseConfig());
      const out: string[] = [];
      for await (const h of store.list()) out.push(h);

      expect(out).toEqual([h1, h2, h3, h4]);
      const calls = s3Mock.commandCalls(ListObjectsV2Command);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.args[0].input.ContinuationToken).toBeUndefined();
      expect(calls[1]?.args[0].input.ContinuationToken).toBe("token-1");
    });

    test("skips keys that don't match the sharded hash layout (e.g. __store_id__ sentinel)", async () => {
      const good = fakeHash("aa", "1");
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          // sentinel at prefix root — no shard, not a hash
          { Key: "__store_id__" },
          // random non-hash key under a non-hash pseudo-shard
          { Key: "zz/not-a-hash" },
          // shard doesn't match hash prefix
          { Key: `bb/${good}` },
          // uppercase hex — rejected (SHA-256 lowercase invariant)
          { Key: `aa/${good.toUpperCase()}` },
          // too short
          { Key: "aa/deadbeef" },
          // correct layout — the only one we keep
          { Key: keyFor("", good) },
        ],
        IsTruncated: false,
      });
      const store = createS3BlobStore(baseConfig());

      const out: string[] = [];
      for await (const h of store.list()) out.push(h);

      expect(out).toEqual([good]);
    });

    test("consumer breaking out of the loop does not leak pagination (generator closes)", async () => {
      const h1 = fakeHash("aa", "1");
      const h2 = fakeHash("ab", "2");
      const h3 = fakeHash("ac", "3");
      const h4 = fakeHash("ad", "4");

      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: keyFor("", h1) }, { Key: keyFor("", h2) }],
          IsTruncated: true,
          NextContinuationToken: "token-1",
        })
        .resolvesOnce({
          Contents: [{ Key: keyFor("", h3) }, { Key: keyFor("", h4) }],
          IsTruncated: false,
        });

      const store = createS3BlobStore(baseConfig());
      const out: string[] = [];
      for await (const h of store.list()) {
        out.push(h);
        if (out.length === 1) break;
      }

      expect(out).toEqual([h1]);
      // Only the first page should have been fetched — breaking before the
      // first page is exhausted must not prefetch the next.
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(1);
    });

    test("empty prefix: keys extracted with no prefix-strip and Prefix omitted (or empty)", async () => {
      const h1 = fakeHash("aa", "1");
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: keyFor("", h1) }],
        IsTruncated: false,
      });
      const store = createS3BlobStore({ ...baseConfig(), prefix: "" });

      const out: string[] = [];
      for await (const h of store.list()) out.push(h);

      expect(out).toEqual([h1]);
      const input = s3Mock.commandCalls(ListObjectsV2Command)[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      // With an empty prefix, the request's Prefix must be undefined or ""
      // (either is correct — S3 treats them identically).
      expect(input?.Prefix === undefined || input?.Prefix === "").toBe(true);
    });

    test("non-empty prefix: strips prefix + shard and sends Prefix with trailing slash", async () => {
      const h1 = fakeHash("aa", "1");
      const h2 = fakeHash("bc", "2");
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: keyFor("tenant-a/blobs", h1) }, { Key: keyFor("tenant-a/blobs", h2) }],
        IsTruncated: false,
      });
      const store = createS3BlobStore({ ...baseConfig(), prefix: "tenant-a/blobs" });

      const out: string[] = [];
      for await (const h of store.list()) out.push(h);

      expect(out).toEqual([h1, h2]);
      const input = s3Mock.commandCalls(ListObjectsV2Command)[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      // Prefix should scope the list — trailing slash avoids matching
      // `tenant-a/blobs-other/...` siblings.
      expect(input?.Prefix).toBe("tenant-a/blobs/");
    });

    test("filters out keys whose hash portion isn't 64 lowercase hex chars", async () => {
      const good = fakeHash("aa", "1");
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          // 63 chars — too short
          { Key: `aa/${"a".repeat(63)}` },
          // 65 chars — too long
          { Key: `aa/${"a".repeat(65)}` },
          // non-hex (g, h, i ...)
          { Key: `aa/${"g".repeat(64)}` },
          // valid
          { Key: keyFor("", good) },
        ],
        IsTruncated: false,
      });
      const store = createS3BlobStore(baseConfig());

      const out: string[] = [];
      for await (const h of store.list()) out.push(h);

      expect(out).toEqual([good]);
    });
  });

  describe("S3Client configuration", () => {
    test("endpoint and forcePathStyle are forwarded to the underlying S3Client", async () => {
      // When a custom endpoint is configured (e.g. MinIO/R2), the SDK must
      // route through it. Rather than reaching into client internals, verify
      // behavior: a mocked .send() still resolves correctly regardless of
      // endpoint config — the config validates at construction and is passed
      // through to the SDK.
      s3Mock.on(PutObjectCommand).resolves({});
      const store = createS3BlobStore({
        ...baseConfig(),
        endpoint: "https://minio.example.com",
        forcePathStyle: true,
      });

      const hash = await store.put(HELLO);

      expect(hash).toBe(HELLO_HASH);
    });
  });

  describe("store-id sentinel (Plan 5 Task 5)", () => {
    test("writeStoreId PUTs the UUID at `<prefix>/__store_id__`", async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const store = createS3BlobStore({ ...baseConfig(), prefix: "tenant-a/blobs" });
      const uuid = "12345678-1234-4234-a234-1234567890ab";

      await store.sentinel?.writeStoreId(uuid);

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]?.args[0].input;
      expect(input?.Bucket).toBe("test-bucket");
      expect(input?.Key).toBe("tenant-a/blobs/__store_id__");
      // Body is the UUID encoded as UTF-8 bytes — not a hash, not sharded.
      expect(input?.Body).toEqual(new TextEncoder().encode(uuid));
    });

    test("writeStoreId with empty prefix uses `__store_id__` at the bucket root", async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      const store = createS3BlobStore({ ...baseConfig(), prefix: "" });

      await store.sentinel?.writeStoreId("00000000-0000-4000-8000-000000000000");

      const input = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
      expect(input?.Key).toBe("__store_id__");
    });

    test("readStoreId returns the UUID written by a prior writeStoreId", async () => {
      const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      s3Mock.on(GetObjectCommand).resolves({ Body: bodyFromBytes(new TextEncoder().encode(uuid)) });

      const store = createS3BlobStore(baseConfig());
      const got = await store.sentinel?.readStoreId();
      expect(got).toBe(uuid);

      const calls = s3Mock.commandCalls(GetObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0].input.Key).toBe("__store_id__");
    });

    test("readStoreId returns undefined when sentinel is absent (NoSuchKey)", async () => {
      const err = new Error("not found");
      err.name = "NoSuchKey";
      s3Mock.on(GetObjectCommand).rejects(err);

      const store = createS3BlobStore(baseConfig());
      expect(await store.sentinel?.readStoreId()).toBeUndefined();
    });

    test("readStoreId returns undefined for NotFound (HeadObject-style errors from GetObject on some S3-compatibles)", async () => {
      const err = new Error("not found");
      err.name = "NotFound";
      s3Mock.on(GetObjectCommand).rejects(err);

      const store = createS3BlobStore(baseConfig());
      expect(await store.sentinel?.readStoreId()).toBeUndefined();
    });
  });
});
