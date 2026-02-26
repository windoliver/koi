import { describe, expect, test } from "bun:test";
import { brickId } from "./brick-snapshot.js";
import { agentId } from "./ecs.js";
import type {
  ChangeKind,
  ChangeTarget,
  GateRequirement,
  Proposal,
  ProposalEvent,
  ProposalGate,
  ProposalId,
  ProposalInput,
  ProposalResult,
  ProposalStatus,
  ProposalUnsubscribe,
  ReviewDecision,
} from "./proposal.js";
import { ALL_CHANGE_TARGETS, PROPOSAL_GATE_REQUIREMENTS, proposalId } from "./proposal.js";

// ---------------------------------------------------------------------------
// proposalId() factory
// ---------------------------------------------------------------------------

describe("proposalId()", () => {
  test("creates a branded ProposalId", () => {
    const id: ProposalId = proposalId("prop-abc123");
    expect(id).toBe(proposalId("prop-abc123"));
    expect(typeof id).toBe("string");
  });

  test("same input produces same output", () => {
    expect(proposalId("x")).toBe(proposalId("x"));
  });

  test("different inputs produce different values", () => {
    expect(proposalId("a")).not.toBe(proposalId("b"));
  });
});

// ---------------------------------------------------------------------------
// ALL_CHANGE_TARGETS
// ---------------------------------------------------------------------------

describe("ALL_CHANGE_TARGETS", () => {
  test("has exactly 8 entries", () => {
    expect(ALL_CHANGE_TARGETS).toHaveLength(8);
  });

  test("contains all expected ChangeTarget values", () => {
    const expected: readonly ChangeTarget[] = [
      "brick:sandboxed",
      "brick:promoted",
      "bundle_l2",
      "l1_extension",
      "l1_core",
      "l0_interface",
      "sandbox_policy",
      "gateway_routing",
    ];
    for (const target of expected) {
      expect(ALL_CHANGE_TARGETS).toContain(target);
    }
  });
});

// ---------------------------------------------------------------------------
// PROPOSAL_GATE_REQUIREMENTS
// ---------------------------------------------------------------------------

