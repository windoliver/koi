/**
 * Checkpoint preset stack — end-of-turn workspace snapshots for /rewind.
 *
 * Captures pre/post images of files touched by tool calls and writes
 * them to a per-workspace SQLite store, so the TUI's `/rewind` command
 * can roll back to any prior turn boundary. The session transcript is
 * threaded in (via `ctx.sessionTranscript`) so rewind can truncate
 * both halves atomically.
 *
 * Contributes:
 *   - `checkpointHandle.middleware` — captures snapshots on tool calls
 *
 * Exports:
 *   - `checkpointHandle` — full handle with rewind() / capture() API,
 *     surfaced on `KoiRuntimeHandle.checkpoint` for host commands
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCheckpoint } from "@koi/checkpoint";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

export const CHECKPOINT_EXPORTS = {
  checkpointHandle: "checkpointHandle",
} as const;

export const checkpointStack: PresetStack = {
  id: "checkpoint",
  description: "End-of-turn workspace snapshots (SQLite) for /rewind",
  activate: (ctx): StackContribution => {
    const koiHomeDir = join(homedir(), ".koi");
    const snapshotDir = join(koiHomeDir, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const workspaceHash = createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 16);
    const snapshotPath = join(snapshotDir, `${workspaceHash}.sqlite`);

    // Path resolver — mirrors @koi/fs-local's lexicalCheck normalization
    // so the checkpoint middleware reads pre/post images from the REAL
    // filesystem path, not the virtual path the model sees.
    const resolveCheckpointPath = (virtualPath: string): string => {
      if (virtualPath === ctx.cwd || virtualPath.startsWith(`${ctx.cwd}/`)) {
        return virtualPath;
      }
      const stripped = virtualPath.startsWith("/") ? virtualPath.slice(1) : virtualPath;
      return join(ctx.cwd, stripped);
    };

    const checkpointHandle = createCheckpoint({
      store: createSnapshotStoreSqlite({ path: snapshotPath }),
      config: {
        blobDir: join(koiHomeDir, "file-history"),
        driftDetector: null,
        resolvePath: resolveCheckpointPath,
        ...(ctx.sessionTranscript !== undefined ? { transcript: ctx.sessionTranscript } : {}),
      },
    });

    return {
      middleware: [checkpointHandle.middleware],
      providers: [],
      exports: {
        [CHECKPOINT_EXPORTS.checkpointHandle]: checkpointHandle,
      },
    };
  },
};
