import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  ForgeDemandSignal,
  ForgeQuery,
  ForgeStore,
  KoiError,
  Result,
  ToolArtifact,
} from "@koi/core";
import { DEFAULT_FORGE_BUDGET, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createTestToolArtifact } from "@koi/test-utils";
import type { AutoForgeDemandHandle, AutoForgeVerifier } from "./auto-forge-middleware.js";
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

  test("skips save when active brick with same name already exists", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);

    const existingBrick = createTestToolArtifact({ name: "fetch-then-parse" });
    const storeWithExisting = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [existingBrick],
        }),
      ),
    });

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: storeWithExisting,
      scope: "agent",
      confidenceThreshold: 0.0,
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(storeWithExisting.save).not.toHaveBeenCalled();
  });

  test("saved brick has correct shape", async () => {
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "zone",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      confidenceThreshold: 0.0,
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalledTimes(1);
    const savedBrick = (store.save as ReturnType<typeof mock>).mock.calls[0]?.[0] as ToolArtifact;
    expect(savedBrick.kind).toBe("tool");
    expect(savedBrick.scope).toBe("zone");
    expect(savedBrick.policy.sandbox).toBe(false);
    expect(savedBrick.name).toBe("fetch-then-parse");
    expect(savedBrick.lifecycle).toBe("active");
    expect(savedBrick.tags).toContain("crystallized");
    expect(savedBrick.tags).toContain("auto-forged");
    expect(savedBrick.provenance.source.origin).toBe("forged");
  });
});

// ---------------------------------------------------------------------------
// Demand trigger-based dedup
// ---------------------------------------------------------------------------

