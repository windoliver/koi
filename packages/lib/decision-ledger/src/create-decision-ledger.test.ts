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

describe("getLedger — happy path", () => {
  test("interleaves trajectory and audit entries by timestamp", async () => {
    const steps: readonly RichTrajectoryStep[] = [
      makeTrajectoryStep({ timestamp: 100, identifier: "t-100" }),
      makeTrajectoryStep({ timestamp: 300, identifier: "t-300" }),
    ];
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 200, sessionId: "s-1" }),
      makeAuditEntry({ timestamp: 400, sessionId: "s-1" }),
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
    const kinds = result.value.entries.map((e) => `${e.kind}@${e.timestamp}`);
    expect(kinds).toEqual(["trajectory-step@100", "audit@200", "trajectory-step@300", "audit@400"]);
    expect(result.value.sources.trajectory.state).toBe("present");
    expect(result.value.sources.audit.state).toBe("present");
    expect(result.value.sources.report.state).toBe("unqueryable");
    expect(result.value.runReport).toBeUndefined();
  });

  test("stable sort preserves source order on timestamp ties", async () => {
    // All four entries share the same timestamp.
    const steps: readonly RichTrajectoryStep[] = [
      makeTrajectoryStep({ timestamp: 500, identifier: "t-a", stepIndex: 1 }),
      makeTrajectoryStep({ timestamp: 500, identifier: "t-b", stepIndex: 2 }),
    ];
    const audits: readonly AuditEntry[] = [
      makeAuditEntry({ timestamp: 500, turnIndex: 1 }),
      makeAuditEntry({ timestamp: 500, turnIndex: 2 }),
    ];
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["s-1", steps]])),
      auditSink: createFakeAuditSink({ entries: new Map([["s-1", audits]]) }),
    });

    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    const order = result.value.entries.map((e) =>
      e.kind === "trajectory-step" ? `t-${e.stepIndex}` : `a-${e.turnIndex}`,
    );
    // Trajectory entries come first on ties (concatenation order before sort),
    // and within each source the relative order is preserved.
    expect(order).toEqual(["t-1", "t-2", "a-1", "a-2"]);
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
    expect(result.value.entries).toEqual([]);
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
    expect(result.value.sources.trajectory.state).toBe("present");
    expect(result.value.sources.audit.state).toBe("error");
    if (result.value.sources.audit.state === "error") {
      expect(result.value.sources.audit.error.code).toBe("EXTERNAL");
      expect(result.value.sources.audit.error.cause).toBe(auditError);
    }
    expect(result.value.entries.length).toBe(1);
  });

  test("trajectory throws → sources.trajectory.error; other sources still populated", async () => {
    const trajectoryError = new Error("disk gone");
    const ledger = createDecisionLedger({
      trajectoryStore: createThrowingTrajectoryReader(trajectoryError),
      auditSink: createFakeAuditSink({
        entries: new Map([["s-1", [makeAuditEntry({ timestamp: 50 })]]]),
      }),
    });
    const result = await ledger.getLedger("s-1");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.sources.trajectory.state).toBe("error");
    expect(result.value.sources.audit.state).toBe("present");
    expect(result.value.entries.length).toBe(1);
    expect(result.value.entries[0]?.kind).toBe("audit");
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

  test("multiple reports → latest completedAt wins", async () => {
    const older = makeRunReport({
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

  test("report store throws → sources.report.error, entries still returned", async () => {
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
    expect(result.value.entries.length).toBe(1);
  });
});

describe("getLedger — large session soft ceiling", () => {
  test("10k trajectory + 10k audit entries merge in timestamp order without crash", async () => {
    const steps: RichTrajectoryStep[] = [];
    const audits: AuditEntry[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      steps.push(makeTrajectoryStep({ timestamp: i * 2, identifier: `s-${i}`, stepIndex: i }));
      audits.push(makeAuditEntry({ timestamp: i * 2 + 1, turnIndex: i }));
    }
    const ledger = createDecisionLedger({
      trajectoryStore: createFakeTrajectoryReader(new Map([["big", steps]])),
      auditSink: createFakeAuditSink({ entries: new Map([["big", audits]]) }),
    });
    const result = await ledger.getLedger("big");
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.value.entries.length).toBe(20_000);
    // Spot-check monotonic timestamps
    for (let i = 1; i < result.value.entries.length; i += 1) {
      const prev = result.value.entries[i - 1];
      const cur = result.value.entries[i];
      if (!prev || !cur) {
        throw new Error("index out of bounds");
      }
      expect(cur.timestamp).toBeGreaterThanOrEqual(prev.timestamp);
    }
  });
});
