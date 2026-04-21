/**
 * `koi dream` — run dream memory consolidation immediately.
 *
 * Checks the dream gate (unless --force), acquires a cross-process lock,
 * runs consolidation, saves updated gate state, and prints the result.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliFlags } from "../args.js";
import { isDreamFlags } from "../args.js";
import type { ExitCode as ExitCodeType } from "../types.js";
import { ExitCode } from "../types.js";

// ---------------------------------------------------------------------------
// Gate state helpers
// ---------------------------------------------------------------------------

interface GateState {
  readonly lastDreamAt: number;
  readonly sessionsSinceDream: number;
}

const DEFAULT_GATE_STATE: GateState = { lastDreamAt: 0, sessionsSinceDream: 0 };

async function loadGateState(path: string): Promise<GateState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "lastDreamAt" in parsed &&
      "sessionsSinceDream" in parsed &&
      typeof (parsed as Record<string, unknown>).lastDreamAt === "number" &&
      typeof (parsed as Record<string, unknown>).sessionsSinceDream === "number"
    ) {
      return {
        lastDreamAt: (parsed as Record<string, unknown>).lastDreamAt as number,
        sessionsSinceDream: (parsed as Record<string, unknown>).sessionsSinceDream as number,
      };
    }
    return DEFAULT_GATE_STATE;
  } catch {
    return DEFAULT_GATE_STATE;
  }
}

async function saveGateState(path: string, state: GateState): Promise<void> {
  await writeFile(path, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(flags: CliFlags): Promise<ExitCodeType> {
  if (!isDreamFlags(flags)) return ExitCode.FAILURE;

  const memoryDir = flags.memoryDir ?? join(homedir(), ".koi", "memory");
  const lockPath = join(memoryDir, ".dream.lock");
  const gatePath = join(memoryDir, ".dream-gate.json");

  // Resolve credentials from environment only — no argv exposure
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (apiKey === undefined) {
    process.stderr.write(
      "error: no API key found. Set OPENROUTER_API_KEY or OPENAI_API_KEY, or pass --api-key\n",
    );
    return ExitCode.FAILURE;
  }

  const modelUrl =
    flags.modelUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  // Ensure memory directory exists before any file operations
  await mkdir(memoryDir, { recursive: true });

  // Lazy imports to keep startup fast
  const [
    { shouldDream, runDreamConsolidation },
    { createMemoryStore },
    { createOpenAICompatAdapter },
  ] = await Promise.all([
    import("@koi/dream"),
    import("@koi/memory-fs"),
    import("@koi/model-openai-compat"),
  ]);

  const gateState = await loadGateState(gatePath);

  if (!flags.force && !shouldDream(gateState)) {
    const secsSinceLast =
      gateState.lastDreamAt === 0
        ? "never"
        : `${Math.round((Date.now() - gateState.lastDreamAt) / 1000)}s ago`;
    process.stdout.write(
      `Dream gate not triggered (${String(gateState.sessionsSinceDream)} sessions since last dream, last dream: ${secsSinceLast})\n`,
    );
    return ExitCode.OK;
  }

  // Acquire cross-process lock — evict only if the owning PID is dead
  const lockToken = `${String(process.pid)}:${String(Date.now())}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, lockToken, { flag: "wx" });
      break; // acquired
    } catch (e: unknown) {
      if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST")) throw e;
      // Check whether the existing lock owner is alive
      try {
        const existing = await readFile(lockPath, "utf8");
        const ownerPid = Number(existing.split(":")[0]);
        if (Number.isFinite(ownerPid) && ownerPid > 0) {
          try {
            process.kill(ownerPid, 0); // throws if dead
            // Owner is alive — respect the lock
            process.stdout.write("Dream already running (lock held by another process)\n");
            return ExitCode.OK;
          } catch {
            // Owner is dead — remove stale lock and retry
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        }
      } catch {
        // Can't read lock — assume stale
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      process.stdout.write("Dream already running (lock held by another process)\n");
      return ExitCode.OK;
    }
  }

  const startedAt = Date.now();
  try {
    const store = createMemoryStore({ dir: memoryDir });
    const model = flags.model ?? "openai/gpt-4o-mini";
    const adapter = createOpenAICompatAdapter({ apiKey, baseUrl: modelUrl, model });

    const result = await runDreamConsolidation({
      listMemories: () => store.list(),
      writeMemory: (input) => store.write(input).then(() => undefined),
      deleteMemory: (id) => store.delete(id).then(() => undefined),
      modelCall: adapter.complete,
      consolidationModel: flags.model,
    });

    const updatedGate: GateState = { lastDreamAt: Date.now(), sessionsSinceDream: 0 };
    await saveGateState(gatePath, updatedGate);

    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { ...result, durationMs: Date.now() - startedAt } }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `Dream complete: ${String(result.merged)} merged, ${String(result.pruned)} pruned, ${String(result.unchanged)} unchanged (${String(Date.now() - startedAt)}ms)\n`,
      );
    }

    return ExitCode.OK;
  } finally {
    // Only release the lock if we still own it (token match)
    try {
      const current = await readFile(lockPath, "utf8");
      if (current === lockToken) await unlink(lockPath);
    } catch {
      // Lock already gone or unreadable — nothing to do
    }
  }
}
