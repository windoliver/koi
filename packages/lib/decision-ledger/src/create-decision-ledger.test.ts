import { beforeEach, describe, expect, test } from "bun:test";
import type { AuditEntry } from "@koi/core";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { RunReport } from "@koi/core/run-report";
import { createDecisionLedger } from "./create-decision-ledger.js";
import {
  createFakeAuditSink,
  createFakeReportStore,
  createFakeTrajectoryReader,
  createThrowingTrajectoryReader,
  makeAuditEntry,
  makeRunReport,
  makeTrajectoryStep,
  resetFakeCounters,
} from "./test-fakes.js";

beforeEach(() => {
  resetFakeCounters();
});

describe("createDecisionLedger — factory contract", () => {
  test("returns a reader with getLedger", () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
    });
    expect(typeof ledger.getLedger).toBe("function");
  });
});

describe("getLedger — catastrophic failures", () => {
  test("empty sessionId returns VALIDATION error", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
    });
    const result = await ledger.getLedger("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

describe("getLedger — trajectory trust model", () => {
  test("every ledger result declares trajectoryTrustModel as store-authoritative", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
    });
    const result = await ledger.getLedger("any-session");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // Documents that trajectory cross-session integrity is NOT field-verified;
    // callers cannot mistake the absence of trajectory from integrityLeakCounts
    // for a "verified clean" signal.
    expect(result.value.trajectoryTrustModel).toBe("store-authoritative");
    // And integrityLeakCounts structurally excludes trajectory.
    expect("trajectory" in result.value.integrityLeakCounts).toBe(false);
  });

  test("allLanesFieldVerified is always false — flat callers cannot shortcut to trusted", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map() }),
      reportStore: createFakeReportStore(new Map()),
    });
    const result = await ledger.getLedger("any-session");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // Even on a clean fetch with zero leaks everywhere, this field is false
    // because trajectory trust is store-authoritative. A caller that writes
    // `if (ledger.allLanesFieldVerified) trust()` takes the else branch
    // unconditionally — the honest outcome.
    expect(result.value.allLanesFieldVerified).toBe(false);
    expect(result.value.integrityLeakCounts).toEqual({ audit: 0, report: 0 });
  });
});

