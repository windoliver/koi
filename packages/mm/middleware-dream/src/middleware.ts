/**
 * Dream consolidation middleware.
 *
 * Fires background memory consolidation at session end when the dream gate
 * conditions are met (sufficient sessions and time elapsed since last dream).
 *
 * Priority 320: after extraction (305) and hot-memory (310).
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityFragment, KoiMiddleware, SessionContext, TurnContext } from "@koi/core";
import { runDreamConsolidation, shouldDream } from "@koi/dream";
import { loadGateState, saveGateState } from "./gate-state.js";
import type { DreamMiddlewareConfig } from "./types.js";

const LOCK_FILE = ".dream.lock";

function lockFilePath(memoryDir: string): string {
  return join(memoryDir, LOCK_FILE);
}

/** Returns true if a PID corresponds to a live process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquires the dream lock using O_EXCL (atomic create).
 *
 * Lock content: `"<pid>:<token>"` where token is an instance-unique string
 * passed in by the caller. On EEXIST, checks whether the owning PID is still
 * alive. Evicts the lock only if the owner is confirmed dead. Returns `false`
 * only when a live process genuinely holds the lock.
 *
 * Returns the token string on success (needed for ownership-safe release),
 * or `null` on contention.
 */
async function acquireLock(memoryDir: string, token: string): Promise<boolean> {
  const path = lockFilePath(memoryDir);
  const content = `${String(process.pid)}:${token}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, content, { flag: "wx" });
      return true;
    } catch (e: unknown) {
      if (!(e !== null && typeof e === "object" && "code" in e && e.code === "EEXIST")) {
        throw e;
      }
      // Lock exists — evict only if owner is dead
      try {
        const existing = await readFile(path, "utf8");
        const [pidStr] = existing.split(":");
        const ownerPid = Number(pidStr);
        const ownerAlive = Number.isFinite(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid);
        if (ownerAlive) return false; // live owner, genuine contention
        // Owner is dead — clear stale lock and retry
        await unlink(path).catch(() => undefined);
      } catch {
        // Can't read lock — assume stale, retry once
        await unlink(path).catch(() => undefined);
      }
    }
  }
  return false;
}

/**
 * Releases the lock only if this process still owns it (pid + token match).
 * Prevents a slow consolidation from deleting a lock acquired by a newer run.
 */
async function releaseLock(memoryDir: string, token: string): Promise<void> {
  const path = lockFilePath(memoryDir);
  try {
    const existing = await readFile(path, "utf8");
    const [pidStr, existingToken] = existing.split(":");
    if (Number(pidStr) === process.pid && existingToken === token) {
      await unlink(path);
    }
  } catch {
    // Best-effort — lock may have already been cleaned up
  }
}

/**
 * Runs dream consolidation in the background (fire-and-forget).
 *
 * Acquires a process-exclusive lock before starting. If the lock is already
 * held by a live process, consolidation is skipped for this session.
 *
 * Gate state is updated monotonically: reloads the current counter before
 * writing zero, so sessions that ended during consolidation are not erased.
 */
async function runConsolidationBackground(
  config: DreamMiddlewareConfig,
  sessionBaseline: number,
  token: string,
): Promise<void> {
  const locked = await acquireLock(config.memoryDir, token);
  if (!locked) return;

  try {
    const result = await runDreamConsolidation({
      listMemories: config.listMemories,
      writeMemory: config.writeMemory,
      deleteMemory: config.deleteMemory,
      modelCall: config.modelCall,
      ...(config.consolidationModel !== undefined
        ? { consolidationModel: config.consolidationModel }
        : {}),
      ...(config.mergeThreshold !== undefined ? { mergeThreshold: config.mergeThreshold } : {}),
      ...(config.pruneThreshold !== undefined ? { pruneThreshold: config.pruneThreshold } : {}),
    });

    config.onDreamComplete?.(result);

    // Monotonic gate update: subtract only the sessions consumed by this run.
    // Sessions that arrived while consolidation was running are preserved.
    const current = await loadGateState(config.memoryDir);
    const remaining = Math.max(0, current.sessionsSinceDream - sessionBaseline);
    await saveGateState(config.memoryDir, {
      lastDreamAt: Date.now(),
      sessionsSinceDream: remaining,
    });
  } catch (e: unknown) {
    config.onDreamError?.(e);
  } finally {
    await releaseLock(config.memoryDir, token);
  }
}

/**
 * Creates the dream middleware.
 *
 * On session end:
 * 1. Loads gate state from disk
 * 2. Increments `sessionsSinceDream`
 * 3. Saves updated gate state
 * 4. Checks dream gate conditions
 * 5. If triggered and no lock held: fires consolidation in the background
 */
export function createDreamMiddleware(config: DreamMiddlewareConfig): KoiMiddleware {
  return {
    name: "koi:dream",
    priority: 320,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return undefined;
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      let state = await loadGateState(config.memoryDir);

      state = {
        lastDreamAt: state.lastDreamAt,
        sessionsSinceDream: state.sessionsSinceDream + 1,
      };

      try {
        await saveGateState(config.memoryDir, state);
      } catch {
        // Don't block session cleanup on persistence failures
      }

      const gateOptions: {
        readonly minSessionsSinceLastDream?: number;
        readonly minTimeSinceLastDreamMs?: number;
      } = {
        ...(config.minSessionsSinceLastDream !== undefined
          ? { minSessionsSinceLastDream: config.minSessionsSinceLastDream }
          : {}),
        ...(config.minTimeSinceLastDreamMs !== undefined
          ? { minTimeSinceLastDreamMs: config.minTimeSinceLastDreamMs }
          : {}),
      };
      const triggered = shouldDream(state, gateOptions);

      if (!triggered) return;

      // Generate a unique token per consolidation run for ownership-safe release
      const token = Math.random().toString(36).slice(2);
      const baseline = state.sessionsSinceDream;

      // Fire-and-forget — do not await, do not propagate errors
      runConsolidationBackground(config, baseline, token).catch(() => {
        // Swallow — observability is handled inside runConsolidationBackground
      });
    },
  };
}
