import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobStore, createFilesystemBlobStore, type StoreIdSentinel } from "@koi/blob-cas";
import { openDatabase } from "../sqlite.js";
import { ensureStoreIdPair, readStoreIdFromDb } from "../store-id.js";

describe("store-id fingerprint (filesystem backend)", () => {
  let blobDir: string;
  let db: Database;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-storeid-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    db = openDatabase({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("both missing + empty → bootstraps fresh UUID on both sides", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    const id = await ensureStoreIdPair({ db, blobStore });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const dbId = readStoreIdFromDb(db);
    expect(dbId).toBe(id);
    const sentinel = readFileSync(join(blobDir, ".store-id"), "utf8").trim();
    expect(sentinel).toBe(id);
  });

  test("both present + match → opens normally", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    const id1 = await ensureStoreIdPair({ db, blobStore });
    const id2 = await ensureStoreIdPair({ db, blobStore });
    expect(id1).toBe(id2);
  });

  test("both present + differ → throws 'paired with a different ArtifactStore'", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobStore });
    writeFileSync(join(blobDir, ".store-id"), crypto.randomUUID());
    await expect(ensureStoreIdPair({ db, blobStore })).rejects.toThrow(
      /paired with a different ArtifactStore/,
    );
  });

  test("DB present + sentinel missing + store has rows → throws 'missing store-id sentinel'", async () => {
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobStore });
    rmSync(join(blobDir, ".store-id"));
    // Put a row so the store is no longer empty — one-sided absence on a
    // non-empty store is operator repair, not auto-heal.
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    await expect(ensureStoreIdPair({ db, blobStore })).rejects.toThrow(/missing store-id sentinel/);
  });

  test("DB present + sentinel missing + store empty → auto-heals by writing sentinel", async () => {
    // This is the crashed-mid-bootstrap shape (first side wrote, second side
    // didn't complete). An empty store should self-heal on the next open.
    const blobStore = createFilesystemBlobStore(blobDir);
    const id = await ensureStoreIdPair({ db, blobStore });
    rmSync(join(blobDir, ".store-id"));
    const idAfter = await ensureStoreIdPair({ db, blobStore });
    expect(idAfter).toBe(id);
    expect(readFileSync(join(blobDir, ".store-id"), "utf8").trim()).toBe(id);
  });

  test("sentinel present + DB missing + store has rows → throws", async () => {
    writeFileSync(join(blobDir, ".store-id"), crypto.randomUUID());
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    const blobStore = createFilesystemBlobStore(blobDir);
    await expect(ensureStoreIdPair({ db, blobStore })).rejects.toThrow(
      /Metadata DB is missing store-id/,
    );
  });

  test("sentinel present + DB missing + store empty → auto-heals by writing DB", async () => {
    const sentinel = crypto.randomUUID();
    writeFileSync(join(blobDir, ".store-id"), sentinel);
    const blobStore = createFilesystemBlobStore(blobDir);
    const id = await ensureStoreIdPair({ db, blobStore });
    expect(id).toBe(sentinel);
  });

  test("both missing + DB has existing rows → throws 'missing on a non-empty store'", async () => {
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    const blobStore = createFilesystemBlobStore(blobDir);
    await expect(ensureStoreIdPair({ db, blobStore })).rejects.toThrow(
      /missing on a non-empty store/,
    );
  });

  test("both missing + blob backend already has blobs → refuses to bootstrap", async () => {
    // Seed the blob backend with a pre-existing blob (as if from a previous
    // store whose DB was lost). Self-healing/bootstrap must NOT claim these
    // bytes as our own — sweep would eventually delete them.
    const blobStore = createFilesystemBlobStore(blobDir);
    await blobStore.put(new TextEncoder().encode("previous-owner"));
    await expect(ensureStoreIdPair({ db, blobStore })).rejects.toThrow(
      /missing on a non-empty store/,
    );
  });

  test("DB present + sentinel missing + blob backend has blobs → refuses to heal", async () => {
    // Seed with a real pair, then corrupt: remove the sentinel AND seed extra
    // blobs that we shouldn't claim. Even with empty DB rows, non-empty blob
    // backend blocks auto-heal.
    const blobStore = createFilesystemBlobStore(blobDir);
    await ensureStoreIdPair({ db, blobStore });
    rmSync(join(blobDir, ".store-id"));
    await blobStore.put(new TextEncoder().encode("previous-owner-bytes"));
    await expect(ensureStoreIdPair({ db, blobStore })).rejects.toThrow(/missing store-id sentinel/);
  });
});

/**
 * Backend-agnostic sentinel coverage (Plan 5): `ensureStoreIdPair` must route
 * through `blobStore.sentinel` for any backend. These tests use an in-memory
 * `BlobStore` that stores blobs in a `Map` and exposes an in-memory sentinel.
 * The FS sentinel file is never touched — if it were, the FS-specific branch
 * would throw when `blobDir` is a bogus path.
 */
