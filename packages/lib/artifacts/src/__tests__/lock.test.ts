import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../lock.js";

describe("single-writer lock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `koi-art-lock-${crypto.randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test(":memory: skips the lock", () => {
    const release = acquireLock(":memory:");
    release();
  });

  test("first acquirer succeeds; second throws", () => {
    const dbPath = join(tmpDir, "store.db");
    const release1 = acquireLock(dbPath);
    expect(() => acquireLock(dbPath)).toThrow(/ArtifactStore already open by another process/);
    release1();
  });

  test("release lets a second acquirer succeed", () => {
    const dbPath = join(tmpDir, "store.db");
    const release1 = acquireLock(dbPath);
    release1();
    const release2 = acquireLock(dbPath);
    release2();
  });

  test("stale lock from dead PID is recovered", async () => {
    const { writeFileSync } = await import("node:fs");
    const dbPath = join(tmpDir, "store.db");
    // Simulate a SIGKILL'd owner: write a lock file with a PID that doesn't
    // exist. `99999999` is practically guaranteed to be unused.
    writeFileSync(`${dbPath}.lock`, "99999999");
    const release = acquireLock(dbPath);
    release();
  });

  test("live PID in lock file blocks new acquirer", () => {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const dbPath = join(tmpDir, "store.db");
    // Use our own PID — definitely alive.
    writeFileSync(`${dbPath}.lock`, String(process.pid));
    expect(() => acquireLock(dbPath)).toThrow(/ArtifactStore already open by another process/);
  });

  test("blobDir lock: two :memory: DBs cannot share one blobDir", () => {
    // Both :memory: DBs skip the dbPath lock, but the blobDir lock still
    // enforces single-owner on the persistent blob backend.
    const release1 = acquireLock(":memory:", tmpDir);
    expect(() => acquireLock(":memory:", tmpDir)).toThrow(
      /ArtifactStore already open by another process/,
    );
    release1();
    const release2 = acquireLock(":memory:", tmpDir);
    release2();
  });

  test("blobDir lock: two FS DBs with same blobDir but different dbPath blocked", () => {
    const db1 = join(tmpDir, "a.db");
    const db2 = join(tmpDir, "b.db");
    const release1 = acquireLock(db1, tmpDir);
    expect(() => acquireLock(db2, tmpDir)).toThrow(/ArtifactStore already open by another process/);
    release1();
  });
});
