import { describe, expect, it, spyOn } from "bun:test";
import { agentId, type JsonObject, type PersistentGrant, sessionId } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest, Violation } from "@koi/core/governance-backend";
import { createViolationAuditAdapter } from "./violation-audit.js";

type Recorded = { readonly verdict: GovernanceVerdict; readonly request: PolicyRequest };

const grant: PersistentGrant = {
  kind: "tool_call",
  agentId: agentId("a1"),
  sessionId: sessionId("s1"),
  payload: { tool: "bash", cmd: "ls" } satisfies JsonObject,
  grantKey: "deadbeef",
  grantedAt: 1_713_974_400_000,
};

describe("createViolationAuditAdapter", () => {
  it("wraps a persist-sink so each grant emits an info violation", async () => {
    const recorded: Recorded[] = [];
    const onViolation = (verdict: GovernanceVerdict, request: PolicyRequest): void => {
      recorded.push({ verdict, request });
    };
    const innerSink = async (_g: PersistentGrant): Promise<void> => undefined;
    const auditedSink = createViolationAuditAdapter({ sink: innerSink, onViolation });
    await auditedSink(grant);

    expect(recorded.length).toBe(1);
    const rec = recorded[0];
    if (rec === undefined) throw new Error("no record");
    expect(rec.request.kind).toBe("tool_call");
    expect(rec.request.agentId).toBe(grant.agentId);
    expect(rec.request.payload).toEqual(grant.payload);

    if (rec.verdict.ok !== true) throw new Error("verdict must be allow");
    const diag = rec.verdict.diagnostics ?? [];
    const v = diag[0];
    if (v === undefined) throw new Error("no diagnostic");
    const audit: Violation = v;
    expect(audit.rule).toBe("approval.persisted");
    expect(audit.severity).toBe("info");
    expect(audit.context).toMatchObject({ grantKey: grant.grantKey });
  });

  it("still calls the inner sink", async () => {
    let innerCalled = 0;
    const innerSink = async (_g: PersistentGrant): Promise<void> => {
      innerCalled += 1;
    };
    const auditedSink = createViolationAuditAdapter({
      sink: innerSink,
      onViolation: () => undefined,
    });
    await auditedSink(grant);
    expect(innerCalled).toBe(1);
  });

  it("runs onViolation after the inner sink resolves", async () => {
    const order: string[] = [];
    const innerSink = async (): Promise<void> => {
      order.push("inner");
    };
    const onViolation = (): void => {
      order.push("audit");
    };
    const auditedSink = createViolationAuditAdapter({ sink: innerSink, onViolation });
    await auditedSink(grant);
    expect(order).toEqual(["inner", "audit"]);
  });

  // Codex round-1 finding: onApprovalPersist is fire-and-forget; the
  // adapter must absorb sink failures without rejecting.
  it("absorbs inner sink failures and skips emitting the audit verdict", async () => {
    let auditCalls = 0;
    const failingSink = async (): Promise<void> => {
      throw new Error("ENOSPC");
    };
    const onViolation = (): void => {
      auditCalls += 1;
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const auditedSink = createViolationAuditAdapter({ sink: failingSink, onViolation });
    // Must not reject.
    await auditedSink(grant);
    expect(auditCalls).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses resolveAgentId to pin the audit request scope to the persisted scope", async () => {
    const recorded: Recorded[] = [];
    const onViolation = (verdict: GovernanceVerdict, request: PolicyRequest): void => {
      recorded.push({ verdict, request });
    };
    const stable = agentId("koi-tui");
    const auditedSink = createViolationAuditAdapter({
      sink: async () => undefined,
      onViolation,
      resolveAgentId: () => stable,
    });
    await auditedSink(grant); // grant.agentId is "a1"
    expect(recorded[0]?.request.agentId).toBe(stable);
  });

  // Codex round-1 finding: a buggy onViolation host must not crash the
  // sink callback.
  it("absorbs onViolation failures", async () => {
    let innerCalls = 0;
    const innerSink = async (): Promise<void> => {
      innerCalls += 1;
    };
    const failingViolation = (): void => {
      throw new Error("subscriber blew up");
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const auditedSink = createViolationAuditAdapter({
      sink: innerSink,
      onViolation: failingViolation,
    });
    await auditedSink(grant);
    expect(innerCalls).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
