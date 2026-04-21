import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { createArtifactStore } from "../create-store.js";
import type { ArtifactStore } from "../types.js";

describe("listArtifacts", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    blobDir = join(tmpdir(), `koi-art-list-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    store = await createArtifactStore({ dbPath, blobDir });
  });

  afterEach(async () => {
    await store.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  async function save(sid: string, name: string, text: string, tags?: readonly string[]) {
    const input = {
      sessionId: sessionId(sid),
      name,
      data: new TextEncoder().encode(text),
      mimeType: "text/plain",
      ...(tags !== undefined ? { tags } : {}),
    };
    const r = await store.saveArtifact(input);
    if (!r.ok) throw new Error(`save failed: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  test("lists owned artifacts, hides others", async () => {
    await save("sess_a", "a1", "x");
    await save("sess_a", "a2", "y");
    await save("sess_b", "b1", "z");
    const list = await store.listArtifacts({}, { sessionId: sessionId("sess_a") });
    expect(list.map((a) => a.name).sort()).toEqual(["a1", "a2"]);
  });

  test("name filter returns all versions under that name", async () => {
    await save("sess_a", "doc", "v1");
    await save("sess_a", "doc", "v2");
    await save("sess_a", "other", "x");
    const list = await store.listArtifacts({ name: "doc" }, { sessionId: sessionId("sess_a") });
    expect(list.length).toBe(2);
    expect(list.every((a) => a.name === "doc")).toBe(true);
    expect(list.map((a) => a.version).sort()).toEqual([1, 2]);
  });

  test("tags filter is AND semantics", async () => {
    await save("sess_a", "a1", "x", ["red", "round"]);
    await save("sess_a", "a2", "y", ["red"]);
    await save("sess_a", "a3", "z", ["round"]);
    const list = await store.listArtifacts(
      { tags: ["red", "round"] },
      { sessionId: sessionId("sess_a") },
    );
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("a1");
  });

  test("includeShared false excludes shared artifacts by default", async () => {
    // Plan 2 doesn't yet have shareArtifact, but we can seed a share row directly.
    const art = await save("sess_a", "shared", "x");
    await store.close();
    const db = new Database(dbPath);
    db.exec(
      `INSERT INTO artifact_shares (artifact_id, granted_to_session_id, granted_at) VALUES ('${art.id}', 'sess_b', ${Date.now()})`,
    );
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    const listDefault = await store.listArtifacts({}, { sessionId: sessionId("sess_b") });
    expect(listDefault.length).toBe(0);
    const listShared = await store.listArtifacts(
      { includeShared: true },
      { sessionId: sessionId("sess_b") },
    );
    expect(listShared.length).toBe(1);
    expect(listShared[0]?.name).toBe("shared");
  });

  test("blob_ready=0 rows are hidden", async () => {
    await save("sess_a", "a1", "x");
    await store.close();
    const db = new Database(dbPath);
    const fakeId = `art_${crypto.randomUUID()}`;
    db.exec(
      `INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at, blob_ready)
       VALUES ('${fakeId}', 'sess_a', 'inflight', 1, 'text/plain', 1, 'deadbeef', 0, 0)`,
    );
    db.close();
    store = await createArtifactStore({ dbPath, blobDir });
    const list = await store.listArtifacts({}, { sessionId: sessionId("sess_a") });
    expect(list.length).toBe(1);
    expect(list[0]?.name).toBe("a1");
  });
});
