import { describe, expect, it } from "bun:test";
import type {
  ContentReplacement,
  HarnessSnapshot,
  HarnessSnapshotStore,
  KoiError,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionPersistence,
  SessionRecord,
  SessionStatus,
  SnapshotNode,
} from "@koi/core";
import { agentId, harnessId, nodeId } from "@koi/core";
import { shouldSoftCheckpoint } from "../checkpoint-policy.js";
import { createLongRunningHarness } from "../harness.js";

const ok = <T>(value: T): Result<T, KoiError> => ({ ok: true, value });

function makeStore(): HarnessSnapshotStore {
  const nodes: SnapshotNode<HarnessSnapshot>[] = [];
  let counter = 0;
  return {
    put: (chain, data, parentIds, metadata) => {
      counter += 1;
      const node: SnapshotNode<HarnessSnapshot> = {
        nodeId: nodeId(`n-${counter}`),
        chainId: chain,
        parentIds,
        contentHash: String(counter),
        data,
        createdAt: Date.now(),
        metadata: metadata ?? {},
      };
      nodes.push(node);
      return ok<SnapshotNode<HarnessSnapshot> | undefined>(node);
    },
    get: (id) => {
      const found = nodes.find((n) => n.nodeId === id);
      return found
        ? ok(found)
        : { ok: false, error: { code: "NOT_FOUND", message: "node missing", retryable: false } };
    },
    head: (_chain) =>
      ok<SnapshotNode<HarnessSnapshot> | undefined>(
        nodes.length > 0 ? nodes[nodes.length - 1] : undefined,
      ),
    list: (_chain) => ok([...nodes].reverse() as readonly SnapshotNode<HarnessSnapshot>[]),
    ancestors: () => ok([] as readonly SnapshotNode<HarnessSnapshot>[]),
    fork: (sourceNodeId, _newChainId, label) => ok({ parentNodeId: sourceNodeId, label }),
    prune: () => ok(0),
    close: () => undefined,
  };
}

function makePersistence(): SessionPersistence {
  const sessions = new Map<string, SessionRecord>();
  return {
    saveSession: (record) => {
      sessions.set(record.sessionId, record);
      return ok<void>(undefined);
    },
    loadSession: (id) => {
      const rec = sessions.get(id);
      return rec
        ? ok(rec)
        : {
            ok: false,
            error: { code: "NOT_FOUND", message: "session missing", retryable: false },
          };
    },
    removeSession: (id) => {
      sessions.delete(id);
      return ok<void>(undefined);
    },
    listSessions: () => ok([...sessions.values()] as readonly SessionRecord[]),
    savePendingFrame: () => ok<void>(undefined),
    loadPendingFrames: () => ok([] as readonly PendingFrame[]),
    clearPendingFrames: () => ok<void>(undefined),
    removePendingFrame: () => ok<void>(undefined),
    setSessionStatus: (id, status: SessionStatus) => {
      const rec = sessions.get(id);
      if (rec) sessions.set(id, { ...rec, status });
      return ok<void>(undefined);
    },
    saveContentReplacement: () => ok<void>(undefined),
    loadContentReplacements: () => ok([] as readonly ContentReplacement[]),
    recover: () =>
      ok({
        sessions: [...sessions.values()],
        pendingFrames: new Map(),
        skipped: [],
      } as RecoveryPlan),
    close: () => undefined,
  };
}

const baseConfig = () => ({
  harnessId: harnessId("h-1"),
  agentId: agentId("a-1"),
  harnessStore: makeStore(),
  sessionPersistence: makePersistence(),
});

describe("shouldSoftCheckpoint", () => {
  it("returns false for turn 0 or non-multiples", () => {
    expect(shouldSoftCheckpoint(0, 5)).toBe(false);
    expect(shouldSoftCheckpoint(1, 5)).toBe(false);
    expect(shouldSoftCheckpoint(4, 5)).toBe(false);
  });
  it("returns true on every interval boundary", () => {
    expect(shouldSoftCheckpoint(5, 5)).toBe(true);
    expect(shouldSoftCheckpoint(10, 5)).toBe(true);
  });
  it("returns false for non-positive interval", () => {
    expect(shouldSoftCheckpoint(5, 0)).toBe(false);
    expect(shouldSoftCheckpoint(5, -1)).toBe(false);
  });
});

