import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { createArtifactStore } from "../create-store.js";
import type { Artifact, ArtifactStore } from "../types.js";

describe("deleteArtifact", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    blobDir = join(tmpdir(), `koi-art-del-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    store = await createArtifactStore({ dbPath, blobDir });
  });

  afterEach(async () => {
    await store.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  async function save(sid: string, name: string, text: string): Promise<Artifact> {
    const r = await store.saveArtifact({
      sessionId: sessionId(sid),
      name,
      data: new TextEncoder().encode(text),
      mimeType: "text/plain",
    });
    if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  test("owner delete removes the metadata row", async () => {
    const art = await save("sess_a", "a.txt", "hello");
    const r = await store.deleteArtifact(art.id, { sessionId: sessionId("sess_a") });
    expect(r.ok).toBe(true);
    const getAfter = await store.getArtifact(art.id, {
      sessionId: sessionId("sess_a"),
    });
    expect(getAfter.ok).toBe(false);
  });

  test("non-owner delete returns not_found (no info leak)", async () => {
    const art = await save("sess_a", "a.txt", "x");
    const r = await store.deleteArtifact(art.id, { sessionId: sessionId("sess_b") });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("not_found");
    // Row is still there
    const still = await store.getArtifact(art.id, { sessionId: sessionId("sess_a") });
    expect(still.ok).toBe(true);
  });

  test("tombstone is enqueued when last reference is removed", async () => {
    const art = await save("sess_a", "a.txt", "x");
    await store.deleteArtifact(art.id, { sessionId: sessionId("sess_a") });
    await store.close();
    const db = new Database(dbPath);
    const row = db
      .query("SELECT hash FROM pending_blob_deletes WHERE hash = ?")
      .get(art.contentHash);
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(row).toBeTruthy();
  });

  test("blob is NOT unlinked by delete (Plan 3 sweep handles it)", async () => {
    const art = await save("sess_a", "a.txt", "x");
    const blobPath = join(blobDir, art.contentHash.slice(0, 2), art.contentHash);
    expect(existsSync(blobPath)).toBe(true);
    await store.deleteArtifact(art.id, { sessionId: sessionId("sess_a") });
    // Blob file still present after delete.
    expect(existsSync(blobPath)).toBe(true);
  });

  test("CASCADE drops shares", async () => {
    const art = await save("sess_a", "a.txt", "x");
    // Seed a share row directly (Plan 2 has no shareArtifact yet).
    await store.close();
    const db = new Database(dbPath);
    db.exec(
      `INSERT INTO artifact_shares (artifact_id, granted_to_session_id, granted_at) VALUES ('${art.id}', 'sess_b', ${Date.now()})`,
    );
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    await store.deleteArtifact(art.id, { sessionId: sessionId("sess_a") });
    await store.close();
    const db2 = new Database(dbPath);
    const count = db2
      .query("SELECT COUNT(*) AS c FROM artifact_shares WHERE artifact_id = ?")
      .get(art.id) as { readonly c: number };
    db2.close();
    store = await createArtifactStore({ dbPath, blobDir });
    expect(count.c).toBe(0);
  });
});
