import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { createArtifactStore } from "../create-store.js";
import type { Artifact, ArtifactStore } from "../types.js";

describe("getArtifact", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    blobDir = join(tmpdir(), `koi-art-get-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    store = await createArtifactStore({ dbPath, blobDir });
  });

  afterEach(async () => {
    await store.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  async function save(name: string, text: string, sid = "sess_a"): Promise<Artifact> {
    const r = await store.saveArtifact({
      sessionId: sessionId(sid),
      name,
      data: new TextEncoder().encode(text),
      mimeType: "text/plain",
    });
    if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  test("owner round-trip returns bytes + meta", async () => {
    const art = await save("a.txt", "hello");
    const r = await store.getArtifact(art.id, { sessionId: sessionId("sess_a") });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.meta.id).toBe(art.id);
    expect(new TextDecoder().decode(r.value.data)).toBe("hello");
  });

  test("non-owner with no share → not_found (not forbidden)", async () => {
    const art = await save("a.txt", "hello", "sess_a");
    const r = await store.getArtifact(art.id, { sessionId: sessionId("sess_b") });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("not_found");
  });

  test("missing id → not_found", async () => {
    const r = await store.getArtifact("art_does_not_exist" as never, {
      sessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("not_found");
  });

  test("blob_ready=0 row is invisible to reads", async () => {
    // Close the store first so we can poke the raw DB.
    await store.close();
    const db = new Database(dbPath);
    const fakeId = `art_${crypto.randomUUID()}`;
    db.exec(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES ('${fakeId}', 'sess_a', 'x', 1, 'text/plain', 1, 'deadbeef', 0, 0)`,
    );
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    const r = await store.getArtifact(fakeId as never, {
      sessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("not_found");
  });

  test("corruption: blob missing but row live → throws", async () => {
    const art = await save("c.txt", "corrupt me");
    // Find the blob path: blob-cas uses <blobDir>/<first2>/<hash>
    const hash = art.contentHash;
    const blobPath = join(blobDir, hash.slice(0, 2), hash);
    unlinkSync(blobPath);
    await expect(store.getArtifact(art.id, { sessionId: sessionId("sess_a") })).rejects.toThrow(
      /blob missing/,
    );
  });
});
