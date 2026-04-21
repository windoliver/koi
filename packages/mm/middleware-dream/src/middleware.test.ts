/**
 * Tests for the dream consolidation middleware.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionContext } from "@koi/core";
import * as dreamModule from "@koi/dream";
import { createDreamMiddleware } from "./middleware.js";
import type { DreamMiddlewareConfig } from "./types.js";

const TEST_DIR = join(import.meta.dir, "__test_mw_tmp__");

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "test-session" as SessionContext["sessionId"],
    runId: "test-run" as SessionContext["runId"],
    metadata: {},
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<DreamMiddlewareConfig>): DreamMiddlewareConfig {
  return {
    memoryDir: TEST_DIR,
    listMemories: mock(async () => []),
    writeMemory: mock(async () => undefined),
    deleteMemory: mock(async () => undefined),
    modelCall: mock(async () => ({
      content: "",
      model: "test-model",
    })),
    ...overrides,
  };
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("createDreamMiddleware", () => {
  it("increments sessionsSinceDream but does not consolidate when gate is not triggered", async () => {
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation");

    const config = makeConfig({
      // Gate requires 5 sessions by default — only 1 session passes here
      minSessionsSinceLastDream: 5,
      minTimeSinceLastDreamMs: 0,
    });
    const mw = createDreamMiddleware(config);
    const ctx = makeSessionCtx();

    await mw.onSessionEnd?.(ctx);

    // Give fire-and-forget a tick to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runConsolidationSpy).not.toHaveBeenCalled();
    runConsolidationSpy.mockRestore();
  });

  it("runs consolidation in background when gate is triggered", async () => {
    const dreamResult = { merged: 1, pruned: 0, unchanged: 3, durationMs: 10 };
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation").mockResolvedValue(
      dreamResult,
    );

    const onDreamComplete = mock<(result: typeof dreamResult) => void>(() => undefined);
    const config = makeConfig({
      // Set low thresholds so 1 session triggers the gate
      minSessionsSinceLastDream: 1,
      minTimeSinceLastDreamMs: 0,
      onDreamComplete,
    });
    const mw = createDreamMiddleware(config);
    const ctx = makeSessionCtx();

    await mw.onSessionEnd?.(ctx);

    // Wait for the background consolidation to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(runConsolidationSpy).toHaveBeenCalledTimes(1);
    expect(onDreamComplete).toHaveBeenCalledWith(dreamResult);

    runConsolidationSpy.mockRestore();
  });

  it("skips consolidation when lock is already held", async () => {
    const { writeFile } = await import("node:fs/promises");

    // Pre-create the lock file with the current process PID + fresh timestamp
    // so acquireLock sees a live owner and does not clear it as stale.
    await writeFile(join(TEST_DIR, ".dream.lock"), `${String(process.pid)}:${String(Date.now())}`, {
      flag: "w",
    });

    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation");

    const config = makeConfig({
      minSessionsSinceLastDream: 1,
      minTimeSinceLastDreamMs: 0,
    });
    const mw = createDreamMiddleware(config);
    const ctx = makeSessionCtx();

    await mw.onSessionEnd?.(ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(runConsolidationSpy).not.toHaveBeenCalled();
    runConsolidationSpy.mockRestore();
  });

  it("calls onDreamError when consolidation throws", async () => {
    const consolidationError = new Error("model unavailable");
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation").mockRejectedValue(
      consolidationError,
    );

    const onDreamError = mock<(error: unknown) => void>(() => undefined);
    const config = makeConfig({
      minSessionsSinceLastDream: 1,
      minTimeSinceLastDreamMs: 0,
      onDreamError,
    });
    const mw = createDreamMiddleware(config);
    const ctx = makeSessionCtx();

    await mw.onSessionEnd?.(ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onDreamError).toHaveBeenCalledWith(consolidationError);
    runConsolidationSpy.mockRestore();
  });

  it("has correct name and priority", () => {
    const mw = createDreamMiddleware(makeConfig());
    expect(mw.name).toBe("koi:dream");
    expect(mw.priority).toBe(320);
  });

  it("describeCapabilities returns undefined", () => {
    const mw = createDreamMiddleware(makeConfig());
    // describeCapabilities takes TurnContext — cast through unknown to satisfy branded TurnId
    const ctx = {
      session: makeSessionCtx(),
      turnIndex: 0,
      turnId: "turn-0",
      messages: [],
      metadata: {},
    } as unknown as Parameters<typeof mw.describeCapabilities>[0];
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });

  it("two sequential onSessionEnd calls increment counter to 2", async () => {
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation");
    const config = makeConfig({ minSessionsSinceLastDream: 99, minTimeSinceLastDreamMs: 0 });
    const mw = createDreamMiddleware(config);

    await mw.onSessionEnd?.(makeSessionCtx());
    await mw.onSessionEnd?.(makeSessionCtx());

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(TEST_DIR, ".dream-gate.json"), "utf8");
    const state = JSON.parse(raw) as { sessionsSinceDream: number };
    expect(state.sessionsSinceDream).toBe(2);
    expect(runConsolidationSpy).not.toHaveBeenCalled();
    runConsolidationSpy.mockRestore();
  });

  it("gate state is NOT zeroed when consolidation fails", async () => {
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation").mockRejectedValue(
      new Error("boom"),
    );
    const config = makeConfig({ minSessionsSinceLastDream: 1, minTimeSinceLastDreamMs: 0 });
    const mw = createDreamMiddleware(config);

    await mw.onSessionEnd?.(makeSessionCtx());
    await new Promise((r) => setTimeout(r, 100));

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(TEST_DIR, ".dream-gate.json"), "utf8");
    const state = JSON.parse(raw) as { sessionsSinceDream: number; lastDreamAt: number };
    // After failure: counter still 1, lastDreamAt untouched (0)
    expect(state.sessionsSinceDream).toBe(1);
    expect(state.lastDreamAt).toBe(0);
    runConsolidationSpy.mockRestore();
  });

  it("lock is released after consolidation failure", async () => {
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation").mockRejectedValue(
      new Error("boom"),
    );
    const config = makeConfig({ minSessionsSinceLastDream: 1, minTimeSinceLastDreamMs: 0 });
    const mw = createDreamMiddleware(config);

    await mw.onSessionEnd?.(makeSessionCtx());
    await new Promise((r) => setTimeout(r, 100));

    const { access } = await import("node:fs/promises");
    let lockExists = true;
    try {
      await access(join(TEST_DIR, ".dream.lock"));
    } catch {
      lockExists = false;
    }
    expect(lockExists).toBe(false);
    runConsolidationSpy.mockRestore();
  });

  it("evicts stale lock with dead PID and proceeds", async () => {
    const { writeFile } = await import("node:fs/promises");
    // PID 99999 is unlikely to be a live process on macOS/Linux test runners
    await writeFile(join(TEST_DIR, ".dream.lock"), `99999:${String(Date.now())}`, { flag: "w" });

    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation").mockResolvedValue({
      merged: 0,
      pruned: 0,
      unchanged: 0,
      durationMs: 1,
    });
    const config = makeConfig({ minSessionsSinceLastDream: 1, minTimeSinceLastDreamMs: 0 });
    const mw = createDreamMiddleware(config);

    await mw.onSessionEnd?.(makeSessionCtx());
    await new Promise((r) => setTimeout(r, 100));

    expect(runConsolidationSpy).toHaveBeenCalledTimes(1);
    runConsolidationSpy.mockRestore();
  });

  it("monotonic update preserves session increments during consolidation", async () => {
    let resolveConsolidation: (() => void) | undefined;
    const consolidationPromise = new Promise<void>((r) => {
      resolveConsolidation = r;
    });
    const runConsolidationSpy = spyOn(dreamModule, "runDreamConsolidation").mockImplementation(
      async () => {
        await consolidationPromise;
        return { merged: 0, pruned: 0, unchanged: 0, durationMs: 1 };
      },
    );

    const config = makeConfig({ minSessionsSinceLastDream: 1, minTimeSinceLastDreamMs: 0 });
    const mw = createDreamMiddleware(config);

    // Session 1: triggers consolidation (baseline=1, sessionsSinceDream=1)
    await mw.onSessionEnd?.(makeSessionCtx());
    // Sessions 2 & 3 land while consolidation is in-flight
    await mw.onSessionEnd?.(makeSessionCtx());
    await mw.onSessionEnd?.(makeSessionCtx());

    // Now let consolidation finish — monotonic update should preserve sessions 2 & 3
    resolveConsolidation?.();
    await new Promise((r) => setTimeout(r, 100));

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(TEST_DIR, ".dream-gate.json"), "utf8");
    const state = JSON.parse(raw) as { sessionsSinceDream: number };
    // After consolidation: max(0, 3 - 1) = 2 sessions remain
    expect(state.sessionsSinceDream).toBe(2);
    runConsolidationSpy.mockRestore();
  });
});
