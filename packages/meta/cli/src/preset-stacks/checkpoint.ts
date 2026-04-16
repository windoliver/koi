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
import type { FileSystemBackend } from "@koi/core";
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

    // Backend discriminator wiring.
    //
    // Checkpoint capture reads file pre/post images from the LOCAL filesystem
    // (via Bun.file + CAS hashing). For non-local backends (nexus), the files
    // live remotely and cannot be captured through local I/O. Until checkpoint
    // capture is wired through FileSystemBackend.read(), disable checkpoint
    // for non-local backends to avoid creating unrecoverable snapshots.
    const fsBackend: FileSystemBackend | undefined = ctx.filesystem;
    // Detect truly remote backends (nexus) vs. locally-backed wrappers (scoped).
    // scoped(local) and scoped(fs-local:...) still read from local disk — safe for checkpoint.
    // Only nexus backends (name starts with "nexus") have remote files inaccessible via local I/O.
    const isRemoteBackend =
      fsBackend !== undefined &&
      (fsBackend.name.startsWith("nexus") || fsBackend.name.includes("nexus"));

    if (isRemoteBackend) {
      // Return a no-op StackContribution — checkpoint is disabled for non-local backends.
      // This preserves the existing contract (no crash, no middleware gap) while avoiding
      // the creation of snapshots that reference remote paths but capture local content.
      process.stderr.write(
        `[checkpoint] /rewind disabled for non-local backend '${fsBackend.name}'. ` +
          `Checkpoint capture requires local filesystem access.\n`,
      );
      return { middleware: [], providers: [] };
    }

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
      // When the host (e.g. `koi tui` /clear) reuses the same
      // session id across resets, the engine's cycleSession does
      // NOT rotate the checkpoint chain — the chain is keyed on
      // sessionId and would otherwise continue accumulating new
      // snapshots on top of pre-clear history. Reset the chain
      // explicitly here so `/rewind` after quit + resume cannot
      // walk back into snapshots from before the clear boundary.
      //
      // MUST read `resetContext.sessionId` (the live runtime
      // session id at reset time) rather than a value snapshotted
      // during `activate`. Hosts can call `rebindSessionId(...)`
      // between activation and reset — e.g. `koi tui` rebinds
      // after `/rewind` — and a stale snapshot would prune the
      // wrong chain, leaving the live session's pre-clear
      // snapshots rewindable.
      //
      // Throws on prune failure — propagated by the factory as
      // part of an AggregateError so `/clear` fails closed and
      // the caller flags the reset as unpersisted.
      //
      // Gated on `resetContext.truncate`: only fire on destructive
      // boundaries (`/clear`, `/new`). Non-destructive resets —
      // picker session switches and post-rewind in-memory rebuilds
      // — explicitly preserve durable state, and pruning the chain
      // there would silently erase the very history the user just
      // chose to keep (a successful `/rewind` would lose its
      // landing target; a picker open would erase the startup
      // session's chain even though that flow is documented as
      // non-destructive).
      onResetSession: async (_signal, resetContext): Promise<void> => {
        if (!resetContext.truncate) return;
        await checkpointHandle.resetSession(resetContext.sessionId);
      },
    };
  },
};
