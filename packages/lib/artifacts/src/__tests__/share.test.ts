import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { createArtifactStore } from "../create-store.js";
import type { Artifact, ArtifactStore } from "../types.js";

describe("shareArtifact + revokeShare", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    blobDir = join(tmpdir(), `koi-art-share-${crypto.randomUUID()}`);
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
    if (!r.ok) throw new Error("save failed");
    return r.value;
  }

  test("share by owner → grantee can get", async () => {
    const art = await save("sess_a", "shared.txt", "hello");
    const s = await store.shareArtifact(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    expect(s.ok).toBe(true);
    const g = await store.getArtifact(art.id, { sessionId: sessionId("sess_b") });
    expect(g.ok).toBe(true);
  });

  test("share by non-owner → not_found (probe-resistant)", async () => {
    const art = await save("sess_a", "x.txt", "x");
    const r = await store.shareArtifact(art.id, sessionId("sess_c"), {
      ownerSessionId: sessionId("sess_b"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("not_found");
  });

  test("share is idempotent", async () => {
    const art = await save("sess_a", "x.txt", "x");
    const s1 = await store.shareArtifact(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    const s2 = await store.shareArtifact(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);
  });

  test("revoke → grantee sees not_found", async () => {
    const art = await save("sess_a", "x.txt", "x");
    await store.shareArtifact(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    const r = await store.revokeShare(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(true);
    const g = await store.getArtifact(art.id, { sessionId: sessionId("sess_b") });
    expect(g.ok).toBe(false);
  });

  test("revoke by non-owner → not_found", async () => {
    const art = await save("sess_a", "x.txt", "x");
    const r = await store.revokeShare(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_c"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("not_found");
  });

  test("revoke on non-existent share succeeds (idempotent)", async () => {
    const art = await save("sess_a", "x.txt", "x");
    const r = await store.revokeShare(art.id, sessionId("sess_b"), {
      ownerSessionId: sessionId("sess_a"),
    });
    expect(r.ok).toBe(true);
  });

  test("ACL probe-resistance: non-owner on any op → identical not_found shape", async () => {
    const art = await save("sess_a", "x.txt", "x");
    const fake = ("art_" + crypto.randomUUID()) as never;
    const operations = [
      () => store.getArtifact(art.id, { sessionId: sessionId("sess_b") }),
      () => store.getArtifact(fake, { sessionId: sessionId("sess_b") }),
      () => store.deleteArtifact(art.id, { sessionId: sessionId("sess_b") }),
      () => store.deleteArtifact(fake, { sessionId: sessionId("sess_b") }),
      () =>
        store.shareArtifact(art.id, sessionId("sess_c"), {
          ownerSessionId: sessionId("sess_b"),
        }),
      () =>
        store.revokeShare(art.id, sessionId("sess_c"), {
          ownerSessionId: sessionId("sess_b"),
        }),
    ];
    for (const op of operations) {
      const r = await op();
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error.kind).toBe("not_found");
    }
  });
});
