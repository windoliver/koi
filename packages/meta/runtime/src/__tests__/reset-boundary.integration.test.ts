/**
 * Integration tests for #1939 reset boundary semantics.
 * Verifies run_reset / session_reset events carry correct provenance,
 * that guard state does not leak across runs, and that legacy guards
 * (branded but missing resetForRun) are rejected at construction.
 */
import { describe, expect, test } from "bun:test";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  GovernanceEvent,
  KoiMiddleware,
} from "@koi/core";
import { GOVERNANCE } from "@koi/core";
import { createKoi } from "@koi/engine";
import {
  createIterationGuard,
  ITERATION_GUARD_BRAND,
  isIterationGuardHandle,
} from "@koi/engine-compose";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function doneEvent(): EngineEvent {
  return {
    kind: "done",
    output: {
      content: [],
      stopReason: "completed",
      metrics: { totalTokens: 2, inputTokens: 1, outputTokens: 1, turns: 1, durationMs: 0 },
    },
  };
}

function mockNonCoopAdapter(): EngineAdapter {
  return {
    engineId: "non-coop-test",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
      yield doneEvent();
    },
  };
}

function buildManifest(): {
  readonly kind: "agent";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model: { readonly provider: string; readonly id: string };
} {
  return {
    kind: "agent" as const,
    id: "test-agent",
    name: "Test",
    description: "Integration test agent",
    model: { provider: "test", id: "test-model" },
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

/**
 * Spy on the governance controller attached to a runtime agent.
 * Returns the collected events and the original record function.
 */
type GovRecordable = { record: (event: GovernanceEvent) => void | Promise<void> };

function spyOnGovernance(runtime: Awaited<ReturnType<typeof createKoi>>): {
  readonly recorded: GovernanceEvent[];
} {
  const govCtl = runtime.agent.component<GovRecordable>(GOVERNANCE);
  if (govCtl === undefined) throw new Error("governance component not found");

  const recorded: GovernanceEvent[] = [];
  const original = govCtl.record.bind(govCtl);
  govCtl.record = (event: GovernanceEvent): void | Promise<void> => {
    recorded.push(event);
    return original(event);
  };

  return { recorded };
}

// ---------------------------------------------------------------------------
// Case 1: Non-cooperating adapter
// ---------------------------------------------------------------------------
describe("reset-boundary — non-cooperating adapter", () => {
  test("run_reset fires between runs with source:engine and deterministic boundaryId", async () => {
    const guard = createIterationGuard({ maxTurns: 100, maxDurationMs: 10_000 });

    const runtime = await createKoi({
      manifest: buildManifest(),
      adapter: mockNonCoopAdapter(),
      middleware: [guard],
      resetBudgetPerRun: true,
      loopDetection: false,
    });

    const { recorded } = spyOnGovernance(runtime);

    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    await collectEvents(runtime.run({ kind: "text", text: "second" }));

    const resets = recorded.filter((e) => e.kind === "run_reset");
    expect(resets.length).toBe(2);
    const r0 = resets[0];
    const r1 = resets[1];
    if (r0 === undefined || r0.kind !== "run_reset") throw new Error("expected run_reset[0]");
    if (r1 === undefined || r1.kind !== "run_reset") throw new Error("expected run_reset[1]");
    expect(r0.source).toBe("engine");
    expect(r0.boundaryId).toMatch(/:run:\d+$/);
    expect(r0.boundaryId).not.toBe(r1.boundaryId);
  });

  test("guard state does not leak across runs (stale-duration regression for #1917)", async () => {
    const guard = createIterationGuard({ maxTurns: 100, maxDurationMs: 80 });

    const runtime = await createKoi({
      manifest: buildManifest(),
      adapter: mockNonCoopAdapter(),
      middleware: [guard],
      resetBudgetPerRun: true,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Sleep past the 80ms budget — stale guard would trip immediately on run 2
    await new Promise((r) => setTimeout(r, 100));

    const events = await collectEvents(runtime.run({ kind: "text", text: "second" }));
    const done = events.find((e) => e.kind === "done");
    expect(done).toBeDefined();
    expect(events.find((e) => e.kind === "error")).toBeUndefined();
  });

  test("session_reset fires on cycleSession with source:host and deterministic boundaryId", async () => {
    const runtime = await createKoi({
      manifest: buildManifest(),
      adapter: mockNonCoopAdapter(),
      loopDetection: false,
    });

    const { recorded } = spyOnGovernance(runtime);

    await runtime.cycleSession?.();
    await runtime.cycleSession?.();

    const sessionResets = recorded.filter((e) => e.kind === "session_reset");
    expect(sessionResets.length).toBe(2);
    const sr0 = sessionResets[0];
    const sr1 = sessionResets[1];
    if (sr0 === undefined || sr0.kind !== "session_reset")
      throw new Error("expected session_reset[0]");
    if (sr1 === undefined || sr1.kind !== "session_reset")
      throw new Error("expected session_reset[1]");
    expect(sr0.source).toBe("host");
    expect(sr0.boundaryId).toMatch(/:session:0$/);
    expect(sr1.boundaryId).toMatch(/:session:1$/);
    expect(sr0.boundaryId).not.toBe(sr1.boundaryId);
  });
});

// ---------------------------------------------------------------------------
// Case 2: Stale-duration does not trip on second run after sleep
// ---------------------------------------------------------------------------
describe("reset-boundary — guard reset prevents stale-state trip", () => {
  test("run_reset clears duration timer so second run starts fresh", async () => {
    const guard = createIterationGuard({ maxTurns: 100, maxDurationMs: 80 });

    const runtime = await createKoi({
      manifest: buildManifest(),
      adapter: mockNonCoopAdapter(),
      middleware: [guard],
      resetBudgetPerRun: true,
      loopDetection: false,
    });

    const { recorded } = spyOnGovernance(runtime);

    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Sleep past the 80ms guard budget — without reset, run 2 would error immediately
    await new Promise((r) => setTimeout(r, 100));

    const events = await collectEvents(runtime.run({ kind: "text", text: "second" }));
    expect(events.find((e) => e.kind === "error")).toBeUndefined();
    expect(events.find((e) => e.kind === "done")).toBeDefined();

    // run_reset should have fired for both runs
    const resets = recorded.filter((e) => e.kind === "run_reset");
    expect(resets.length).toBe(2);
    const r0 = resets[0];
    if (r0 === undefined || r0.kind !== "run_reset") throw new Error("expected run_reset[0]");
    expect(r0.source).toBe("engine");
  });
});

// ---------------------------------------------------------------------------
// Case 3: Legacy guard — fail-closed at construction
// ---------------------------------------------------------------------------
describe("reset-boundary — legacy guard fail-closed", () => {
  test("createKoi throws at construction if branded guard lacks resetForRun", async () => {
    const brokenGuard = Object.defineProperty(
      {
        name: "koi:iteration-guard-legacy",
        describeCapabilities: () => undefined,
      } as KoiMiddleware,
      ITERATION_GUARD_BRAND,
      { value: true, enumerable: false, configurable: false, writable: false },
    ) as KoiMiddleware;

    // Confirm the guard is branded but not a valid handle
    expect(isIterationGuardHandle(brokenGuard)).toBe(false);

    await expect(
      createKoi({
        manifest: buildManifest(),
        adapter: mockNonCoopAdapter(),
        middleware: [brokenGuard],
        resetBudgetPerRun: true,
        loopDetection: false,
      }),
    ).rejects.toThrow("ITERATION_GUARD_BRAND");
  });

  test("error message identifies the guard by name", async () => {
    const brokenGuard = Object.defineProperty(
      { name: "my-custom-guard", describeCapabilities: () => undefined } as KoiMiddleware,
      ITERATION_GUARD_BRAND,
      { value: true, enumerable: false, configurable: false, writable: false },
    ) as KoiMiddleware;

    await expect(
      createKoi({
        manifest: buildManifest(),
        adapter: mockNonCoopAdapter(),
        middleware: [brokenGuard],
        resetBudgetPerRun: true,
        loopDetection: false,
      }),
    ).rejects.toThrow("my-custom-guard");
  });
});
