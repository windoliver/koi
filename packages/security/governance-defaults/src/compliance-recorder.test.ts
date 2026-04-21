import { describe, expect, spyOn, test } from "bun:test";
import type {
  AuditEntry,
  AuditSink,
  ComplianceRecord,
  GovernanceVerdict,
  PolicyRequest,
} from "@koi/core";
import { agentId } from "@koi/core";
import {
  createAuditSinkComplianceRecorder,
  fanOutComplianceRecorder,
} from "./compliance-recorder.js";

function makeRecord(overrides?: Partial<ComplianceRecord>): ComplianceRecord {
  const request: PolicyRequest = {
    kind: "tool_call",
    agentId: agentId("agent-1"),
    payload: { tool: "bash" },
    timestamp: 1_700_000_000_000,
  };
  const verdict: GovernanceVerdict = { ok: true };
  return {
    requestId: "req-1",
    request,
    verdict,
    evaluatedAt: 1_700_000_000_500,
    policyFingerprint: "v1:abcd",
    ...overrides,
  };
}

function makeSink(): AuditSink & { readonly logs: AuditEntry[] } {
  const logs: AuditEntry[] = [];
  return {
    log: async (entry: AuditEntry): Promise<void> => {
      logs.push(entry);
    },
    logs,
  };
}

describe("createAuditSinkComplianceRecorder", () => {
  test("maps ComplianceRecord to AuditEntry with compliance_event kind", async () => {
    const sink = makeSink();
    const recorder = createAuditSinkComplianceRecorder(sink, {
      sessionId: "sess-xyz",
    });
    const record = makeRecord();

    const returned = await recorder.recordCompliance(record);

    expect(returned).toBe(record);
    expect(sink.logs).toHaveLength(1);
    const entry = sink.logs[0];
    expect(entry?.kind).toBe("compliance_event");
    expect(entry?.sessionId).toBe("sess-xyz");
    expect(entry?.agentId).toBe(record.request.agentId);
    expect(entry?.timestamp).toBe(record.evaluatedAt);
    expect(entry?.turnIndex).toBe(0);
    expect(entry?.durationMs).toBe(0);
    expect(entry?.request).toEqual(record.request);
    expect(entry?.response).toEqual(record.verdict);
    expect(entry?.metadata).toEqual({
      requestId: "req-1",
      policyFingerprint: "v1:abcd",
    });
  });

  test("ignores sessionId on request — always uses ctx.sessionId", async () => {
    const sink = makeSink();
    const recorder = createAuditSinkComplianceRecorder(sink, {
      sessionId: "ctx-session",
    });
    await recorder.recordCompliance(
      makeRecord({
        request: {
          ...makeRecord().request,
          payload: { sessionId: "payload-session" },
        },
      }),
    );
    expect(sink.logs[0]?.sessionId).toBe("ctx-session");
  });

  test("sink rejection invokes onError, does not throw", async () => {
    const failing: AuditSink = {
      log: async () => {
        throw new Error("disk full");
      },
    };
    let seen: unknown;
    const recorder = createAuditSinkComplianceRecorder(failing, {
      sessionId: "sess-1",
      onError: (err) => {
        seen = err;
      },
    });

    // Must not throw
    const result = await recorder.recordCompliance(makeRecord());
    expect(result).toBeDefined();
    // Give microtask queue a chance to flush the swallowed rejection
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBeInstanceOf(Error);
    expect((seen as Error).message).toBe("disk full");
  });

  test("default onError is console.warn", async () => {
    const failing: AuditSink = {
      log: async () => {
        throw new Error("boom");
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorder = createAuditSinkComplianceRecorder(failing, {
        sessionId: "sess-1",
      });
      await recorder.recordCompliance(makeRecord());
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("fanOutComplianceRecorder", () => {
  test("zero recorders returns a no-op that still returns the record", async () => {
    const recorder = fanOutComplianceRecorder([]);
    const rec = makeRecord();
    expect(await recorder.recordCompliance(rec)).toBe(rec);
  });

  test("single recorder is passed through (no wrapper allocation)", async () => {
    const sink = makeSink();
    const inner = createAuditSinkComplianceRecorder(sink, { sessionId: "s" });
    const outer = fanOutComplianceRecorder([inner]);
    expect(outer).toBe(inner);
  });

  test("multi-recorder writes to every sink", async () => {
    const a = makeSink();
    const b = makeSink();
    const outer = fanOutComplianceRecorder([
      createAuditSinkComplianceRecorder(a, { sessionId: "s" }),
      createAuditSinkComplianceRecorder(b, { sessionId: "s" }),
    ]);
    await outer.recordCompliance(makeRecord());
    expect(a.logs).toHaveLength(1);
    expect(b.logs).toHaveLength(1);
  });
});
