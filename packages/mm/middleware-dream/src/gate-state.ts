/**
 * Gate state persistence for the dream middleware.
 *
 * Stores { lastDreamAt, sessionsSinceDream } in a JSON file at
 * `<memoryDir>/.dream-gate.json`. Missing or corrupted files
 * return a default zero state rather than throwing.
 *
 * Concurrency: `mutateGateState` serializes read-modify-write across
 * concurrent callers (same process via in-memory mutex; cross-process
 * via O_EXCL on `.dream-gate.lock` with brief retry). This prevents
 * lost increments when multiple sessions end at the same time.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamGateState } from "@koi/dream";

const GATE_FILE = ".dream-gate.json";
const GATE_LOCK_FILE = ".dream-gate.lock";

const DEFAULT_STATE: DreamGateState = {
  lastDreamAt: 0,
  sessionsSinceDream: 0,
} as const;

function gateFilePath(memoryDir: string): string {
  return join(memoryDir, GATE_FILE);
}

function gateLockPath(memoryDir: string): string {
  return join(memoryDir, GATE_LOCK_FILE);
}

function isValidGateState(value: unknown): value is DreamGateState {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.lastDreamAt === "number" && typeof obj.sessionsSinceDream === "number";
}

/**
 * Loads gate state from disk.
 *
 * Returns default state `{ lastDreamAt: 0, sessionsSinceDream: 0 }` if the
 * file is missing or contains invalid JSON.
 */
export async function loadGateState(memoryDir: string): Promise<DreamGateState> {
  try {
    const raw = await readFile(gateFilePath(memoryDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidGateState(parsed)) {
      return parsed;
    }
    return DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

/**
 * Saves gate state to disk.
 *
 * Writes atomically (overwrites existing file). Throws on I/O errors —
 * callers should handle persistence failures appropriately.
 */
export async function saveGateState(memoryDir: string, state: DreamGateState): Promise<void> {
  const content = JSON.stringify(state);
  await writeFile(gateFilePath(memoryDir), content, "utf-8");
}

// In-process serialization: chain mutations per directory so concurrent
// async callers in the same Bun process don't trip on read-modify-write.
const inProcessChain = new Map<string, Promise<void>>();

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_WAIT_MS = 2000;
const STALE_LOCK_AGE_MS = 5000;

async function acquireGateLock(memoryDir: string): Promise<string> {
  const lockPath = gateLockPath(memoryDir);
  const token = `${String(process.pid)}:${String(Date.now())}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      await writeFile(lockPath, token, { flag: "wx" });
      return token;
    } catch (e: unknown) {
      if (!(e instanceof Error) || (e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
      // Try to evict a stale lock (older than STALE_LOCK_AGE_MS)
      try {
        const existing = await readFile(lockPath, "utf-8");
        const tsStr = existing.split(":")[1];
        const lockedAt = tsStr === undefined ? 0 : Number(tsStr);
        if (!Number.isFinite(lockedAt) || Date.now() - lockedAt > STALE_LOCK_AGE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
    }
  }
  // Couldn't acquire — return empty token so release becomes a no-op
  return "";
}

async function releaseGateLock(memoryDir: string, token: string): Promise<void> {
  if (token === "") return;
  try {
    const current = await readFile(gateLockPath(memoryDir), "utf-8");
    if (current === token) await unlink(gateLockPath(memoryDir));
  } catch {
    // Lock already gone
  }
}

/**
 * Atomic read-modify-write of gate state.
 *
 * Serializes concurrent callers within the same process (via in-memory
 * mutex per directory) and across processes (via O_EXCL on
 * `.dream-gate.lock`). Returns the new state.
 *
 * The mutator function receives the current state and returns the new
 * state. If acquiring the cross-process lock times out, the mutation
 * still proceeds best-effort (the lock is advisory, not mandatory).
 */
export async function mutateGateState(
  memoryDir: string,
  mutate: (current: DreamGateState) => DreamGateState,
): Promise<DreamGateState> {
  const prev = inProcessChain.get(memoryDir) ?? Promise.resolve();
  let next: DreamGateState = DEFAULT_STATE;

  const work = prev.then(async () => {
    const token = await acquireGateLock(memoryDir);
    try {
      const current = await loadGateState(memoryDir);
      next = mutate(current);
      await saveGateState(memoryDir, next);
    } finally {
      await releaseGateLock(memoryDir, token);
    }
  });

  // Always reset the chain even if work throws, so a failed mutation
  // doesn't poison subsequent calls.
  inProcessChain.set(
    memoryDir,
    work.catch(() => undefined),
  );

  await work;
  return next;
}
