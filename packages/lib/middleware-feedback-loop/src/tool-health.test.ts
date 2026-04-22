import { describe, expect, it } from "bun:test";
import type { ChainId, NodeId, SnapshotChainStore, SnapshotNode } from "@koi/core";
import { nodeId } from "@koi/core";
import type { BrickId, BrickSnapshot } from "@koi/core/brick-snapshot";
import { brickId } from "@koi/core/brick-snapshot";
import type { BrickArtifact, BrickUpdate, ForgeStore } from "@koi/core/brick-store";
import { computeHealthAction, createToolHealthTracker } from "./tool-health.js";
import type { DemotionCriteria, ToolHealthMetrics } from "./types.js";

// ── Minimal in-memory ForgeStore ──────────────────────────────────────────
function makeForgeStore(): ForgeStore & { data: Map<string, BrickArtifact> } {
  const data = new Map<string, BrickArtifact>();
  return {
    data,
    save: async (b: BrickArtifact) => {
      data.set(b.id, b);
      return { ok: true, value: undefined };
    },
    load: async (id: BrickId) => {
      const b = data.get(id);
      return b
        ? { ok: true, value: b }
        : {
            ok: false,
            error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
          };
    },
    search: async () => ({ ok: true, value: [] }),
    remove: async (id: BrickId) => {
      data.delete(id);
      return { ok: true, value: undefined };
    },
    update: async (id: BrickId, patch: BrickUpdate) => {
      const b = data.get(id);
      if (!b) {
        return {
          ok: false,
          error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
        };
      }
      data.set(id, { ...b, ...patch } as BrickArtifact);
      return { ok: true, value: undefined };
    },
    exists: async (id: BrickId) => ({ ok: true, value: data.has(id) }),
  };
}

// ── Minimal in-memory SnapshotChainStore ─────────────────────────────────
function makeSnapshotStore(): SnapshotChainStore<BrickSnapshot> {
  return {
    put: async (cId: ChainId, data: BrickSnapshot, _parentIds: readonly NodeId[]) => ({
      ok: true,
      value: {
        nodeId: nodeId("n1"),
        chainId: cId,
        parentIds: [],
        contentHash: "hash",
        data,
        createdAt: Date.now(),
        metadata: {},
      } satisfies SnapshotNode<BrickSnapshot>,
    }),
    get: async () => ({
      ok: false,
      error: { code: "NOT_FOUND" as const, message: "", retryable: false },
    }),
    head: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    ancestors: async () => ({ ok: true, value: [] }),
    fork: async (_sourceNodeId: NodeId, _newChainId: ChainId) => ({
      ok: true,
      value: { parentNodeId: nodeId("n1"), label: "fork" },
    }),
    prune: async () => ({ ok: true, value: 0 }),
    close: () => {},
  };
}

// ── Minimal BrickArtifact for seeding the store ───────────────────────────
function makeBrickArtifact(id: BrickId): BrickArtifact {
  return {
    id,
    kind: "tool" as const,
    name: "t1",
    description: "test tool",
    scope: "agent" as const,
    origin: { type: "user-created" as const },
    policy: { sandboxed: false, allowNetwork: false },
    lifecycle: "active" as const,
    provenance: {
      createdAt: 0,
      updatedAt: 0,
      createdBy: "test",
    },
    version: "1",
    tags: [],
    usageCount: 0,
    trustTier: "verified" as const,
    implementation: "() => {}",
    inputSchema: {},
  } as unknown as BrickArtifact;
}

// ── computeHealthAction table tests ──────────────────────────────────────
const criteria: DemotionCriteria = {
  errorRateThreshold: 0.3,
  windowSize: 5,
  minSampleSize: 3,
  gracePeriodMs: 1_000,
  demotionCooldownMs: 1_000,
};

