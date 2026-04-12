/**
 * Programmatic `rewind 1` against the persisted chain from the real TUI
 * session. Used by the /tmp/koi-rewind-e2e handoff to validate that the
 * actual captured state (bootstrap + turn0-with-create + turn1-empty)
 * lands at bootstrap with the file deleted — the behavior the user's
 * `/rewind 1` should see visually.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckpointPayload, DriftDetector } from "@koi/checkpoint";
import { createCheckpoint } from "@koi/checkpoint";
import { sessionId as makeSessionId } from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const cwd = realpathSync("/tmp/koi-rewind-e2e");
const workspaceHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
const snapshotPath = join(homedir(), ".koi", "snapshots", `${workspaceHash}.sqlite`);
const blobDir = join(homedir(), ".koi", "file-history");

// Find the engine session ID from the persisted chain
const peek = new Database(snapshotPath, { readonly: true });
const row = peek.query("SELECT chain_id FROM snapshot_nodes LIMIT 1").get() as {
  chain_id: string;
} | null;
peek.close();
if (row === null) {
  console.error("No captured chain yet — run the TUI and create a file first");
  process.exit(1);
}
const engineSessionId = makeSessionId(row.chain_id);

// Find the real file path (could be at cwd/hello.txt or cwd/workspace/hello.txt
// depending on what path the model chose)
const candidatePaths = [join(cwd, "hello.txt"), join(cwd, "workspace", "hello.txt")];
const targetFile = candidatePaths.find((p) => existsSync(p));
if (targetFile === undefined) {
  console.error("No captured file — scenario prep failed");
  process.exit(1);
}

console.log(`[before] ${targetFile} exists with: ${readFileSync(targetFile, "utf8").trim()}`);

const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: snapshotPath });
const checkpoint = createCheckpoint({
  store,
  config: {
    blobDir,
    driftDetector: NULL_DRIFT,
    resolvePath: (virtualPath: string): string => {
      if (virtualPath === cwd || virtualPath.startsWith(`${cwd}/`)) return virtualPath;
      const stripped = virtualPath.startsWith("/") ? virtualPath.slice(1) : virtualPath;
      return join(cwd, stripped);
    },
  },
});

// This is what `/rewind 1` in the TUI does (user-turn semantic).
const r = await checkpoint.rewind(engineSessionId, 1);
console.log(`[rewind 1]`, JSON.stringify(r, null, 2));
console.log(`[after] ${targetFile} ${existsSync(targetFile) ? "STILL EXISTS" : "GONE"}`);

store.close();

if (existsSync(targetFile)) {
  console.log("\n❌ FAIL: file still exists");
  process.exit(1);
}
console.log("\n✅ PASS: /rewind 1 undid the user prompt (file deleted)");