describe("getLedger — trajectory ordering", () => {
  test("shuffled trajectory records are deterministically sorted by stepIndex", async () => {
    // The TrajectoryDocumentStore contract does not guarantee sorted output
    // — compaction, replay, and backend enumeration can shuffle records.
    // The ledger must sort so callers get deterministic decision history.
    const shuffled: readonly RichTrajectoryStep[] = [
      makeTrajectoryStep({ stepIndex: 5, identifier: "e" }),
      makeTrajectoryStep({ stepIndex: 1, identifier: "a" }),
      makeTrajectoryStep({ stepIndex: 4, identifier: "d" }),
      makeTrajectoryStep({ stepIndex: 2, identifier: "b" }),
      makeTrajectoryStep({ stepIndex: 3, identifier: "c" }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["s-1", shuffled]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.trajectorySteps.map((s) => s.stepIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(result.value.trajectorySteps.map((s) => s.identifier)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

describe("getLedger — audit lane determinism", () => {
  test("audit entries with identical (timestamp, turnIndex) fall back to sink-response order as deterministic tiebreaker", async () => {
    // Bursty writes within a single turn can produce multiple audit
    // records with the same timestamp AND turnIndex. The ledger must
    // emit them in the same order given the same sink response, not
    // leave them at the mercy of sort-implementation details.
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 500, turnIndex: 1, kind: "tool_call", sessionId: "s-1" }),
      makeAuditEntry({ timestamp: 500, turnIndex: 1, kind: "model_call", sessionId: "s-1" }),
      makeAuditEntry({ timestamp: 500, turnIndex: 1, kind: "tool_call", sessionId: "s-1" }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // Emitted order must exactly match the sink's response order for the tied group.
    expect(result.value.auditEntries.map((a) => a.kind)).toEqual([
      "tool_call",
      "model_call",
      "tool_call",
    ]);
  });

  test("audit entries sharing the same timestamp are sorted by turnIndex", async () => {
    // AuditSink.query() does not promise stable ordering. The ledger must
    // impose a deterministic secondary key on timestamp ties so that
    // same-millisecond decisions don't render in arbitrary order — which
    // would invert adjacent entries during incident review.
    const audits: readonly AuditEntry[] = [
      // All share timestamp 500 — sink returned them out of turnIndex order.
      makeAuditEntry({ timestamp: 500, turnIndex: 3, sessionId: "s-1" }),
      makeAuditEntry({ timestamp: 500, turnIndex: 1, sessionId: "s-1" }),
      makeAuditEntry({ timestamp: 500, turnIndex: 2, sessionId: "s-1" }),
      // Later timestamp — should still come last.
      makeAuditEntry({ timestamp: 600, turnIndex: 0, sessionId: "s-1" }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.auditEntries.map((a) => `${a.timestamp}:${a.turnIndex}`)).toEqual([
      "500:1",
      "500:2",
      "500:3",
      "600:0",
    ]);
  });
});

describe("getLedger — happy path lanes", () => {
  test("trajectory lane returned in stepIndex order, audit lane sorted by timestamp", async () => {
    const steps: readonly RichTrajectoryStep[] = [
      makeTrajectoryStep({ timestamp: 100, stepIndex: 1, identifier: "t-1" }),
      makeTrajectoryStep({ timestamp: 300, stepIndex: 2, identifier: "t-2" }),
    ];
    const audits: readonly AuditEntry[] = [
      // Intentionally out of order — fetchAudit should sort.
      makeAuditEntry({ timestamp: 400, sessionId: "s-1", turnIndex: 2 }),
      makeAuditEntry({ timestamp: 200, sessionId: "s-1", turnIndex: 1 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["s-1", steps]])),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });

    const result = await ledger.getLedger("s-1");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.trajectorySteps.map((s) => s.stepIndex)).toEqual([1, 2]);
    expect(result.value.auditEntries.map((a) => a.timestamp)).toEqual([200, 400]);
    // Trajectory is always `present-unverified` when records exist —
    // never `present` — because the ledger cannot field-verify trajectory.
    expect(result.value.sources.trajectory.state).toBe("present-unverified");
    expect(result.value.sources.audit.state).toBe("present");
    expect(result.value.sources.report.state).toBe("unqueryable");
    expect(result.value.runReport).toBeUndefined();
  });

  test("trajectory is never reported as clean 'present' — always 'present-unverified' when records exist", async () => {
    const steps: readonly RichTrajectoryStep[] = [makeTrajectoryStep({ stepIndex: 1 })];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["s-1", steps]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // A naive caller writing `if (state === "present") trust()` will NOT
    // take the trust branch for trajectory. This forces explicit handling
    // of the unverifiable-trust model.
    expect(result.value.sources.trajectory.state).toBe("present-unverified");
    const naivePresentCheck: boolean =
      result.value.sources.trajectory.state === ("present" as string);
    expect(naivePresentCheck).toBe(false);
  });
});

describe("getLedger — session integrity filtering", () => {
  test("audit entries with mismatched sessionId are dropped and counted at top level", async () => {
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 100, sessionId: "s-1", turnIndex: 1 }),
      // Cross-session leak — buggy sink returned another session's record.
      makeAuditEntry({ timestamp: 200, sessionId: "other-session", turnIndex: 99 }),
      makeAuditEntry({ timestamp: 300, sessionId: "s-1", turnIndex: 2 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.auditEntries.length).toBe(2);
    for (const entry of result.value.auditEntries) {
      expect(entry.sessionId).toBe("s-1");
    }
    // Lane carries usable data, but the dedicated `present-with-leakage`
    // state forces any exhaustive switch on `state` to handle the leak.
    // A naive `state === "present"` branch will NOT match — the caller
    // either drops the records (fail safe) or explicitly handles the new
    // state. Top-level `integrityLeakCounts` carries the count.
    expect(result.value.sources.audit.state).toBe("present-with-leakage");
    if (result.value.sources.audit.state === "present-with-leakage") {
      expect(result.value.sources.audit.integrityFilteredCount).toBe(1);
    }
    expect(result.value.integrityLeakCounts.audit).toBe(1);
    expect(result.value.integrityLeakCounts.report).toBe(0);
    expect(result.value.trajectoryTrustModel).toBe("store-authoritative");
  });

  test("audit sink that returns only other-session records reports integrity-violation as a distinct state AND propagates count to top-level", async () => {
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 100, sessionId: "other", turnIndex: 1 }),
      makeAuditEntry({ timestamp: 200, sessionId: "other", turnIndex: 2 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.auditEntries).toEqual([]);
    const auditStatus = result.value.sources.audit;
    // Critical: a caller that switches only on `state` must NOT alias this
    // to `missing`. It is a dedicated branch signalling trust-boundary
    // failure in the backing sink.
    expect(auditStatus.state).toBe("integrity-violation");
    if (auditStatus.state === "integrity-violation") {
      expect(auditStatus.integrityFilteredCount).toBe(2);
    }
    // AND the top-level count must reflect it — a flat caller reading only
    // `integrityLeakCounts.audit` must see the trust-boundary failure,
    // not a benign zero.
    expect(result.value.integrityLeakCounts.audit).toBe(2);
  });

  test("flat caller that ignores sources.*.state can still detect full integrity-violation via integrityLeakCounts", async () => {
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 100, sessionId: "other", turnIndex: 1 }),
      makeAuditEntry({ timestamp: 200, sessionId: "other", turnIndex: 2 }),
      makeAuditEntry({ timestamp: 300, sessionId: "other", turnIndex: 3 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // Simulate the monitoring pattern that only reads the flat top-level
    // discriminator: `if (integrityLeakCounts.audit > 0) alert()`.
    const flatCallerSeesViolation =
      result.value.integrityLeakCounts.audit > 0 || result.value.integrityLeakCounts.report > 0;
    expect(flatCallerSeesViolation).toBe(true);
    expect(result.value.integrityLeakCounts.audit).toBe(3);
  });

  test("audit sink that legitimately returns zero records reports missing (no integrity signal)", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", []]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // Legitimate "no data" — distinct from integrity-violation.
    expect(result.value.sources.audit.state).toBe("missing");
  });

  test("clean audit fetch reports all integrityLeakCounts as zero", async () => {
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 100, sessionId: "s-1", turnIndex: 1 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.audit.state).toBe("present");
    expect(result.value.integrityLeakCounts).toEqual({
      audit: 0,
      report: 0,
    });
    expect(result.value.trajectoryTrustModel).toBe("store-authoritative");
  });

  test("naive caller switching only on state === 'present' drops leaky records (fail-safe)", async () => {
    // The adversarial scenario: a caller literally only checks
    // `state === "present"`. With the dedicated `present-with-leakage`
    // branch, such a naive caller now misses the records entirely —
    // the fail-safe outcome (drop) rather than the fail-unsafe outcome
    // (silently render leaky data as if it were clean).
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 100, sessionId: "s-1", turnIndex: 1 }),
      makeAuditEntry({ timestamp: 200, sessionId: "other", turnIndex: 1 }),
      makeAuditEntry({ timestamp: 300, sessionId: "other", turnIndex: 2 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.audit.state).toBe("present-with-leakage");
    // Naive caller that switches only on `state === "present"` misses data.
    // This is the point — the dedicated discriminant forces them to handle.
    const naiveCallerSawRecords = result.value.sources.audit.state === ("present" as string);
    expect(naiveCallerSawRecords).toBe(false);
    // The data IS still usable if the caller explicitly handles the new branch.
    expect(result.value.auditEntries.length).toBe(1);
    expect(result.value.integrityLeakCounts.audit).toBe(2);
  });

  test("childReports with different sessionIds are PRESERVED — they represent legitimate delegated sub-agent runs", async () => {
    // Per kernel/engine/delivery-policy.ts:212, delegated child agents
    // get `sessionId: sessionId(\`delivery-${childId}\`)` — a different
    // session from the parent BY DESIGN. The ledger must NOT strip these
    // as if they were cross-session leaks; doing so would destroy
    // legitimate delegation history. Integrity filtering happens at the
    // top-level `getBySession()` boundary only.
    const delegatedChild = makeRunReport({
      sessionIdOverride: "delivery-child-agent-123",
      summary: "delegated-sub-run",
    });
    const anotherDelegated = makeRunReport({
      sessionIdOverride: "delivery-child-agent-456",
      summary: "another-delegated-sub-run",
    });
    const parent = makeRunReport({
      sessionIdOverride: "s-1",
      summary: "parent-with-delegated-children",
      childReports: [delegatedChild, anotherDelegated],
    });
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      reportStore: createFakeReportStore(new Map([["s-1", [parent]]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.runReport?.summary).toBe("parent-with-delegated-children");
    // Both delegated children preserved despite having different sessionIds.
    expect(result.value.runReport?.childReports?.length).toBe(2);
    expect(result.value.runReport?.childReports?.[0]?.summary).toBe("delegated-sub-run");
    expect(result.value.runReport?.childReports?.[1]?.summary).toBe("another-delegated-sub-run");
    // No integrity violation — childReports are legitimate delegation data.
    expect(result.value.integrityLeakCounts.report).toBe(0);
    expect(result.value.sources.report.state).toBe("present");
  });

  test("cyclic childReports graph does not stack-overflow; report lane still fetches successfully", async () => {
    // Adversarial / buggy store: build a cyclic report graph and verify
    // the ceiling accounting walk terminates instead of failing the lane.
    const base = makeRunReport({ sessionIdOverride: "s-1", summary: "cyclic" });
    // Mutate the readonly field via a type-unsafe cast scoped to the test
    // — we're deliberately constructing a corrupt graph the type system
    // would normally prevent, to verify the walker's cycle guard.
    const mutable = base as { childReports?: readonly RunReport[] };
    mutable.childReports = [base, base];

    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      reportStore: createFakeReportStore(new Map([["s-1", [base]]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // The lane returned successfully — the cyclic graph did not blow up
    // the report fetch path.
    expect(result.value.sources.report.state).toBe("present");
    expect(result.value.runReport?.summary).toBe("cyclic");
  });

  test("extremely deep linear childReports chain does not stack-overflow", async () => {
    // 20k-deep chain: a recursive walker would blow the JS stack
    // (V8 default is ~10k frames); the iterative walker must handle it.
    let current: RunReport | undefined;
    for (let i = 0; i < 20_000; i += 1) {
      const next = makeRunReport({
        sessionIdOverride: "s-1",
        summary: `deep-${i}`,
      }) as { childReports?: readonly RunReport[] } & RunReport;
      if (current) {
        next.childReports = [current];
      }
      current = next;
    }
    if (!current) {
      throw new Error("failed to build chain");
    }
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      reportStore: createFakeReportStore(new Map([["s-1", [current]]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    // The fetch completed — no stack overflow. 20k < 50k soft ceiling,
    // so state is plain `present`, not `present-with-leakage`.
    expect(result.value.sources.report.state).toBe("present");
    expect(result.value.runReport?.summary).toBe("deep-19999");
  });

  test("soft-ceiling warning fires on a single top-level report with a huge nested childReports tree", async () => {
    const { LEDGER_SOFT_CEILING } = await import("./create-decision-ledger.js");
    // Build a flat list of N-1 legitimate children under one parent so
    // the tree has >LEDGER_SOFT_CEILING total nodes.
    const targetNodes = LEDGER_SOFT_CEILING + 100;
    const children: RunReport[] = [];
    for (let i = 0; i < targetNodes - 1; i += 1) {
      children.push(makeRunReport({ sessionIdOverride: "s-1", summary: `c-${i}` }));
    }
    const parent = makeRunReport({
      sessionIdOverride: "s-1",
      summary: "huge-parent",
      childReports: children,
    });
    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (message: string, ...rest: unknown[]) => {
      warnCalls.push([message, ...rest.map(String)].join(" "));
    };
    try {
      const ledger = createDecisionLedger({
        trajectoryStore: createFakeTrajectoryReader(new Map()),
        reportStore: createFakeReportStore(new Map([["s-1", [parent]]])),
      });
      const result = await ledger.getLedger("s-1");
      if (!result.ok) {
        throw new Error("expected ok");
      }
      // Only 1 top-level report, but the nested tree counts toward rawCount.
      expect(result.value.runReport?.summary).toBe("huge-parent");
      const softCeilingWarnings = warnCalls.filter((line) => line.includes("exceeds soft ceiling"));
      expect(softCeilingWarnings.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("run reports with mismatched sessionId are dropped and counted", async () => {
    const wrong = makeRunReport({
      summary: "wrong",
      duration: {
        startedAt: 100,
        completedAt: 200,
        durationMs: 100,
        totalTurns: 1,
        totalActions: 0,
        truncated: false,
      },
    });
    // makeRunReport hard-codes sessionId to "default-session"; the ledger
    // is queried for "s-1", so it must drop this as an integrity violation.
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      reportStore: createFakeReportStore(new Map([["s-1", [wrong]]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.runReport).toBeUndefined();
    const reportStatus = result.value.sources.report;
    expect(reportStatus.state).toBe("integrity-violation");
    if (reportStatus.state === "integrity-violation") {
      expect(reportStatus.integrityFilteredCount).toBe(1);
    }
  });
});

describe("getLedger — source status matrix", () => {
  test("trajectory empty → sources.trajectory.missing", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.trajectorySteps).toEqual([]);
    expect(result.value.auditEntries).toEqual([]);
    expect(result.value.sources.trajectory.state).toBe("missing");
    expect(result.value.sources.audit.state).toBe("unqueryable");
    expect(result.value.sources.report.state).toBe("unqueryable");
  });

  test("audit sink without query → sources.audit.unqueryable", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      auditSink: createFakeAuditSink({ includeQuery: false }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.audit.state).toBe("unqueryable");
  });

  test("audit query throws → sources.audit.error; trajectory still present", async () => {
    const steps: readonly RichTrajectoryStep[] = [makeTrajectoryStep({ timestamp: 10 })];
    const auditError = new Error("boom");
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["s-1", steps]])),
      auditSink: createFakeAuditSink({ queryThrows: auditError }),
    });

    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.trajectory.state).toBe("present-unverified");
    expect(result.value.sources.audit.state).toBe("error");
    if (result.value.sources.audit.state === "error") {
      expect(result.value.sources.audit.error.code).toBe("EXTERNAL");
      expect(result.value.sources.audit.error.cause).toBe(auditError);
    }
    expect(result.value.trajectorySteps.length).toBe(1);
  });

  test("trajectory throws → sources.trajectory.error; other sources still populated", async () => {
    const trajectoryError = new Error("disk gone");
    const ledger = createDecisionLedger({
      trajectoryStore: createThrowingTrajectoryReader(trajectoryError),
      auditSink: createFakeAuditSink({
        entries: new Map([["s-1", [makeAuditEntry({ timestamp: 50, sessionId: "s-1" })]]]),
      }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.trajectory.state).toBe("error");
    expect(result.value.sources.audit.state).toBe("present");
    expect(result.value.trajectorySteps).toEqual([]);
    expect(result.value.auditEntries.length).toBe(1);
  });
});

describe("getLedger — run report sidecar", () => {
  test("no report store → sources.report.unqueryable, runReport undefined", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.report.state).toBe("unqueryable");
    expect(result.value.runReport).toBeUndefined();
  });

  test("report store returns empty → sources.report.missing", async () => {
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      reportStore: createFakeReportStore(new Map()),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.report.state).toBe("missing");
    expect(result.value.runReport).toBeUndefined();
  });

  test("multiple reports → latest completedAt wins (both carry matching sessionId)", async () => {
    const older = makeRunReport({
      sessionIdOverride: "s-1",
      duration: {
        startedAt: 100,
        completedAt: 200,
        durationMs: 100,
        totalTurns: 1,
        totalActions: 0,
        truncated: false,
      },
      summary: "older",
    });
    const newer = makeRunReport({
      sessionIdOverride: "s-1",
      duration: {
        startedAt: 300,
        completedAt: 500,
        durationMs: 200,
        totalTurns: 1,
        totalActions: 0,
        truncated: false,
      },
      summary: "newer",
    });
    const reports: readonly RunReport[] = [older, newer];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map()),
      reportStore: createFakeReportStore(new Map([["s-1", reports]])),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.report.state).toBe("present");
    expect(result.value.runReport?.summary).toBe("newer");
  });

  test("report store throws → sources.report.error, lanes still returned", async () => {
    const steps: readonly RichTrajectoryStep[] = [makeTrajectoryStep({ timestamp: 1 })];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["s-1", steps]])),
      reportStore: createFakeReportStore(new Map(), { throws: new Error("db down") }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.report.state).toBe("error");
    expect(result.value.trajectorySteps.length).toBe(1);
  });
});

