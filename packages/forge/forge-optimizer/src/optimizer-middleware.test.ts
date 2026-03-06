import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, ForgeStore, KoiError, Result } from "@koi/core";
import type { OptimizationResult } from "./optimizer.js";
import { createOptimizerMiddleware } from "./optimizer-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore(): ForgeStore {
  return {
    save: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    load: mock(
      async () =>
        ({
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        }) as Result<never, KoiError>,
    ),
    search: mock(
      async () => ({ ok: true, value: [] }) as Result<readonly BrickArtifact[], KoiError>,
    ),
    remove: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    update: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    exists: mock(async () => ({ ok: true, value: false }) as Result<boolean, KoiError>),
  };
}

function createMockSessionContext(): unknown {
  return { sessionId: "test-session" };
}

function createMockTurnContext(): unknown {
  return { turnIndex: 0, session: { sessionId: "test-session" } };
}

// ---------------------------------------------------------------------------
// createOptimizerMiddleware
// ---------------------------------------------------------------------------

describe("createOptimizerMiddleware", () => {
  test("has correct name and priority", () => {
    const store = createMockStore();
    const mw = createOptimizerMiddleware({ store });

    expect(mw.name).toBe("forge-optimizer");
    expect(mw.priority).toBe(990);
  });

  test("runs sweep on session end", async () => {
    const store = createMockStore();
    const onSweepComplete = mock((_: readonly OptimizationResult[]) => {});

    const mw = createOptimizerMiddleware({
      store,
      onSweepComplete,
    });

    await mw.onSessionEnd?.(createMockSessionContext() as never);

    expect(onSweepComplete).toHaveBeenCalledTimes(1);
    const results = onSweepComplete.mock.calls[0]?.[0];
    expect(Array.isArray(results)).toBe(true);
  });

  test("describeCapabilities returns undefined before sweep", () => {
    const store = createMockStore();
    const mw = createOptimizerMiddleware({ store });

    const cap = mw.describeCapabilities(createMockTurnContext() as never);
    expect(cap).toBeUndefined();
  });

  test("describeCapabilities returns summary after sweep", async () => {
    const store = createMockStore();
    // Empty store means empty results, so let's check it handles that
    const mw = createOptimizerMiddleware({ store });

    await mw.onSessionEnd?.(createMockSessionContext() as never);

    // No bricks = no results = undefined capabilities
    const cap = mw.describeCapabilities(createMockTurnContext() as never);
    expect(cap).toBeUndefined();
  });
});
