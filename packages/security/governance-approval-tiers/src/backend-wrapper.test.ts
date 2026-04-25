import { describe, expect, it } from "bun:test";
import { agentId, type JsonObject } from "@koi/core";
import {
  askId,
  type GovernanceBackend,
  type GovernanceVerdict,
  type PolicyRequest,
} from "@koi/core/governance-backend";
import { computeGrantKey } from "@koi/hash";
import { wrapBackendWithPersistedAllowlist } from "./backend-wrapper.js";
import type { ApprovalStore, PersistedApproval } from "./types.js";

function makeStore(entries: readonly PersistedApproval[]): ApprovalStore {
  return {
    append: async () => undefined,
    load: async () => entries,
    async match(q) {
      const target = computeGrantKey(q.kind, q.payload);
      return entries.find((e) => e.agentId === q.agentId && e.grantKey === target);
    },
  };
}

const AID = agentId("a");
const OTHER_AID = agentId("b");
const allowRequest: PolicyRequest = {
  kind: "tool_call",
  agentId: AID,
  payload: { tool: "bash" } satisfies JsonObject,
  timestamp: 0,
};

describe("wrapBackendWithPersistedAllowlist", () => {
  it("passes through ok:true verdicts unchanged", async () => {
    const inner: GovernanceBackend = {
      evaluator: { evaluate: () => ({ ok: true }) satisfies GovernanceVerdict },
    };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(true);
  });

  it("passes through ok:false verdicts unchanged", async () => {
    const deny: GovernanceVerdict = {
      ok: false,
      violations: [{ rule: "r", severity: "critical", message: "nope" }],
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => deny } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(false);
  });

  it("converts ok:ask to ok:true when the store has a match for this agent", async () => {
    const payload = { tool: "bash" } satisfies JsonObject;
    const grantKey = computeGrantKey("tool_call", payload);
    const store = makeStore([{ kind: "tool_call", agentId: AID, payload, grantKey, grantedAt: 1 }]);
    const ask: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("x"),
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => ask } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, store);
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(true);
  });

  // Codex round-1 finding: an approval recorded for one agent must
  // never satisfy a query from a different agent, even when (kind,
  // payload) collide.
  it("leaves ok:ask unchanged when the only matching grant is for a different agent", async () => {
    const payload = { tool: "bash" } satisfies JsonObject;
    const grantKey = computeGrantKey("tool_call", payload);
    const store = makeStore([
      { kind: "tool_call", agentId: OTHER_AID, payload, grantKey, grantedAt: 1 },
    ]);
    const ask: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("x"),
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => ask } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, store);
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe("ask");
  });

  it("uses resolveAgentId when provided (host-pinned scope)", async () => {
    const stable = agentId("koi-tui");
    const payload = { tool: "bash" } satisfies JsonObject;
    const grantKey = computeGrantKey("tool_call", payload);
    const store = makeStore([
      { kind: "tool_call", agentId: stable, payload, grantKey, grantedAt: 1 },
    ]);
    const ask: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("x"),
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => ask } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, store, {
      resolveAgentId: () => stable,
    });
    // Live request carries a different agentId — wrapper must remap.
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe(true);
  });

  it("leaves ok:ask unchanged when the store has no match", async () => {
    const ask: GovernanceVerdict = {
      ok: "ask",
      prompt: "?",
      askId: askId("x"),
    };
    const inner: GovernanceBackend = { evaluator: { evaluate: () => ask } };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    const v = await wrapped.evaluator.evaluate(allowRequest);
    expect(v.ok).toBe("ask");
  });

  it("preserves optional sub-interfaces of the wrapped backend", async () => {
    const inner: GovernanceBackend = {
      evaluator: { evaluate: () => ({ ok: true }) satisfies GovernanceVerdict },
      compliance: { recordCompliance: (r) => r },
      describeRules: () => [],
    };
    const wrapped = wrapBackendWithPersistedAllowlist(inner, makeStore([]));
    expect(wrapped.compliance).toBe(inner.compliance);
    expect(wrapped.describeRules).toBe(inner.describeRules);
  });
});