describe("createLongRunningHarness", () => {
  it("rejects invalid config", () => {
    const r = createLongRunningHarness({
      harnessId: harnessId(""),
      agentId: agentId("a"),
      harnessStore: makeStore(),
      sessionPersistence: makePersistence(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  it("start() activates and returns a lease + sessionId", async () => {
    const r = createLongRunningHarness(baseConfig());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const started = await r.value.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.lease.sessionId).toBe(started.value.sessionId);
    expect(r.value.status().phase).toBe("active");
  });

  it("start() twice returns CONFLICT", async () => {
    const r = createLongRunningHarness(baseConfig());
    if (!r.ok) throw new Error("create failed");
    const first = await r.value.start();
    expect(first.ok).toBe(true);
    const second = await r.value.start();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CONFLICT");
  });

  it("pause() with valid lease publishes suspended", async () => {
    const r = createLongRunningHarness(baseConfig());
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    const sessionResult = {
      summary: {
        narrative: "",
        sessionSeq: 1,
        completedTaskIds: [],
        estimatedTokens: 0,
        generatedAt: Date.now(),
      },
      newKeyArtifacts: [],
      metricsDelta: {},
    };
    const paused = await r.value.pause(started.value.lease, sessionResult);
    expect(paused.ok).toBe(true);
    expect(r.value.status().phase).toBe("suspended");
  });

  it("pause() with revoked lease returns STALE_REF", async () => {
    const r = createLongRunningHarness(baseConfig());
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    const sessionResult = {
      summary: {
        narrative: "",
        sessionSeq: 1,
        completedTaskIds: [],
        estimatedTokens: 0,
        generatedAt: Date.now(),
      },
      newKeyArtifacts: [],
      metricsDelta: {},
    };
    const first = await r.value.pause(started.value.lease, sessionResult);
    expect(first.ok).toBe(true);
    const stale = await r.value.pause(started.value.lease, sessionResult);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_REF");
  });

  it("resume() after pause re-activates", async () => {
    const cfg = baseConfig();
    const r = createLongRunningHarness(cfg);
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    await r.value.pause(started.value.lease, {
      summary: {
        narrative: "",
        sessionSeq: 1,
        completedTaskIds: [],
        estimatedTokens: 0,
        generatedAt: Date.now(),
      },
      newKeyArtifacts: [],
      metricsDelta: {},
    });
    const resumed = await r.value.resume();
    expect(resumed.ok).toBe(true);
    expect(r.value.status().phase).toBe("active");
  });

  it("dispose() is idempotent", async () => {
    const r = createLongRunningHarness(baseConfig());
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    const first = await r.value.dispose(started.value.lease);
    expect(first.ok).toBe(true);
    const second = await r.value.dispose();
    expect(second.ok).toBe(true);
  });

  it("retryable failTask keeps phase active", async () => {
    const r = createLongRunningHarness(baseConfig());
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    const res = await r.value.failTask(started.value.lease, "t1", {
      code: "TIMEOUT",
      message: "transient",
      retryable: true,
    });
    expect(res.ok).toBe(true);
    expect(r.value.status().phase).toBe("active");
  });

  it("non-retryable failTask publishes failed", async () => {
    const r = createLongRunningHarness(baseConfig());
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    const res = await r.value.failTask(started.value.lease, "t1", {
      code: "VALIDATION",
      message: "bad input",
      retryable: false,
    });
    expect(res.ok).toBe(true);
    expect(r.value.status().phase).toBe("failed");
  });

  it("createMiddleware advances soft checkpoint cadence", async () => {
    const cfg = { ...baseConfig(), softCheckpointInterval: 2 };
    const r = createLongRunningHarness(cfg);
    if (!r.ok) throw new Error("create failed");
    const started = await r.value.start();
    if (!started.ok) throw new Error("start failed");
    const mw = r.value.createMiddleware();
    const fakeCtx = {} as Parameters<NonNullable<typeof mw.onAfterTurn>>[0];
    await mw.onBeforeTurn?.(fakeCtx);
    await mw.onAfterTurn?.(fakeCtx);
    await mw.onBeforeTurn?.(fakeCtx);
    await mw.onAfterTurn?.(fakeCtx);
    expect(r.value.status().metrics.totalTurns).toBe(2);
  });
});
