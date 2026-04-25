import { describe, expect, it, spyOn } from "bun:test";
import { agentId, type JsonObject, type PersistentGrant, sessionId } from "@koi/core";
import type { GovernanceVerdict, PolicyRequest, Violation } from "@koi/core/governance-backend";
import type { ApprovalStore, PersistedApproval } from "./types.js";
import { createViolationAuditAdapter } from "./violation-audit.js";

type Recorded = { readonly verdict: GovernanceVerdict; readonly request: PolicyRequest };

function makeStore(): { readonly store: ApprovalStore; readonly appended: PersistedApproval[] } {
  const appended: PersistedApproval[] = [];
  return {
    appended,
    store: {
      append: async (g) => {
        appended.push(g);
      },
      match: async () => undefined,
      load: async () => appended,
    },
  };
}

const grant: PersistentGrant = {
  kind: "tool_call",
  agentId: agentId("a1"),
  sessionId: sessionId("s1"),
  payload: { tool: "bash", cmd: "ls" } satisfies JsonObject,
  grantKey: "deadbeef",
  grantedAt: 1_713_974_400_000,
};

describe("createViolationAuditAdapter", () => {
  it("appends to the store and emits an info violation per grant", async () => {
    const recorded: Recorded[] = [];
    const onViolation = (verdict: GovernanceVerdict, request: PolicyRequest): void => {
      recorded.push({ verdict, request });
    };
    const { store, appended } = makeStore();
    const auditedSink = createViolationAuditAdapter({ store, onViolation });
    await auditedSink(grant);

    expect(appended.length).toBe(1);
    expect(appended[0]?.grantKey).toBe(grant.grantKey);
    expect(appended[0]?.agentId).toBe(grant.agentId);

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

  it("emits onViolation after the append resolves (ordering)", async () => {
    const order: string[] = [];
    const store: ApprovalStore = {
      append: async () => {
        order.push("append");
      },
      match: async () => undefined,
      load: async () => [],
    };
    const onViolation = (): void => {
      order.push("audit");
    };
    const auditedSink = createViolationAuditAdapter({ store, onViolation });
    await auditedSink(grant);
    expect(order).toEqual(["append", "audit"]);
  });

  // Codex round-1 finding: onApprovalPersist is fire-and-forget; the
  // adapter must absorb append failures without rejecting.
  // Codex round-2 finding: the audit row MUST NOT be emitted when the
  // append fails — otherwise violations.db claims a durable grant that
  // approvals.json has no row for.
  it("absorbs append failures AND suppresses the audit verdict", async () => {
    let auditCalls = 0;
    const failingStore: ApprovalStore = {
      append: async () => {
        throw new Error("ENOSPC");
      },
      match: async () => undefined,
      load: async () => [],
    };
    const onViolation = (): void => {
      auditCalls += 1;
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const auditedSink = createViolationAuditAdapter({
      store: failingStore,
      onViolation,
    });
    await auditedSink(grant);
    expect(auditCalls).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses resolveAgentId to pin both the persisted record AND the audit request scope", async () => {
    const recorded: Recorded[] = [];
    const onViolation = (verdict: GovernanceVerdict, request: PolicyRequest): void => {
      recorded.push({ verdict, request });
    };
    const stable = agentId("koi-tui");
    const { store, appended } = makeStore();
    const auditedSink = createViolationAuditAdapter({
      store,
      onViolation,
      resolveAgentId: () => stable,
    });
    await auditedSink(grant); // grant.agentId is "a1"
    expect(appended[0]?.agentId).toBe(stable);
    expect(recorded[0]?.request.agentId).toBe(stable);
  });

  // Codex round-1 finding: a buggy onViolation subscriber must not
  // crash the fire-and-forget callback.
  it("absorbs onViolation failures", async () => {
    const { store, appended } = makeStore();
    const failingViolation = (): void => {
      throw new Error("subscriber blew up");
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const auditedSink = createViolationAuditAdapter({
      store,
      onViolation: failingViolation,
    });
    await auditedSink(grant);
    expect(appended.length).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
