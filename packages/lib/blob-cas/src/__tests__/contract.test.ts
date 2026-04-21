/**
 * Runs the BlobStore contract suite against the filesystem impl.
 *
 * Every BlobStore implementation MUST pass this suite. The S3 impl in
 * @koi/artifacts-s3 (Plan 5) will import and re-run this helper against its
 * own factory.
 */

import { describe } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemBlobStore } from "../blob-store.js";
import { runBlobStoreContract } from "../contract.js";

describe("BlobStore contract — filesystem impl", () => {
  runBlobStoreContract({
    label: "filesystem",
    createStore: async () => {
      const blobDir = join(tmpdir(), `koi-bs-contract-${crypto.randomUUID()}`);
      mkdirSync(blobDir, { recursive: true });
      return {
        store: createFilesystemBlobStore(blobDir),
        cleanup: () => rmSync(blobDir, { recursive: true, force: true }),
      };
    },
  });
});