describe("computeHealthAction", () => {
  it("returns healthy/none when error rate below degraded threshold", () => {
    const metrics: ToolHealthMetrics = { errorCount: 0, totalCount: 5, entries: [] };
    const result = computeHealthAction(
      metrics,
      "healthy",
      "verified",
      0.5,
      10,
      criteria,
      0,
      0,
      100_000,
    );
    expect(result.state).toBe("healthy");
    expect(result.action).toBe("none");
  });

  it("returns degraded/none when error rate >= 75% of quarantine threshold", () => {
    // quarantineThreshold=0.5, 75%=0.375. 2/5 = 0.4 >= 0.375 but < 0.5 → degraded
    const metrics: ToolHealthMetrics = { errorCount: 2, totalCount: 5, entries: [] };
    const result = computeHealthAction(
      metrics,
      "healthy",
      "verified",
      0.5,
      5,
      criteria,
      0,
      0,
      100_000,
    );
    expect(result.state).toBe("degraded");
  });

  it("returns quarantined when error rate >= quarantine threshold", () => {
    const metrics: ToolHealthMetrics = { errorCount: 4, totalCount: 5, entries: [] };
    const result = computeHealthAction(
      metrics,
      "degraded",
      "verified",
      0.5,
      5,
      criteria,
      0,
      0,
      100_000,
    );
    expect(result.state).toBe("quarantined");
    expect(result.action).toBe("quarantine");
  });

  it("returns demote action when demotion criteria met", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    // error rate = 0.6 >= threshold 0.3, sample=5 >= min=3, grace=1000 ok, cooldown=1000 ok
    const result = computeHealthAction(
      metrics,
      "healthy",
      "verified",
      0.5,
      10,
      criteria,
      0,
      0,
      5_000,
    );
    expect(result.action).toBe("demote");
  });

  it("does not block demotion when lastPromotedAt is 0 (no promotion observed)", () => {
    // lastPromotedAt=0 means no promotion seen this session. Grace period must be skipped
    // so a chronically bad tool from a prior session is not shielded indefinitely.
    // Use criteria with a short cooldown (100ms) and long grace (5000ms).
    // now=200: cooldown passes (200 >= 100) but normal grace arithmetic would block
    // (200 - 0 = 200 < 5000ms). With lastPromotedAt=0 the grace gate must be skipped.
    const shortCooldownCriteria: DemotionCriteria = {
      ...criteria,
      demotionCooldownMs: 100,
      gracePeriodMs: 5_000,
    };
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    const result = computeHealthAction(
      metrics,
      "healthy",
      "verified",
      0.5,
      10,
      shortCooldownCriteria,
      0, // lastPromotedAt — 0 = unknown, skip grace period
      0,
      200, // now: cooldown ok (200 >= 100), grace would block if lastPromotedAt=200
    );
    expect(result.action).toBe("demote");
  });

  it("blocks demotion during grace period", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    // lastPromotedAt=4500, now=5000 → only 500ms < 1000ms grace
    const result = computeHealthAction(
      metrics,
      "healthy",
      "verified",
      0.5,
      10,
      criteria,
      4_500,
      0,
      5_000,
    );
    expect(result.action).toBe("none");
  });

  it("blocks demotion during cooldown period", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    // lastDemotedAt=4500, now=5000 → 500ms < 1000ms cooldown
    const result = computeHealthAction(
      metrics,
      "healthy",
      "community",
      0.5,
      10,
      criteria,
      0,
      4_500,
      5_000,
    );
    expect(result.action).toBe("none");
  });

  it("does not demote below 'local' (floor tier)", () => {
    const metrics: ToolHealthMetrics = { errorCount: 3, totalCount: 5, entries: [] };
    const result = computeHealthAction(metrics, "healthy", "local", 0.5, 10, criteria, 0, 0, 5_000);
    expect(result.action).toBe("none");
  });
});

