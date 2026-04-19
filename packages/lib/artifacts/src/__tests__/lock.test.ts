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
});
