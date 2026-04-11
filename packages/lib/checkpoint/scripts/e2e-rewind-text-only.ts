/**
 * Rewind-1 smoke test against the live TUI chain at /tmp/koi-rewind-e2e.
 * Text-only scenario — no file edits, just validates transcript truncation.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckpointPayload, DriftDetector } from "@koi/checkpoint";
import { createCheckpoint } from "@koi/checkpoint";
import { sessionId as makeSessionId } from "@koi/core";
import { createJsonlTranscript } from "@koi/session";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const cwd = "/private/tmp/koi-rewind-e2e";
const workspaceHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
const snapshotPath = join(homedir(), ".koi", "snapshots", `${workspaceHash}.sqlite`);
const blobDir = join(homedir(), ".koi", "file-history");

const peek = new Database(snapshotPath, { readonly: true });
const row = peek
  .query("SELECT chain_id FROM snapshot_nodes ORDER BY created_at DESC LIMIT 1")
  .get() as { chain_id: string };
peek.close();
const sid = makeSessionId(row.chain_id);
console.log("sessionId:", sid);

const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: snapshotPath });
const transcript = createJsonlTranscript({ baseDir: join(homedir(), ".koi", "sessions") });

const beforeLoad = await transcript.load(sid);
console.log("[before] jsonl entries =", beforeLoad.ok ? beforeLoad.value.entries.length : "error");

const checkpoint = createCheckpoint({
  store,
  config: {
    blobDir,
    driftDetector: NULL_DRIFT,
    resolvePath: (p: string): string => (p.startsWith("/") ? p : join(cwd, p)),
    transcript,
  },
});

const r = await checkpoint.rewind(sid, 1);
console.log("[rewind 1]", JSON.stringify(r, null, 2));

const afterLoad = await transcript.load(sid);
console.log("[after] jsonl entries =", afterLoad.ok ? afterLoad.value.entries.length : "error");
if (afterLoad.ok) {
  for (const e of afterLoad.value.entries) {
    console.log(`  - ${e.role}: ${e.content.slice(0, 60)}`);
  }
}
store.close();