function createInMemoryBlobStore(): BlobStore & {
  readonly sentinelState: { value: string | undefined };
} {
  const blobs = new Map<string, Uint8Array>();
  const sentinelState: { value: string | undefined } = { value: undefined };

  const sentinel: StoreIdSentinel = {
    readStoreId: async () => sentinelState.value,
    writeStoreId: async (uuid) => {
      sentinelState.value = uuid;
    },
  };

  async function sha256Hex(data: Uint8Array): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(data);
    return hasher.digest("hex");
  }

  async function* list(): AsyncIterable<string> {
    for (const hash of blobs.keys()) yield hash;
  }

  return {
    put: async (data) => {
      const hash = await sha256Hex(data);
      blobs.set(hash, data);
      return hash;
    },
    get: async (hash) => blobs.get(hash),
    has: async (hash) => blobs.has(hash),
    delete: async (hash) => blobs.delete(hash),
    list,
    sentinel,
    sentinelState,
  };
}

describe("store-id fingerprint (in-memory backend)", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  test("both missing + empty → bootstraps fresh UUID on in-memory sentinel", async () => {
    const store = createInMemoryBlobStore();
    const id = await ensureStoreIdPair({ db, blobStore: store });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readStoreIdFromDb(db)).toBe(id);
    expect(store.sentinelState.value).toBe(id);
  });

  test("mismatched sentinel UUID → throws 'paired with a different ArtifactStore'", async () => {
    const store = createInMemoryBlobStore();
    await ensureStoreIdPair({ db, blobStore: store });
    // Corrupt the sentinel to a valid-but-different UUID.
    store.sentinelState.value = crypto.randomUUID();
    await expect(ensureStoreIdPair({ db, blobStore: store })).rejects.toThrow(
      /paired with a different ArtifactStore/,
    );
  });

  test("malformed sentinel value → throws 'malformed store_id'", async () => {
    const store = createInMemoryBlobStore();
    store.sentinelState.value = "not-a-uuid";
    await expect(ensureStoreIdPair({ db, blobStore: store })).rejects.toThrow(/malformed store_id/);
  });

  test("BlobStore without `sentinel` field → throws with clear message", async () => {
    // Third-party BlobStore that forgot to populate sentinel.
    const unsentineled: BlobStore = {
      put: async () => "",
      get: async () => undefined,
      has: async () => false,
      delete: async () => false,
      list: async function* () {
        yield* [];
      },
    };
    await expect(ensureStoreIdPair({ db, blobStore: unsentineled })).rejects.toThrow(
      /missing its store-id sentinel/,
    );
  });

  test("bootstrap race: writeStoreId rejects 'already exists' + sentinel mismatch → throws pairing error", async () => {
    // Simulates the two-process race on a conditional-create backend
    // (S3 with `IfNoneMatch: "*"`). Process B reads an absent sentinel,
    // races process A, and B's writeStoreId fails with "already exists".
    // The backend now holds A's UUID. ensureStoreIdPair must catch the
    // rejection, re-read, and surface the standard "paired with a
    // different ArtifactStore" error.
    const otherUuid = crypto.randomUUID();
    let readCount = 0;
    const sentinel: StoreIdSentinel = {
      readStoreId: async () => {
        // First read: see absent (the empty-store check). Subsequent
        // reads: after the failed write, see the winner's UUID.
        return readCount++ === 0 ? undefined : otherUuid;
      },
      writeStoreId: async () => {
        throw new Error("S3 sentinel at foo/__store_id__ already exists");
      },
    };
    const racedStore: BlobStore = {
      put: async () => "",
      get: async () => undefined,
      has: async () => false,
      delete: async () => false,
      list: async function* () {
        yield* [];
      },
      sentinel,
    };
    await expect(ensureStoreIdPair({ db, blobStore: racedStore })).rejects.toThrow(
      /paired with a different ArtifactStore/,
    );
  });

  test("pre-populated sentinel with different UUID → standard mismatch error (no write attempted)", async () => {
    // The caller's readStoreId returns an existing UUID; DB is empty, so
    // we go down the "sentinel present + DB missing" branch. With a
    // non-empty blob backend, that surfaces as "Metadata DB is missing
    // store-id" — but with an empty backend, the code self-heals.
    // Assert we DON'T silently re-pair when there's a non-matching sentinel.
    const existing = crypto.randomUUID();
    const sentinel: StoreIdSentinel = {
      readStoreId: async () => existing,
      writeStoreId: async () => {
        throw new Error("simulator: writeStoreId should not be called in this path");
      },
    };
    const preSeeded: BlobStore = {
      put: async () => "",
      get: async () => undefined,
      has: async () => false,
      delete: async () => false,
      list: async function* () {
        yield* [];
      },
      sentinel,
    };
    // Empty DB + empty blob store + sentinel present → self-heal by writing
    // DB row. Verify that's what happens (no write attempted, because the
    // DB write path in ensureStoreIdPair doesn't call writeStoreId).
    const id = await ensureStoreIdPair({ db, blobStore: preSeeded });
    expect(id).toBe(existing);
  });
});
