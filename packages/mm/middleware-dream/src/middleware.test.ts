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
});