// ── ToolHealthTracker integration ─────────────────────────────────────────
describe("createToolHealthTracker", () => {
  const BID = brickId("brick-1");
  const TOOL_ID = "tool-1";

  it("records successes and failures without error", () => {
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: makeForgeStore(),
      snapshotChainStore: makeSnapshotStore(),
      clock: () => 100_000,
    });
    tracker.recordSuccess(TOOL_ID, 10);
    tracker.recordFailure(TOOL_ID, 10, "oops");
    const snap = tracker.getSnapshot(TOOL_ID);
    expect(snap).toBeDefined();
    expect(snap?.totalCount).toBe(2);
  });

  it("isQuarantined returns false for healthy tool", async () => {
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: makeForgeStore(),
      snapshotChainStore: makeSnapshotStore(),
    });
    await expect(tracker.isQuarantined(TOOL_ID)).resolves.toBe(false);
  });

  it("quarantines tool in session when error rate exceeds threshold", async () => {
    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.5,
      windowSize: 4,
      clock: () => 100_000,
    });

    // 3 failures out of 4 = 75% > 50% → quarantine
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const quarantined = await tracker.checkAndQuarantine(TOOL_ID);
    expect(quarantined).toBe(true);
    expect(await tracker.isQuarantined(TOOL_ID)).toBe(true);
  });

  it("quarantines in session even when ForgeStore update fails", async () => {
    const forgeStore = makeForgeStore();
    // Don't seed brick → update() returns NOT_FOUND

    const errors: unknown[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.5,
      windowSize: 4,
      clock: () => 100_000,
      onHealthTransitionError: (e) => errors.push(e),
    });

    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const quarantined = await tracker.checkAndQuarantine(TOOL_ID);
    expect(quarantined).toBe(true);
    expect(await tracker.isQuarantined(TOOL_ID)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("demotes trust tier when criteria met and persists to forgeStore", async () => {
    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const demotions: string[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 0,
        demotionCooldownMs: 0,
      },
      onDemotion: (e) => demotions.push(e.to),
      clock: () => 100_000,
    });

    for (let i = 0; i < 4; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const demoted = await tracker.checkAndDemote(TOOL_ID);
    expect(demoted).toBe(true);
    expect(demotions[0]).toBe("community");
    // Trust tier must be persisted to forgeStore (not just callback)
    expect(forgeStore.data.get(BID)?.trustTier).toBe("community");
  });

  it("demotes when lastPromotedAt is 0 (fresh session) even with non-zero gracePeriodMs", async () => {
    // Regression: checkAndDemote_() had an unconditional grace check that blocked demotion
    // in fresh sessions because now - 0 < gracePeriodMs when now is small. The fix mirrors
    // computeHealthAction: lastPromotedAt === 0 skips the grace gate entirely.
    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const demotions: string[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 60_000, // 60s grace — would block if lastPromotedAt=0 were a real ts
        demotionCooldownMs: 0,
      },
      onDemotion: (e) => demotions.push(e.to),
      clock: () => 100, // now=100 < gracePeriodMs=60_000, but lastPromotedAt=0 → skip gate
    });

    for (let i = 0; i < 4; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    const demoted = await tracker.checkAndDemote(TOOL_ID);
    expect(demoted).toBe(true);
    expect(demotions[0]).toBe("community");
  });

  it("demotes trust tier even when tool is already session-quarantined", async () => {
    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const demotions: string[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.5,
      windowSize: 4,
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 0,
        demotionCooldownMs: 0,
      },
      onDemotion: (e) => demotions.push(e.to),
      clock: () => 100_000,
    });

    // 4 failures triggers both quarantine (75% > 50%) and demotion (80% > 30%) criteria
    for (let i = 0; i < 4; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);

    // Quarantine fires first
    await tracker.checkAndQuarantine(TOOL_ID);
    expect(await tracker.isQuarantined(TOOL_ID)).toBe(true);

    // Demotion must still fire even though the tool is quarantined
    const demoted = await tracker.checkAndDemote(TOOL_ID);
    expect(demoted).toBe(true);
    expect(demotions[0]).toBe("community");
    expect(forgeStore.data.get(BID)?.trustTier).toBe("community");
  });

  it("isQuarantined detects persisted quarantine from a previous session", async () => {
    const forgeStore = makeForgeStore();
    // Simulate a brick quarantined in a previous session (lifecycle = quarantined in store)
    const quarantinedBrick = { ...makeBrickArtifact(BID), lifecycle: "quarantined" as const };
    await forgeStore.save(quarantinedBrick);

    // Fresh tracker — no in-session state for this brick
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
    });

    expect(await tracker.isQuarantined(TOOL_ID)).toBe(true);
  });

  it("health state aggregated by BrickId: failures across aliases share one ring buffer", async () => {
    // Two different toolIds that resolve to the same brick must share health state.
    // Without this, a flaky brick can evade quarantine by distributing calls across aliases.
    const TOOL_A = "tool-a";
    const TOOL_B = "tool-b"; // alias for same brick
    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const tracker = createToolHealthTracker({
      resolveBrickId: (toolId: string) =>
        toolId === TOOL_A || toolId === TOOL_B ? BID : undefined,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.5,
      windowSize: 4,
    });

    // Record 2 failures via alias A and 1 failure via alias B = 3 failures total
    tracker.recordFailure(TOOL_A, 10, "err");
    tracker.recordFailure(TOOL_A, 10, "err");
    tracker.recordFailure(TOOL_B, 10, "err");
    tracker.recordSuccess(TOOL_B, 10); // 3/4 = 75% >= threshold 50%

    // Quarantine must trigger because the shared ring buffer sees 75% errors
    const quarantined = await tracker.checkAndQuarantine(TOOL_A);
    expect(quarantined).toBe(true);

    // Both aliases must be blocked
    expect(await tracker.isQuarantined(TOOL_A)).toBe(true);
    expect(await tracker.isQuarantined(TOOL_B)).toBe(true);
  });

  it("isQuarantined re-checks forgeStore on every call so operator quarantine is immediate", async () => {
    let loadCount = 0;
    const base = makeForgeStore();
    const forgeStore = {
      ...base,
      load: async (id: BrickId) => {
        loadCount++;
        return base.load(id);
      },
    } as typeof base;

    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore: makeSnapshotStore(),
    });

    // Brick not quarantined — re-checked on every call (no caching)
    await tracker.isQuarantined(TOOL_ID);
    await tracker.isQuarantined(TOOL_ID);
    await tracker.isQuarantined(TOOL_ID);
    expect(loadCount).toBe(3);
  });

  it("isQuarantined reflects operator unquarantine immediately (no positive cache)", async () => {
    const base = makeForgeStore();
    const quarantinedBrick = { ...makeBrickArtifact(BID), lifecycle: "quarantined" as const };
    await base.save(quarantinedBrick);

    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: base,
      snapshotChainStore: makeSnapshotStore(),
    });

    // First call: quarantined
    expect(await tracker.isQuarantined(TOOL_ID)).toBe(true);

    // Operator clears quarantine in the store
    await base.save({ ...makeBrickArtifact(BID), lifecycle: "active" as const });

    // Next call must reflect the updated store state — no TTL delay
    expect(await tracker.isQuarantined(TOOL_ID)).toBe(false);
  });

  it("skips quarantine snapshot and reports error when head() fails", async () => {
    const errors: string[] = [];
    const headError = { code: "INTERNAL" as const, message: "chain unavailable", retryable: false };
    const base = makeSnapshotStore();
    const snapshotChainStore = {
      ...base,
      head: async () => ({ ok: false as const, error: headError }),
    } as typeof base;

    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore,
      quarantineThreshold: 0.1,
      windowSize: 5,
      onHealthTransitionError: (e) => errors.push(`${e.transition}:${e.phase}`),
      clock: () => 100_000,
    });

    for (let i = 0; i < 5; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    await tracker.checkAndQuarantine(TOOL_ID);

    // Quarantine in forgeStore must have succeeded (lifecycle changed)
    expect(forgeStore.data.get(BID)?.lifecycle).toBe("quarantined");
    // head() failure must have been reported
    expect(errors).toContain("quarantine:snapshot");
  });

  it("skips demotion snapshot and reports error when head() fails", async () => {
    const errors: string[] = [];
    const headError = { code: "INTERNAL" as const, message: "chain unavailable", retryable: false };
    const base = makeSnapshotStore();
    const snapshotChainStore = {
      ...base,
      head: async () => ({ ok: false as const, error: headError }),
    } as typeof base;

    const forgeStore = makeForgeStore();
    await forgeStore.save(makeBrickArtifact(BID));

    const demotions: string[] = [];
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore,
      snapshotChainStore,
      demotionCriteria: {
        errorRateThreshold: 0.3,
        windowSize: 5,
        minSampleSize: 3,
        gracePeriodMs: 0,
        demotionCooldownMs: 0,
      },
      onDemotion: (e) => demotions.push(e.toTier),
      onHealthTransitionError: (e) => errors.push(`${e.transition}:${e.phase}`),
      clock: () => 100_000,
    });

    for (let i = 0; i < 4; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    tracker.recordSuccess(TOOL_ID, 10);
    const demoted = await tracker.checkAndDemote(TOOL_ID);

    // Demotion in forgeStore must have succeeded
    expect(demoted).toBe(true);
    expect(demotions.length).toBeGreaterThan(0);
    // head() failure must have been reported
    expect(errors).toContain("demotion:snapshot");
  });

  it("dispose completes within timeout even when store is unresponsive", async () => {
    // Simulates a hung forgeStore: update() never resolves
    const base = makeForgeStore();
    await base.save(makeBrickArtifact(BID));
    const hungStore = {
      ...base,
      update: (_id: BrickId, _patch: unknown) => new Promise<never>(() => {}),
    } as typeof base;

    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: hungStore,
      snapshotChainStore: makeSnapshotStore(),
      quarantineThreshold: 0.1,
      windowSize: 5,
      flushTimeoutMs: 50, // very short timeout so test completes fast
      clock: () => 100_000,
    });

    for (let i = 0; i < 5; i++) tracker.recordFailure(TOOL_ID, 10, "err");
    // Fire-and-forget quarantine write (will hang in hungStore.update)
    void tracker.checkAndQuarantine(TOOL_ID);

    // dispose() must not hang — it races the pending write against flushTimeoutMs
    const start = Date.now();
    await tracker.dispose();
    expect(Date.now() - start).toBeLessThan(500); // well within CI budget
  });

  it("dispose flushes dirty tools without throwing", async () => {
    const tracker = createToolHealthTracker({
      resolveBrickId: () => BID,
      forgeStore: makeForgeStore(),
      snapshotChainStore: makeSnapshotStore(),
      flushThreshold: 100,
    });
    tracker.recordSuccess(TOOL_ID, 10);
    await expect(tracker.dispose()).resolves.toBeUndefined();
  });
});