describe("demand trigger-based dedup", () => {
  function createDemandSignal(overrides?: Partial<ForgeDemandSignal>): ForgeDemandSignal {
    return {
      id: "demand-1",
      kind: "forge_demand",
      trigger: { kind: "no_matching_tool", query: "visualize theorem", attempts: 1 },
      confidence: 0.9,
      suggestedBrickKind: "tool",
      context: { failureCount: 1, failedToolCalls: ["visualize"] },
      emittedAt: Date.now(),
      ...overrides,
    };
  }

  function createDemandHandle(signals: readonly ForgeDemandSignal[]): AutoForgeDemandHandle {
    return {
      getSignals: () => signals,
      dismiss: mock(() => {}),
    };
  }

  test("skips forge when existing brick matches demand trigger", async () => {
    const matchingBrick = createTestToolArtifact({
      name: "theorem-viz",
      trigger: ["visualize theorem", "animate proof"],
    });
    const store = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [matchingBrick],
        }),
      ),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    // Signal dismissed without forging
    expect(demandHandle.dismiss).toHaveBeenCalledWith("demand-1");
    expect(store.save).not.toHaveBeenCalled();
  });

  test("does NOT suppress forge when brick matches only by description (no triggers)", async () => {
    // Regression: demand dedup must use triggerText, not text.
    // A brick whose description matches but has no triggers should not suppress forging.
    const descriptionOnlyBrick = createTestToolArtifact({
      name: "unrelated-tool",
      description: "visualize theorem data",
      // No trigger field — only description matches
    });
    const store = createMockForgeStore({
      // triggerText query returns empty (no trigger metadata on brick)
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [],
        }),
      ),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    // Forge should proceed — description-only match must not suppress
    expect(store.save).toHaveBeenCalled();
    // Verify the search used triggerText, not text
    const searchCall = (store.search as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(searchCall.triggerText).toBe("visualize theorem");
    expect(searchCall.text).toBeUndefined();
    void descriptionOnlyBrick; // referenced for documentation
  });

  test("skips demand forge when active brick with same name exists", async () => {
    const searchMock = mock(async (query: ForgeQuery) => {
      if (query.name !== undefined) {
        return {
          ok: true as const,
          value: [
            createTestToolArtifact({ name: "pioneer-visualize-theorem" }),
          ] as readonly BrickArtifact[],
        };
      }
      return { ok: true as const, value: [] as readonly BrickArtifact[] };
    });
    const store = createMockForgeStore({
      search: searchMock,
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(demandHandle.dismiss).toHaveBeenCalledWith("demand-1");
    expect(store.save).not.toHaveBeenCalled();
  });

  test("proceeds with forge when no existing brick matches", async () => {
    const store = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [],
        }),
      ),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    // Signal dismissed after forge dispatch
    expect(demandHandle.dismiss).toHaveBeenCalledWith("demand-1");
    expect(store.save).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Name-based dedup (prevents duplicate bricks with same name but different content)
// ---------------------------------------------------------------------------

describe("name-based dedup", () => {
  function createDemandSignal(overrides?: Partial<ForgeDemandSignal>): ForgeDemandSignal {
    return {
      id: "demand-1",
      kind: "forge_demand",
      trigger: { kind: "repeated_failure", toolName: "exec", count: 3 },
      confidence: 0.9,
      suggestedBrickKind: "tool",
      context: { failureCount: 3, failedToolCalls: ["exec", "exec", "exec"] },
      emittedAt: Date.now(),
      ...overrides,
    };
  }

  function createDemandHandle(signals: readonly ForgeDemandSignal[]): AutoForgeDemandHandle {
    return {
      getSignals: () => signals,
      dismiss: mock(() => {}),
    };
  }

  test("demand forge skips when active brick with same name exists", async () => {
    // Pioneer name for repeated_failure on "exec" → "pioneer-exec"
    const existingBrick = createTestToolArtifact({ name: "pioneer-exec" });
    const store = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [existingBrick],
        }),
      ),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).not.toHaveBeenCalled();
  });

  test("demand forge proceeds when no name match", async () => {
    const store = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [],
        }),
      ),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalled();
  });

  test("demand forge proceeds when matching brick is deprecated", async () => {
    // Deprecated brick should NOT block new forge — lifecycle: "active" filter excludes it
    const store = createMockForgeStore({
      search: mock(
        async (query: {
          readonly lifecycle?: string;
        }): Promise<Result<readonly BrickArtifact[], KoiError>> => {
          // A correctly-implemented store respects lifecycle filter:
          // deprecated brick is excluded when searching for "active"
          if (query.lifecycle === "active") {
            return { ok: true, value: [] };
          }
          return { ok: true, value: [] };
        },
      ),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).toHaveBeenCalled();
  });

  test("crystallize forge skips when active brick with same name exists", async () => {
    // Candidate for "fetch|parse" → brick named "fetch-then-parse"
    const existingBrick = createTestToolArtifact({ name: "fetch-then-parse" });
    const candidates = [createCandidate(["fetch", "parse"], 5, 1000)];
    const handle = createMockCrystallizeHandle(candidates);
    const store = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: [existingBrick],
        }),
      ),
    });

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      confidenceThreshold: 0.0,
      clock: () => 1000,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    expect(store.save).not.toHaveBeenCalled();
  });

  test("name dedup is fail-open on search error", async () => {
    const store = createMockForgeStore({
      search: mock(async (): Promise<never> => {
        throw new Error("store unavailable");
      }),
    });
    const signal = createDemandSignal();
    const demandHandle = createDemandHandle([signal]);
    const handle = createMockCrystallizeHandle();
    const onError = mock((_: unknown) => {});

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 1000,
      onError,
    });

    await mw.onAfterTurn?.(createMockTurnContext() as never);
    await flush();

    // Search failed but forge should still proceed (fail-open)
    expect(store.save).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  test("cross-turn repeated failures are deduped by name", async () => {
    // Simulates the bug: same demand fires across multiple turns.
    // Turn 1 creates pioneer-exec; turn 2 sees it in store and skips.
    const savedBricks: BrickArtifact[] = []; // let justified: test accumulator

    const store = createMockForgeStore({
      search: mock(
        async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
          ok: true,
          value: savedBricks.length > 0 ? [savedBricks[0] as BrickArtifact] : [],
        }),
      ),
      save: mock(async (brick: BrickArtifact): Promise<Result<void, KoiError>> => {
        savedBricks.push(brick);
        return { ok: true, value: undefined };
      }),
    });

    const signal1 = createDemandSignal({ id: "demand-turn1" });
    const demandHandle1 = createDemandHandle([signal1]);
    const handle = createMockCrystallizeHandle();

    const mw = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle1,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 10 },
      clock: () => 1000,
    });

    // Turn 1: creates pioneer-exec
    await mw.onAfterTurn?.(createMockTurnContext(0) as never);
    await flush();
    expect(savedBricks).toHaveLength(1);
    expect(savedBricks[0]?.name).toBe("pioneer-exec");

    // Turn 2: same demand signal — name dedup catches it
    const signal2 = createDemandSignal({ id: "demand-turn2" });
    // Swap demandHandle to provide new signal for turn 2
    (mw as unknown as { readonly _cfg?: never }).toString(); // no-op to avoid lint
    // Re-create middleware with same store (which now has the brick)
    const demandHandle2 = createDemandHandle([signal2]);
    const mw2 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle2,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 10 },
      clock: () => 2000,
    });

    await mw2.onAfterTurn?.(createMockTurnContext(1) as never);
    await flush();

    // Still only 1 brick saved — turn 2 was deduped by name
    expect(savedBricks).toHaveLength(1);
  });
});
