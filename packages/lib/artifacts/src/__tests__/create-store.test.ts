import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../create-store.js";

describe("createArtifactStore (skeleton)", () => {
  let blobDir: string;
  let dbPath: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-art-store-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("opens a fresh store (both sides empty → bootstraps store_id)", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    expect(typeof store.close).toBe("function");
    await store.close();
  });

  test("second open while first is alive throws", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await expect(createArtifactStore({ dbPath, blobDir })).rejects.toThrow(
      /already open by another process/,
    );
    await store.close();
  });

  test("re-open after close succeeds", async () => {
    const s1 = await createArtifactStore({ dbPath, blobDir });
    await s1.close();
    const s2 = await createArtifactStore({ dbPath, blobDir });
    await s2.close();
  });

  test("close is idempotent", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await store.close();
    await store.close();
  });

  test("Plan-2 stubs throw 'not implemented' (shareArtifact and revokeShare)", async () => {
    const store = await createArtifactStore({ dbPath, blobDir });
    await expect(store.shareArtifact({} as never, {} as never, {} as never)).rejects.toThrow(
      /not implemented/,
    );
    await expect(store.revokeShare({} as never, {} as never, {} as never)).rejects.toThrow(
      /not implemented/,
    );
    await store.close();
  });
});