describe("PROPOSAL_GATE_REQUIREMENTS", () => {
  test("is frozen at runtime", () => {
    expect(Object.isFrozen(PROPOSAL_GATE_REQUIREMENTS)).toBe(true);
  });

  test("has an entry for every ChangeTarget in ALL_CHANGE_TARGETS", () => {
    for (const target of ALL_CHANGE_TARGETS) {
      expect(PROPOSAL_GATE_REQUIREMENTS[target]).toBeDefined();
    }
  });

  test("brick:sandboxed does not require HITL (lowest blast radius)", () => {
    expect(PROPOSAL_GATE_REQUIREMENTS["brick:sandboxed"].requiresHitl).toBe(false);
  });

  test("brick:sandboxed takes effect immediately", () => {
    expect(PROPOSAL_GATE_REQUIREMENTS["brick:sandboxed"].takeEffectOn).toBe("immediately");
  });

  test("l0_interface requires HITL (highest blast radius)", () => {
    expect(PROPOSAL_GATE_REQUIREMENTS.l0_interface.requiresHitl).toBe(true);
  });

  test("l0_interface requires full test suite", () => {
    expect(PROPOSAL_GATE_REQUIREMENTS.l0_interface.requiresFullTest).toBe(true);
  });

  test("l0_interface has all_agents_test scope", () => {
    expect(PROPOSAL_GATE_REQUIREMENTS.l0_interface.sandboxTestScope).toBe("all_agents_test");
  });

  test("all entries have valid GateRequirement shape", () => {
    for (const target of ALL_CHANGE_TARGETS) {
      const req = PROPOSAL_GATE_REQUIREMENTS[target] satisfies GateRequirement;
      expect(typeof req.requiresHitl).toBe("boolean");
      expect(typeof req.requiresFullTest).toBe("boolean");
      expect(typeof req.takeEffectOn).toBe("string");
      expect(typeof req.sandboxTestScope).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// ReviewDecision discriminated union
// ---------------------------------------------------------------------------

describe("ReviewDecision", () => {
  test("approved variant compiles without reason", () => {
    const decision: ReviewDecision = { kind: "approved" };
    expect(decision.kind).toBe("approved");
  });

  test("approved variant accepts optional reason", () => {
    const decision: ReviewDecision = { kind: "approved", reason: "LGTM" };
    expect(decision.kind).toBe("approved");
    expect(decision.reason).toBe("LGTM");
  });

  test("rejected variant requires reason", () => {
    const decision: ReviewDecision = {
      kind: "rejected",
      reason: "introduces a sandbox policy bypass",
    };
    expect(decision.kind).toBe("rejected");
    expect(decision.reason).toBe("introduces a sandbox policy bypass");
  });
});

// ---------------------------------------------------------------------------
// ProposalStatus variants
// ---------------------------------------------------------------------------

describe("ProposalStatus", () => {
  const base = {
    id: proposalId("prop-1"),
    submittedBy: agentId("agent-1"),
    changeTarget: "brick:sandboxed" as ChangeTarget,
    changeKind: "create" as ChangeKind,
    description: "forge a new search tool",
    submittedAt: 1_000_000,
  };

  test("pending status", () => {
    const proposal: Proposal = { ...base, status: "pending" };
    expect(proposal.status).toBe("pending");
  });

  test("approved status", () => {
    const proposal: Proposal = {
      ...base,
      status: "approved",
      reviewedAt: 2_000_000,
      reviewDecision: { kind: "approved" },
    };
    expect(proposal.status).toBe("approved");
  });

  test("rejected status", () => {
    const proposal: Proposal = {
      ...base,
      status: "rejected",
      reviewedAt: 2_000_000,
      reviewDecision: { kind: "rejected", reason: "unsafe implementation" },
    };
    expect(proposal.status).toBe("rejected");
  });

  test("superseded status with supersededBy field", () => {
    const proposal: Proposal = {
      ...base,
      status: "superseded",
      supersededBy: proposalId("prop-2"),
    };
    expect(proposal.status).toBe("superseded");
    expect(proposal.supersededBy).toBe(proposalId("prop-2"));
  });

  test("expired status", () => {
    const proposal: Proposal = {
      ...base,
      status: "expired",
      expiresAt: 500_000,
    };
    expect(proposal.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// ProposalEvent discriminated union
// ---------------------------------------------------------------------------

describe("ProposalEvent", () => {
  test("proposal:submitted event carries full proposal", () => {
    const proposal: Proposal = {
      id: proposalId("prop-1"),
      submittedBy: agentId("agent-1"),
      changeTarget: "l1_extension",
      changeKind: "extend",
      description: "add a new L1 guard",
      status: "pending",
      submittedAt: 1_000_000,
    };
    const event: ProposalEvent = { kind: "proposal:submitted", proposal };
    expect(event.kind).toBe("proposal:submitted");
    expect(event.proposal.id).toBe(proposalId("prop-1"));
  });

  test("proposal:reviewed event carries proposalId and decision", () => {
    const event: ProposalEvent = {
      kind: "proposal:reviewed",
      proposalId: proposalId("prop-1"),
      decision: { kind: "approved" },
    };
    expect(event.kind).toBe("proposal:reviewed");
    expect(event.decision.kind).toBe("approved");
  });

  test("proposal:expired event carries proposalId", () => {
    const event: ProposalEvent = {
      kind: "proposal:expired",
      proposalId: proposalId("prop-2"),
    };
    expect(event.kind).toBe("proposal:expired");
    expect(event.proposalId).toBe(proposalId("prop-2"));
  });

  test("proposal:superseded event carries both IDs", () => {
    const event: ProposalEvent = {
      kind: "proposal:superseded",
      proposalId: proposalId("prop-1"),
      supersededBy: proposalId("prop-3"),
    };
    expect(event.kind).toBe("proposal:superseded");
    expect(event.supersededBy).toBe(proposalId("prop-3"));
  });
});

// ---------------------------------------------------------------------------
// Proposal interface shape
// ---------------------------------------------------------------------------

describe("Proposal interface", () => {
  test("minimal proposal compiles (no optional fields)", () => {
    const proposal: Proposal = {
      id: proposalId("prop-min"),
      submittedBy: agentId("agent-1"),
      changeTarget: "bundle_l2",
      changeKind: "update",
      description: "shadow @koi/channel-telegram with patched version",
      status: "pending",
      submittedAt: Date.now(),
    };
    expect(proposal.brickRef).toBeUndefined();
    expect(proposal.expiresAt).toBeUndefined();
    expect(proposal.reviewedAt).toBeUndefined();
    expect(proposal.reviewDecision).toBeUndefined();
    expect(proposal.supersededBy).toBeUndefined();
    expect(proposal.metadata).toBeUndefined();
  });

  test("full proposal compiles with all fields set", () => {
    const proposal: Proposal = {
      id: proposalId("prop-full"),
      submittedBy: agentId("agent-2"),
      changeTarget: "l0_interface",
      changeKind: "extend",
      description: "add optional dispose() to EngineAdapter",
      brickRef: {
        id: brickId("sha256:abc001"),
        version: "1.0.0",
        kind: "tool",
      },
      status: "approved",
      submittedAt: 1_000_000,
      expiresAt: 9_999_999,
      reviewedAt: 2_000_000,
      reviewDecision: { kind: "approved", reason: "backward-compatible addition" },
      supersededBy: undefined,
      metadata: { jiraTicket: "KOI-223" },
    };
    expect(proposal.changeTarget).toBe("l0_interface");
    expect(proposal.reviewDecision?.kind).toBe("approved");
    expect(proposal.metadata?.jiraTicket).toBe("KOI-223");
  });

  test("supersededBy accepts a ProposalId", () => {
    const proposal: Proposal = {
      id: proposalId("prop-old"),
      submittedBy: agentId("agent-1"),
      changeTarget: "brick:promoted",
      changeKind: "create",
      description: "add audit middleware",
      status: "superseded",
      submittedAt: 1_000_000,
      supersededBy: proposalId("prop-new"),
    };
    expect(proposal.supersededBy).toBe(proposalId("prop-new"));
  });
});

// ---------------------------------------------------------------------------
// ProposalInput interface shape
// ---------------------------------------------------------------------------

describe("ProposalInput interface", () => {
  test("minimal input compiles (no optional fields)", () => {
    const input: ProposalInput = {
      submittedBy: agentId("agent-1"),
      changeTarget: "sandbox_policy",
      changeKind: "configure",
      description: "tighten network egress policy for forged tools",
    };
    expect(input.brickRef).toBeUndefined();
    expect(input.expiresAt).toBeUndefined();
    expect(input.metadata).toBeUndefined();
  });

  test("full input compiles with all fields set", () => {
    const input: ProposalInput = {
      submittedBy: agentId("agent-1"),
      changeTarget: "brick:sandboxed",
      changeKind: "create",
      description: "forge a calculator tool",
      brickRef: {
        id: brickId("sha256:def002"),
        version: "0.1.0",
        kind: "tool",
      },
      expiresAt: Date.now() + 86_400_000,
      metadata: { category: "math" },
    };
    expect(input.changeTarget).toBe("brick:sandboxed");
    expect(input.expiresAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ProposalGate interface conformance (follows ReputationBackend test pattern)
// ---------------------------------------------------------------------------

describe("ProposalGate interface", () => {
  test("type-compatible minimal implementation compiles", () => {
    const gate = {
      submit: (_input: ProposalInput): ProposalResult => ({
        ok: true as const,
        value: {
          id: proposalId("prop-stub"),
          submittedBy: agentId("agent-stub"),
          changeTarget: "brick:sandboxed" as ChangeTarget,
          changeKind: "create" as ChangeKind,
          description: "stub",
          status: "pending" as ProposalStatus,
          submittedAt: 0,
        },
      }),
      review: (_id: ProposalId, _decision: ReviewDecision): void => {
        // no-op stub
      },
      watch:
        (_handler: (event: ProposalEvent) => void | Promise<void>): ProposalUnsubscribe =>
        () => {
          // no-op unsubscribe
        },
    } satisfies ProposalGate;

    expect(typeof gate.submit).toBe("function");
    expect(typeof gate.review).toBe("function");
    expect(typeof gate.watch).toBe("function");
  });

  test("watch returns a callable unsubscribe function", () => {
    const gate: ProposalGate = {
      submit: (_input) => ({ ok: true as const, value: {} as Proposal }),
      review: (_id, _decision) => {},
      watch: (_handler) => {
        const unsubscribe: ProposalUnsubscribe = () => {};
        return unsubscribe;
      },
    };

    const unsubscribe = gate.watch(() => {});
    expect(typeof unsubscribe).toBe("function");
    // calling unsubscribe must not throw
    expect(() => unsubscribe()).not.toThrow();
  });

  test("submit can return a Promise (async implementation)", async () => {
    const gate: ProposalGate = {
      submit: async (_input): Promise<ProposalResult> => ({
        ok: false as const,
        error: {
          code: "VALIDATION",
          message: "changeTarget not allowed at depth 2+",
          retryable: false,
        },
      }),
      review: () => {},
      watch: () => () => {},
    };

    const result = await gate.submit({
      submittedBy: agentId("agent-1"),
      changeTarget: "l0_interface",
      changeKind: "extend",
      description: "test async gate",
    });
    expect(result.ok).toBe(false);
  });
});
