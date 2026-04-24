import { describe, expect, it } from "bun:test";
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
});