describe("getLedger — large session", () => {
  test("partial-leak fetch with huge raw payload triggers soft-ceiling warning even when filtered lane is small", async () => {
    // Regression: a buggy sink returning 60k wrong-session records with
    // only 3 matching still costs memory/time to process. The ceiling
    // must fire against RAW counts, not filtered lane sizes.
    const { LEDGER_SOFT_CEILING } = await import("./create-decision-ledger.js");
    const audits: AuditEntry[] = [];
    for (let i = 0; i < LEDGER_SOFT_CEILING + 1000; i += 1) {
      audits.push(makeAuditEntry({ timestamp: i, sessionId: "other-session", turnIndex: i }));
    }
    audits.push(makeAuditEntry({ timestamp: 0, sessionId: "s-target", turnIndex: 1 }));
    audits.push(makeAuditEntry({ timestamp: 1, sessionId: "s-target", turnIndex: 2 }));

    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (message: string, ...rest: unknown[]) => {
      warnCalls.push([message, ...rest.map(String)].join(" "));
    };
    try {
      const ledger = createDecisionLedger({
        trajectoryStore: createFakeTrajectoryReader(new Map()),
        auditSink: createFakeAuditSink({ entries: new Map([["s-target", audits]]) }),
      });
      const result = await ledger.getLedger("s-target");
      if (!result.ok) {
        throw new Error("expected ok");
      }
      // Filtered lane is tiny — 2 records — but raw payload was huge.
      expect(result.value.auditEntries.length).toBe(2);
      const softCeilingWarnings = warnCalls.filter((line) => line.includes("exceeds soft ceiling"));
      expect(softCeilingWarnings.length).toBe(1);
      // And the partial-leak count at the top level should still flag it.
      expect(result.value.integrityLeakCounts.audit).toBe(LEDGER_SOFT_CEILING + 1000);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("combined size over soft ceiling emits warning and still returns full lanes", async () => {
    const { LEDGER_SOFT_CEILING } = await import("./create-decision-ledger.js");
    const steps: RichTrajectoryStep[] = [];
    for (let i = 0; i < LEDGER_SOFT_CEILING + 1; i += 1) {
      steps.push(makeTrajectoryStep({ timestamp: i, identifier: `big-${i}`, stepIndex: i }));
    }
    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (message: string, ...rest: unknown[]) => {
      warnCalls.push([message, ...rest.map(String)].join(" "));
    };
    try {
      const ledger = createDecisionLedger({
        trajectoryStore: createFakeTrajectoryReader(new Map([["big", steps]])),
      });
      const result = await ledger.getLedger("big");
      if (!result.ok) {
        throw new Error("expected ok");
      }
      expect(result.value.trajectorySteps.length).toBe(LEDGER_SOFT_CEILING + 1);
      const softCeilingWarnings = warnCalls.filter((line) => line.includes("exceeds soft ceiling"));
      expect(softCeilingWarnings.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("10k trajectory + 10k audit entries returned without crash; audit lane sorted", async () => {
    const steps: RichTrajectoryStep[] = [];
    const audits: AuditEntry[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      steps.push(makeTrajectoryStep({ timestamp: i * 2, identifier: `s-${i}`, stepIndex: i }));
      // Out-of-order timestamps to exercise sort.
      audits.push(
        makeAuditEntry({ timestamp: (10_000 - i) * 2 + 1, sessionId: "big", turnIndex: i }),
      );
    }
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["big", steps]])),
      auditSink: createFakeAuditSink({ entries: new Map([["big", audits]]) }),
    });
    const result = await ledger.getLedger("big");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.trajectorySteps.length).toBe(10_000);
    expect(result.value.auditEntries.length).toBe(10_000);
    for (let i = 1; i < result.value.auditEntries.length; i += 1) {
      const prev = result.value.auditEntries[i - 1];
      const cur = result.value.auditEntries[i];
      if (!prev || !cur) {
        throw new Error("index out of bounds");
      }
      expect(cur.timestamp).toBeGreaterThanOrEqual(prev.timestamp);
    }
  });
});
