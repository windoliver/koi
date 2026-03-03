import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ForgeStore, KoiError, Result, ToolArtifact } from "@koi/core";
import type { AutoForgeVerifier } from "./auto-forge-middleware.js";
import { createAutoForgeMiddleware } from "./auto-forge-middleware.js";
import type { CrystallizedToolDescriptor } from "./forge-handler.js";
import type { CrystallizationCandidate, CrystallizeHandle } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCandidate(
  toolIds: readonly string[],
  occurrences: number,
  detectedAt: number,
): CrystallizationCandidate {
  const key = toolIds.join("|");
  return {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt,
    suggestedName: toolIds.join("-then-"),
  };
}

function createMockForgeStore(overrides?: Partial<ForgeStore>): ForgeStore {
  return {
    save: mock(async (): Promise<Result<void, KoiError>> => ({ ok: true, value: undefined })),
    load: mock(
      async () =>
        ({
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        }) as Result<never, KoiError>,
    ),
    search: mock(async () => ({ ok: true, value: [] }) as Result<readonly never[], KoiError>),
    remove: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    update: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    exists: mock(async () => ({ ok: true, value: false }) as Result<boolean, KoiError>),
    ...overrides,
  };
}

function createMockCrystallizeHandle(
  candidates: readonly CrystallizationCandidate[] = [],
): CrystallizeHandle {
  return {
    middleware: { name: "crystallize", describeCapabilities: () => undefined },
    getCandidates: () => candidates,
    dismiss: mock(() => {}),
  };
}

function createMockTurnContext(turnIndex = 0): { readonly turnIndex: number } {
  return { turnIndex } as { readonly turnIndex: number };
}

// Flush microtasks to let fire-and-forget promises settle
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// createAutoForgeMiddleware
// ---------------------------------------------------------------------------

describe("createAutoForgeMiddleware", () => {
  let store: ForgeStore;

  beforeEach(() => {
    store = createMockForgeStore();
  });

  test("forges candidates above threshold and saves to store", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);
    const onForged = mock((_: CrystallizedToolDescriptor) => {});

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      confidenceThreshold: 0.0, // forge everything
      clock: () => 1000,
      onForged,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalled();
    expect(onForged).toHaveBeenCalledTimes(1);
  });

  test("does not forge candidates below threshold", async () => {
    // Old candidate (far in the past) => low confidence
    const candidates = [createCandidate(["fetch", "parse"], 5, 0)];
    const handle = createMockCrystallizeHandle(candidates);
    const onSuggested = mock((_: CrystallizationCandidate) => {});

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      confidenceThreshold: 0.99,
      clock: () => 100_000_000,
      onSuggested,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).not.toHaveBeenCalled();
    expect(onSuggested).toHaveBeenCalledTimes(1);
  });

  test("respects maxForgedPerSession", async () => {
    const candidates = [
      createCandidate(["a", "b"], 5, 1000),
      createCandidate(["c", "d"], 5, 1000),
      createCandidate(["e", "f"], 5, 1000),
    ];
    const handle = createMockCrystallizeHandle(candidates);

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      confidenceThreshold: 0.0,
      maxForgedPerSession: 2,
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalledTimes(2);
  });

  test("verification failure prevents brick from being saved", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);
    const onError = mock((_: unknown) => {});

    const failingVerifier: AutoForgeVerifier = {
      name: "test-verifier",
      verify: async () => ({ passed: false, message: "unsafe pattern" }),
    };

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      confidenceThreshold: 0.0,
      verifyPipeline: [failingVerifier],
      clock: () => 1000,
      onError,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("store save failure logs error without throwing", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);
    const onError = mock((_: unknown) => {});

    const failingStore = createMockForgeStore({
      save: mock(
        async (): Promise<Result<void, KoiError>> => ({
          ok: false,
          error: { code: "INTERNAL", message: "disk full", retryable: false },
        }),
      ),
    });

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: failingStore,
      scope: "agent",
      confidenceThreshold: 0.0,
      clock: () => 1000,
      onError,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(failingStore.save).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  test("does nothing when no candidates", async () => {
    const handle = createMockCrystallizeHandle([]);

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).not.toHaveBeenCalled();
  });

  test("describeCapabilities returns undefined when nothing forged", () => {
    const handle = createMockCrystallizeHandle([]);

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
    });

    const cap = mw.describeCapabilities(createMockTurnContext() as never);
    expect(cap).toBeUndefined();
  });

  test("passing verifiers allows save", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);

    const passingVerifier: AutoForgeVerifier = {
      name: "ok-verifier",
      verify: async () => ({ passed: true }),
    };

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      confidenceThreshold: 0.0,
      verifyPipeline: [passingVerifier],
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalledTimes(1);
  });

  test("saved brick has correct shape", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "zone",
      trustTier: "verified",
      confidenceThreshold: 0.0,
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalledTimes(1);
    const savedBrick = (store.save as ReturnType<typeof mock>).mock.calls[0]?.[0] as ToolArtifact;
    expect(savedBrick.kind).toBe("tool");
    expect(savedBrick.scope).toBe("zone");
    expect(savedBrick.trustTier).toBe("verified");
    expect(savedBrick.name).toBe("fetch-then-parse");
    expect(savedBrick.lifecycle).toBe("active");
    expect(savedBrick.tags).toContain("crystallized");
    expect(savedBrick.tags).toContain("auto-forged");
    expect(savedBrick.provenance.source.origin).toBe("forged");
  });
});
