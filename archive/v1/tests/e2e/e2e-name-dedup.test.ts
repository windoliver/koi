/**
 * Regression test for duplicate brick forging bug (Issue #1081).
 *
 * The agent created 7 duplicate pioneer-exec skills and 4 duplicate
 * pioneer-forge_tool skills because each failed attempt produced slightly
 * different content (timestamps, error messages), so SHA-256 content dedup
 * didn't catch them. The trigger-based dedup returned undefined for
 * repeated_failure triggers, skipping the check entirely.
 *
 * Fix: name-based dedup — search for active bricks with the same name
 * before forging.
 *
 * Uses NexusForgeStore with createFakeNexusFetch — exercises the real
 * Nexus JSON-RPC parsing path (same path that had 3 bugs in PR #1072).
 *
 * Run:
 *   bun test tests/e2e/e2e-name-dedup.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, ForgeDemandSignal, ForgeStore } from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import type { AutoForgeDemandHandle } from "@koi/crystallize/auto-forge";
import { type CrystallizeHandle, createAutoForgeMiddleware } from "@koi/forge";
import { createNexusForgeStore } from "@koi/nexus-store/forge";
import { createFakeNexusFetch } from "@koi/test-utils-mocks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStore(): ForgeStore {
  return createNexusForgeStore({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  });
}

function createMockCrystallizeHandle(): CrystallizeHandle {
  return {
    middleware: { name: "crystallize", describeCapabilities: () => undefined },
    getCandidates: () => [],
    dismiss: mock(() => {}),
  };
}

function createRepeatedFailureSignal(id: string, toolName: string): ForgeDemandSignal {
  return {
    id,
    kind: "forge_demand",
    trigger: { kind: "repeated_failure", toolName, count: 3 },
    confidence: 0.95,
    suggestedBrickKind: "tool",
    context: { failureCount: 3, failedToolCalls: [toolName, toolName, toolName] },
    emittedAt: Date.now(),
  };
}

function createDemandHandle(signals: readonly ForgeDemandSignal[]): AutoForgeDemandHandle {
  return {
    getSignals: () => signals,
    dismiss: mock(() => {}),
  };
}

function createMockTurnContext(turnIndex = 0): { readonly turnIndex: number } {
  return { turnIndex } as { readonly turnIndex: number };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// E2E: name-based dedup prevents duplicate pioneer bricks
// ---------------------------------------------------------------------------

describe("e2e: name-based dedup prevents duplicate bricks (#1081)", () => {
  test("repeated_failure signals across turns create only one pioneer brick", async () => {
    const store = createStore();
    const handle = createMockCrystallizeHandle();

    // Turn 1: first repeated_failure signal for "exec" → creates pioneer-exec
    const signal1 = createRepeatedFailureSignal("demand-turn1", "exec");
    const demandHandle1 = createDemandHandle([signal1]);
    const onDemandForged1 = mock((_signal: ForgeDemandSignal, _brick: BrickArtifact) => {});

    const mw1 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle1,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 10 },
      clock: () => 1000,
      onDemandForged: onDemandForged1,
    });

    await mw1.onSessionStart?.({} as never);
    await mw1.onAfterTurn?.(createMockTurnContext(0) as never);
    await flush();

    expect(onDemandForged1).toHaveBeenCalledTimes(1);

    // Verify one brick in store
    const after1 = await store.search({ lifecycle: "active", kind: "tool" });
    expect(after1.ok).toBe(true);
    if (!after1.ok) return;
    const pioneers1 = after1.value.filter((b) => b.name === "pioneer-exec");
    expect(pioneers1).toHaveLength(1);

    // Turn 2: same demand signal fires again — name dedup should catch it
    const signal2 = createRepeatedFailureSignal("demand-turn2", "exec");
    const demandHandle2 = createDemandHandle([signal2]);
    const onDemandForged2 = mock((_signal: ForgeDemandSignal, _brick: BrickArtifact) => {});

    const mw2 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle2,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 10 },
      clock: () => 2000,
      onDemandForged: onDemandForged2,
    });

    await mw2.onSessionStart?.({} as never);
    await mw2.onAfterTurn?.(createMockTurnContext(1) as never);
    await flush();

    // Name dedup prevented the duplicate — onDemandForged NOT called
    expect(onDemandForged2).not.toHaveBeenCalled();

    // Still only one pioneer-exec in store
    const after2 = await store.search({ lifecycle: "active", kind: "tool" });
    expect(after2.ok).toBe(true);
    if (!after2.ok) return;
    const pioneers2 = after2.value.filter((b) => b.name === "pioneer-exec");
    expect(pioneers2).toHaveLength(1);
  });

  test("different tool names create separate pioneer bricks", async () => {
    const store = createStore();
    const handle = createMockCrystallizeHandle();

    // Signal for "exec" tool
    const signal1 = createRepeatedFailureSignal("demand-exec", "exec");
    const demandHandle1 = createDemandHandle([signal1]);

    const mw1 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle1,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 1000,
    });

    await mw1.onSessionStart?.({} as never);
    await mw1.onAfterTurn?.(createMockTurnContext(0) as never);
    await flush();

    // Signal for "forge_tool" tool — different name, should create new brick
    const signal2 = createRepeatedFailureSignal("demand-forge", "forge_tool");
    const demandHandle2 = createDemandHandle([signal2]);

    const mw2 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle2,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 2000,
    });

    await mw2.onSessionStart?.({} as never);
    await mw2.onAfterTurn?.(createMockTurnContext(1) as never);
    await flush();

    const result = await store.search({ lifecycle: "active", kind: "tool" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.map((b) => b.name).sort();
    expect(names).toContain("pioneer-exec");
    expect(names).toContain("pioneer-forge_tool");
  });

  test("deprecated brick with same name does NOT block new forge", async () => {
    const store = createStore();
    const handle = createMockCrystallizeHandle();

    // First: create and then deprecate a pioneer-exec brick
    const signal1 = createRepeatedFailureSignal("demand-1", "exec");
    const demandHandle1 = createDemandHandle([signal1]);

    const mw1 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle1,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 1000,
    });

    await mw1.onSessionStart?.({} as never);
    await mw1.onAfterTurn?.(createMockTurnContext(0) as never);
    await flush();

    // Find the brick and deprecate it
    const searchResult = await store.search({ lifecycle: "active", kind: "tool" });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    const brick = searchResult.value.find((b) => b.name === "pioneer-exec");
    expect(brick).toBeDefined();
    if (brick === undefined) return;
    await store.update(brick.id, { lifecycle: "deprecated" });

    // Now: same demand signal fires — deprecated brick should NOT block
    const signal2 = createRepeatedFailureSignal("demand-2", "exec");
    const demandHandle2 = createDemandHandle([signal2]);
    const onDemandForged2 = mock((_signal: ForgeDemandSignal, _brick: BrickArtifact) => {});

    const mw2 = createAutoForgeMiddleware({
      crystallizeHandle: handle,
      forgeStore: store,
      scope: "agent",
      demandHandle: demandHandle2,
      demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5 },
      clock: () => 2000,
      onDemandForged: onDemandForged2,
    });

    await mw2.onSessionStart?.({} as never);
    await mw2.onAfterTurn?.(createMockTurnContext(1) as never);
    await flush();

    // Forge should proceed since the existing brick is deprecated
    expect(onDemandForged2).toHaveBeenCalledTimes(1);

    // Two bricks in store: one deprecated, one active
    const allBricks = await store.search({ kind: "tool" });
    expect(allBricks.ok).toBe(true);
    if (!allBricks.ok) return;
    const pioneers = allBricks.value.filter((b) => b.name === "pioneer-exec");
    expect(pioneers).toHaveLength(2);
  });

  test("simulated bug scenario: 7 repeated signals produce only 1 brick", async () => {
    // Reproduces the exact bug: across 7 turns, same repeated_failure signal
    // for "exec" fires. Before the fix, each produced a new brick.
    const store = createStore();
    const handle = createMockCrystallizeHandle();
    const forgeCount = { value: 0 }; // let justified: test accumulator

    for (let turn = 0; turn < 7; turn++) {
      const signal = createRepeatedFailureSignal(`demand-turn-${String(turn)}`, "exec");
      const demandHandle = createDemandHandle([signal]);

      const mw = createAutoForgeMiddleware({
        crystallizeHandle: handle,
        forgeStore: store,
        scope: "agent",
        demandHandle,
        demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.5, maxForgesPerSession: 10 },
        clock: () => 1000 + turn * 1000,
        onDemandForged: () => {
          forgeCount.value++;
        },
      });

      await mw.onSessionStart?.({} as never);
      await mw.onAfterTurn?.(createMockTurnContext(turn) as never);
      await flush();
    }

    // Only 1 forge should have succeeded
    expect(forgeCount.value).toBe(1);

    // Only 1 brick in store
    const result = await store.search({ lifecycle: "active", kind: "tool" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pioneers = result.value.filter((b) => b.name === "pioneer-exec");
    expect(pioneers).toHaveLength(1);
  });
});
