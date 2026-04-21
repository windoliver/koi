/**
 * Integration tests for @koi/artifacts Plan 3-6 behaviors surfaced through
 * the runtime-facing `createArtifactToolProvider`. Each test drives the real
 * agent-observable tool surface (artifact_save / _get / _list / _delete)
 * against a real SQLite + real BlobStore (filesystem or mocked S3), proving
 * that the Plan 3-6 behaviors flow end-to-end:
 *
 *   B1 — TTL expiry → artifact_get returns ok:false, error.kind="not_found"
 *   B2 — Quota → artifact_save returns ok:false, error.kind="quota_exceeded"
 *   B3 — Repair worker onEvent fires `repair_exhausted` after budget
 *   B5 — S3 backend round-trips through the agent tool provider
 *   C  — Concurrency stress: 100 saves + 20 sweeps + 2 scavenges settle clean
 *
 * These complement the unit coverage under
 * `packages/lib/artifacts/src/__tests__/` and
 * `packages/meta/runtime/src/artifact-tool-provider.test.ts` by proving the
 * behaviors stay wired through the provider layer agents actually call.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { type ArtifactStore, type ArtifactStoreEvent, createArtifactStore } from "@koi/artifacts";
import { createS3BlobStore } from "@koi/artifacts-s3";
import type { Agent, JsonObject, SessionId, Tool } from "@koi/core";
import { agentId, isAttachResult, sessionId, toolToken } from "@koi/core";
import { sdkStreamMixin } from "@smithy/util-stream";
import { type AwsClientStub, mockClient } from "aws-sdk-client-mock";
import { createArtifactToolProvider } from "../artifact-tool-provider.js";

// ----- shared scaffolding -----------------------------------------------------

const stubAgent: Agent = {
  pid: {
    id: agentId("integ-agent"),
    name: "stub",
    type: "worker",
    depth: 0,
  },
  manifest: {} as Agent["manifest"],
  state: "created",
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
};

async function attachTools(store: ArtifactStore, sid: SessionId): Promise<Map<string, Tool>> {
  const provider = createArtifactToolProvider({ store, sessionId: sid });
  const result = await provider.attach(stubAgent);
  const components = isAttachResult(result) ? result.components : result;
  const tools = new Map<string, Tool>();
  for (const name of ["artifact_save", "artifact_get", "artifact_list", "artifact_delete"]) {
    const tool = components.get(toolToken(name) as string) as Tool | undefined;
    if (tool === undefined) throw new Error(`tool missing: ${name}`);
    tools.set(name, tool);
  }
  return tools;
}

async function run(tool: Tool, args: JsonObject): Promise<JsonObject> {
  return (await tool.execute(args)) as JsonObject;
}

function pick(tools: Map<string, Tool>, name: string): Tool {
  const t = tools.get(name);
  if (t === undefined) throw new Error(`tool missing: ${name}`);
  return t;
}

// ----- B1: TTL expiry surfaces through artifact_get ---------------------------

describe("Plan 3 / B1: TTL expiry surfaces through artifact_get", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-artint-b1-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("artifact saved with tight TTL returns not_found after expiry + sweep", async () => {
    // Tight 50ms TTL; __TEST_ONLY_unsafeStaleIntentGrace lets us set
    // staleIntentGraceMs below the 60_000ms production floor so recovery's
    // grace window does not dwarf the test's own timing. workerIntervalMs
    // is "manual" so a background tick can't race the sweep under test.
    const store = await createArtifactStore({
      dbPath,
      blobDir,
      policy: { ttlMs: 50 },
      workerIntervalMs: "manual",
      staleIntentGraceMs: 100,
      __TEST_ONLY_unsafeStaleIntentGrace: true,
    });
    try {
      const owner = sessionId("sess-ttl");
      const tools = await attachTools(store, owner);

      const saved = await run(pick(tools, "artifact_save"), {
        name: "expiring.txt",
        content: "content",
      });
      expect(saved.ok).toBe(true);
      const id = saved.id as string;

      // Before TTL: get still works.
      const early = await run(pick(tools, "artifact_get"), { id });
      expect(early.ok).toBe(true);

      // Wait past TTL, then drive a sweep through the public API. Sweep
      // reaps TTL-expired rows in Phase A atomic metadata deletion.
      await new Promise((r) => setTimeout(r, 120));
      const result = await store.sweepArtifacts();
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      // Post-sweep: agent-facing get sees not_found.
      const gone = await run(pick(tools, "artifact_get"), { id });
      expect(gone.ok).toBe(false);
      expect((gone.error as { readonly kind: string }).kind).toBe("not_found");
    } finally {
      await store.close();
    }
  });
});

// ----- B2: Quota rejection surfaces through artifact_save --------------------

describe("Plan 3 / B2: quota rejection surfaces through artifact_save", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-artint-b2-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("save over maxSessionBytes returns structured quota_exceeded", async () => {
    // 20-byte session cap. First save (15 bytes) fits; second save (10 bytes)
    // must be rejected — 15 + 10 > 20 — with a structured quota_exceeded
    // envelope surfacing usedBytes + limitBytes.
    const store = await createArtifactStore({
      dbPath,
      blobDir,
      policy: { maxSessionBytes: 20 },
      workerIntervalMs: "manual",
    });
    try {
      const owner = sessionId("sess-quota");
      const tools = await attachTools(store, owner);

      const first = await run(pick(tools, "artifact_save"), {
        name: "fits.txt",
        content: "x".repeat(15),
      });
      expect(first.ok).toBe(true);
      expect(first.size).toBe(15);

      const second = await run(pick(tools, "artifact_save"), {
        name: "overflows.txt",
        content: "y".repeat(10),
      });
      expect(second.ok).toBe(false);
      const err = second.error as {
        readonly kind: string;
        readonly usedBytes: number;
        readonly limitBytes: number;
      };
      expect(err.kind).toBe("quota_exceeded");
      expect(err.usedBytes).toBe(15);
      expect(err.limitBytes).toBe(20);

      // Listing after rejection confirms the failed save produced no row —
      // quota admission runs BEFORE any DML (spec §6.1).
      const listed = await run(pick(tools, "artifact_list"), {});
      expect(listed.count).toBe(1);
    } finally {
      await store.close();
    }
  });
});

// ----- B3: Worker onEvent hook fires on repair_exhausted ---------------------

describe("Plan 4 / B3: worker onEvent surfaces repair drift", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-artint-b3-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("blob_ready=0 row with missing blob fires repair_exhausted after budget", async () => {
    // Phase 1: seed a committed save, then close. seedSave isolates the
    // worker from the save's own post-commit repair race.
    const seed = await createArtifactStore({
      dbPath,
      blobDir,
      workerIntervalMs: "manual",
    });
    const owner = sessionId("sess-drift");
    const seedTools = await attachTools(seed, owner);
    const saved = await run(pick(seedTools, "artifact_save"), {
      name: "doomed.txt",
      content: "to-be-reaped",
    });
    expect(saved.ok).toBe(true);
    const artId = saved.id as string;
    const contentHash = saved.contentHash as string;
    await seed.close();

    // Phase 2: flip blob_ready back to 0 AND unlink the blob file. This is
    // the natural post-commit-repair-crash state the repair worker owns.
    // The raw DB handle gives us offline DML while the store is closed.
    const raw = new Database(dbPath);
    try {
      raw.exec("PRAGMA journal_mode = WAL;");
      raw.query("UPDATE artifacts SET blob_ready = 0, repair_attempts = 0 WHERE id = ?").run(artId);
    } finally {
      raw.close();
    }
    // blob-cas sharded layout: <blobDir>/<hash[0:2]>/<hash>
    const blobFile = join(blobDir, contentHash.slice(0, 2), contentHash);
    if (existsSync(blobFile)) unlinkSync(blobFile);

    // Phase 3: re-open with an aggressive worker cadence + maxRepairAttempts=1.
    // A single worker iteration probes `has()` (false — blob is gone) and
    // terminal-deletes in-tx, emitting repair_exhausted via onEvent.
    const events: ArtifactStoreEvent[] = [];
    const store = await createArtifactStore({
      dbPath,
      blobDir,
      workerIntervalMs: 100,
      maxRepairAttempts: 1,
      onEvent: (ev) => {
        events.push(ev);
      },
    });
    try {
      // Wait for enough ticks to fire. 400ms / 100ms = ~4 iterations, well
      // past the single-probe budget. The first iteration terminal-deletes;
      // later iterations have no blob_ready=0 rows to drain.
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      // close() awaits any in-flight iteration before releasing the lock.
      await store.close();
    }

    // Exactly one repair_exhausted event for the doomed hash, attempts=1.
    const exhausted = events.filter((e) => e.kind === "repair_exhausted");
    expect(exhausted.length).toBe(1);
    const ev = exhausted[0];
    if (ev?.kind !== "repair_exhausted") throw new Error("expected repair_exhausted");
    expect(ev.contentHash).toBe(contentHash);
    expect(ev.attempts).toBe(1);
    // Brand-strip the ArtifactId for comparison against the raw string.
    expect(String(ev.artifactId)).toBe(artId);
  });
});

// ----- B5: S3 backend end-to-end through artifact tool provider --------------

// In-memory S3 simulator — mirrors the helper in golden-replay.test.ts, kept
// inline so this file stays self-contained (no test helper leaks into the src
// surface of @koi/artifacts-s3).
const S3_INTEG_BUCKET = "koi-artint-bucket";
const S3_INTEG_MAX_KEYS = 1000;

function s3BodyFromBytes(data: Uint8Array): ReturnType<typeof sdkStreamMixin> {
  const stream = new Readable();
  stream.push(data);
  stream.push(null);
  return sdkStreamMixin(stream);
}

function s3NamedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function installS3Simulator(mock: AwsClientStub<S3Client>): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>();

  mock.on(PutObjectCommand).callsFake((input: { Key?: string; Body?: unknown }) => {
    if (input.Key === undefined) throw new Error("simulator: PutObject missing Key");
    if (!(input.Body instanceof Uint8Array)) {
      throw new Error("simulator: PutObject Body must be Uint8Array");
    }
    store.set(input.Key, input.Body);
    return {};
  });

  mock.on(GetObjectCommand).callsFake((input: { Key?: string }) => {
    if (input.Key === undefined) throw new Error("simulator: GetObject missing Key");
    const bytes = store.get(input.Key);
    if (bytes === undefined) throw s3NamedError("NoSuchKey", "The specified key does not exist.");
    return { Body: s3BodyFromBytes(bytes) };
  });

  mock.on(HeadObjectCommand).callsFake((input: { Key?: string }) => {
    if (input.Key === undefined) throw new Error("simulator: HeadObject missing Key");
    if (!store.has(input.Key)) throw s3NamedError("NotFound", "Not Found");
    return {};
  });

  mock.on(DeleteObjectCommand).callsFake((input: { Key?: string }) => {
    if (input.Key === undefined) throw new Error("simulator: DeleteObject missing Key");
    store.delete(input.Key);
    return {};
  });

  mock
    .on(ListObjectsV2Command)
    .callsFake((input: { Prefix?: string; ContinuationToken?: string; MaxKeys?: number }) => {
      const prefix = input.Prefix ?? "";
      const maxKeys = input.MaxKeys ?? S3_INTEG_MAX_KEYS;
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

describe("Plan 5 / B5: artifact tools round-trip through S3 backend", () => {
  test("createArtifactStore({ blobStore: s3Store }) + tools = save/get/list/delete", async () => {
    const s3Mock = mockClient(S3Client);
    const simulator = installS3Simulator(s3Mock);

    const s3Store = createS3BlobStore({
      bucket: S3_INTEG_BUCKET,
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIA000000EXAMPLE",
        secretAccessKey: "secret/example/key",
      },
    });

    const store = await createArtifactStore({
      dbPath: ":memory:",
      blobStore: s3Store,
      workerIntervalMs: "manual",
    });
    try {
      const owner = sessionId("sess-s3-integ");
      const tools = await attachTools(store, owner);

      // Save through the provider → S3 simulator must hold the bytes.
      const saved = await run(pick(tools, "artifact_save"), {
        name: "hello.txt",
        content: "hello s3 integration",
      });
      expect(saved.ok).toBe(true);
      expect(saved.size).toBe("hello s3 integration".length);
      const id = saved.id as string;
      expect(simulator.size).toBeGreaterThan(0);

      // Get round-trip must recover the exact bytes.
      const got = await run(pick(tools, "artifact_get"), { id });
      expect(got.ok).toBe(true);
      expect(got.content).toBe("hello s3 integration");

      // List surfaces the saved artifact.
      const listed = await run(pick(tools, "artifact_list"), {});
      expect(listed.count).toBe(1);

      // Delete enqueues a tombstone; blob deletion is deferred to Phase B.
      // The agent-visible surface returns ok:true immediately.
      const deleted = await run(pick(tools, "artifact_delete"), { id });
      expect(deleted.ok).toBe(true);

      const gone = await run(pick(tools, "artifact_get"), { id });
      expect(gone.ok).toBe(false);
      expect((gone.error as { readonly kind: string }).kind).toBe("not_found");
    } finally {
      await store.close();
      s3Mock.reset();
    }
  });
});

// ----- C: concurrency stress under save/sweep/worker -------------------------

describe("Plan 3-4 / C: concurrency stress", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-artint-c-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("100 concurrent saves + 20 sweeps + 2 scavenges settle without invariant violation", async () => {
    // Aggressive 100ms worker cadence (the production floor) + generous
    // 1MB quota + 10s TTL. All 100 small saves fit under the quota; the
    // worker races saves/sweeps but mustn't corrupt rows, orphan blobs, or
    // throw SQLITE_BUSY.
    const store = await createArtifactStore({
      dbPath,
      blobDir,
      policy: { ttlMs: 10_000, maxSessionBytes: 1_000_000 },
      workerIntervalMs: 100,
    });
    const owner = sessionId("sess-stress");
    const tools = await attachTools(store, owner);
    const save = pick(tools, "artifact_save");
    const list = pick(tools, "artifact_list");

    // 100 parallel distinct-content saves. Content must be distinct so each
    // hash is unique (prevents the save idempotency path collapsing them).
    const saveResults = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        run(save, {
          name: `item-${i}.txt`,
          content: `content-${i}-${crypto.randomUUID()}`,
        }),
      ),
    );

    // 20 parallel sweeps. Sweeps run Phase A metadata DELETE + enqueue
    // tombstones; racing saves should not reap live rows (TTL is 10s).
    const sweepResults = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.sweepArtifacts()),
    );

    // 2 parallel scavenges. Disaster-recovery O(N) scans; must not double-
    // delete blobs or corrupt metadata rows for in-flight saves.
    const scavengeResults = await Promise.allSettled([
      store.scavengeOrphanBlobs(),
      store.scavengeOrphanBlobs(),
    ]);

    // ----- Assertions -----

    // Every save that fulfilled must be a genuine ok:true envelope. No
    // rejections expected — 100 small saves under a 1MB quota fit easily.
    const fulfilledSaves = saveResults.filter((r) => r.status === "fulfilled");
    const rejectedSaves = saveResults.filter((r) => r.status === "rejected");
    if (rejectedSaves.length > 0) {
      // Surface reasons for debuggability.
      const reasons = rejectedSaves.map((r) =>
        r.status === "rejected" ? String(r.reason) : "unknown",
      );
      throw new Error(`unexpected save rejections: ${reasons.join("; ")}`);
    }
    expect(fulfilledSaves.length).toBe(100);

    // Each fulfilled save's id must round-trip through artifact_get.
    const savedIds: string[] = [];
    for (const r of fulfilledSaves) {
      if (r.status !== "fulfilled") continue;
      const env = r.value as JsonObject;
      expect(env.ok).toBe(true);
      savedIds.push(String(env.id));
    }

    const get = pick(tools, "artifact_get");
    const gets = await Promise.all(savedIds.map((id) => run(get, { id })));
    for (const g of gets) {
      expect(g.ok).toBe(true);
      expect(typeof g.content).toBe("string");
    }

    // listArtifacts surfaces all 100 (sweeps don't touch unexpired rows).
    const listed = await run(list, {});
    expect(listed.count).toBe(100);

    // Sweeps must all fulfill (no SQLITE_BUSY or locking errors).
    for (const r of sweepResults) {
      if (r.status !== "fulfilled") {
        throw new Error(
          `unexpected sweep rejection: ${String(r.status === "rejected" ? r.reason : "")}`,
        );
      }
    }
    for (const r of scavengeResults) {
      if (r.status !== "fulfilled") {
        throw new Error(
          `unexpected scavenge rejection: ${String(r.status === "rejected" ? r.reason : "")}`,
        );
      }
    }

    // close() must drain cleanly within the 15s test timeout.
    await store.close();

    // After close: no orphan blobs. Every file on disk must correspond to a
    // content_hash from a fulfilled save (all 100 are still live). We read
    // the DB offline for this — the store is closed.
    const raw = new Database(dbPath);
    let hashesOnDb: Set<string>;
    try {
      hashesOnDb = new Set(
        (
          raw
            .query("SELECT DISTINCT content_hash FROM artifacts WHERE blob_ready = 1")
            .all() as ReadonlyArray<{ readonly content_hash: string }>
        ).map((r) => r.content_hash),
      );
    } finally {
      raw.close();
    }
    const blobsOnDisk = new Set<string>();
    for (const shard of readdirSync(blobDir)) {
      if (shard.length !== 2) continue; // skip store.db, lock file, etc.
      const shardPath = join(blobDir, shard);
      if (!statSync(shardPath).isDirectory()) continue;
      for (const entry of readdirSync(shardPath)) blobsOnDisk.add(entry);
    }
    // Every blob on disk must be referenced by a live row. The reverse
    // (every live hash has a blob) is proven by the successful artifact_get
    // calls above. Orphan blobs are the concerning invariant violation.
    for (const hash of blobsOnDisk) {
      expect(hashesOnDb.has(hash)).toBe(true);
    }
  }, 15_000);
});
