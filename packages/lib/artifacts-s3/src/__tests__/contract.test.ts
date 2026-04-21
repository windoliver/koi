/**
 * S3 BlobStore contract compliance (Plan 5 / Task 4).
 *
 * Runs the shared `runBlobStoreContract` suite from `@koi/blob-cas/contract`
 * against `createS3BlobStore`. Every BlobStore backend must pass this suite —
 * it asserts the read-after-write consistency invariant and CRUD correctness
 * (idempotent put, hash stability, list enumeration, etc.).
 *
 * Strategy: we can't hit real S3 in unit tests, so we wire `aws-sdk-client-mock`
 * to a tiny in-memory S3 simulator — a `Map<Key, bytes>` that the command
 * handlers (`.callsFake()`) read/write. The S3BlobStore code under test runs
 * unmodified against this mocked client, which is exactly the point of the
 * contract suite: the interface doesn't know there's no network.
 */

import { describe } from "bun:test";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { runBlobStoreContract } from "@koi/blob-cas/contract";
import { sdkStreamMixin } from "@smithy/util-stream";
import { type AwsClientStub, mockClient } from "aws-sdk-client-mock";
import { createS3BlobStore } from "../s3-blob-store.js";

const TEST_BUCKET = "koi-contract-test-bucket";
// Mirrors the AWS default so our pagination path matches production behaviour.
const DEFAULT_MAX_KEYS = 1000;

/**
 * Wrap raw bytes as an SDK-compatible `Body` that exposes
 * `transformToByteArray()`. The mock library doesn't add the mixin itself.
 */
function bodyFromBytes(data: Uint8Array): ReturnType<typeof sdkStreamMixin> {
  const stream = new Readable();
  stream.push(data);
  stream.push(null);
  return sdkStreamMixin(stream);
}

/**
 * Construct an error the AWS SDK would throw for a 404-style condition. The
 * S3 impl branches on `err.name`, so that's what matters — no extra metadata
 * needed.
 */
function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * Install handlers on the mocked S3 client that implement PutObject /
 * GetObject / HeadObject / DeleteObject / ListObjectsV2 against an in-memory
 * `Map<Key, Uint8Array>`. Returns the map so the test can assert on it if
 * ever needed (currently unused — the contract only cares about the store
 * surface).
 */
// AwsClientStub<T> extracts Client<In, Out, Config> generics from T and feeds
// them into AwsStub. This is the library's recommended helper for typed stub
// references — `mockClient(S3Client)` resolves to this same type at runtime.
type S3Mock = AwsClientStub<S3Client>;

function installSimulator(mock: S3Mock): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>();

  mock
    .on(PutObjectCommand)
    .callsFake((input: { Key?: string; Body?: unknown; IfNoneMatch?: string }) => {
      if (input.Key === undefined) throw new Error("simulator: PutObject missing Key");
      // Body is always a Uint8Array in the S3BlobStore impl (it passes bytes
      // directly). Guard defensively — anything else is a programming error in
      // the test setup.
      if (!(input.Body instanceof Uint8Array)) {
        throw new Error("simulator: PutObject Body must be Uint8Array");
      }
      // Honor `IfNoneMatch: "*"` — conditional create. Matches S3's 412
      // response when the object already exists. The S3 sentinel write uses
      // this to prevent two ArtifactStores from silently re-pairing against
      // the same prefix.
      if (input.IfNoneMatch === "*" && store.has(input.Key)) {
        const err = namedError(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
        );
        (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode: 412 };
        throw err;
      }
      store.set(input.Key, input.Body);
      return {};
    });

  mock.on(GetObjectCommand).callsFake((input: { Key?: string }) => {
    if (input.Key === undefined) throw new Error("simulator: GetObject missing Key");
    const bytes = store.get(input.Key);
    if (bytes === undefined) throw namedError("NoSuchKey", "The specified key does not exist.");
    return { Body: bodyFromBytes(bytes) };
  });

  mock.on(HeadObjectCommand).callsFake((input: { Key?: string }) => {
    if (input.Key === undefined) throw new Error("simulator: HeadObject missing Key");
    if (!store.has(input.Key)) throw namedError("NotFound", "Not Found");
    return {};
  });

  mock.on(DeleteObjectCommand).callsFake((input: { Key?: string }) => {
    if (input.Key === undefined) throw new Error("simulator: DeleteObject missing Key");
    // S3 DeleteObject is idempotent — succeeds whether or not the key exists.
    store.delete(input.Key);
    return {};
  });

  mock
    .on(ListObjectsV2Command)
    .callsFake((input: { Prefix?: string; ContinuationToken?: string; MaxKeys?: number }) => {
      const prefix = input.Prefix ?? "";
      const maxKeys = input.MaxKeys ?? DEFAULT_MAX_KEYS;
      // Sort for deterministic pagination — S3 lists in UTF-8 key order.
      const allKeys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();
      const startIdx = input.ContinuationToken !== undefined ? Number(input.ContinuationToken) : 0;
      const endIdx = Math.min(startIdx + maxKeys, allKeys.length);
      const page = allKeys.slice(startIdx, endIdx);
      const truncated = endIdx < allKeys.length;
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: truncated,
        ...(truncated ? { NextContinuationToken: String(endIdx) } : {}),
      };
    });

  return store;
}

describe("BlobStore contract — @koi/artifacts-s3 impl", () => {
  // One mock for the whole file. `reset()` in the factory clears both the
  // installed handlers and any recorded calls between test cases, so each
  // contract scenario gets an isolated virtual bucket.
  const s3Mock = mockClient(S3Client);

  runBlobStoreContract({
    label: "artifacts-s3",
    createStore: async () => {
      s3Mock.reset();
      installSimulator(s3Mock);
      const store = createS3BlobStore({
        bucket: TEST_BUCKET,
        region: "us-east-1",
        credentials: {
          accessKeyId: "AKIA000000EXAMPLE",
          secretAccessKey: "secret/example/key",
        },
      });
      return {
        store,
        cleanup: () => {
          s3Mock.reset();
        },
      };
    },
  });
});
