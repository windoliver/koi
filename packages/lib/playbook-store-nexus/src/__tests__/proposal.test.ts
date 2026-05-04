import { describe, expect, test } from "bun:test";

import type { PlaybookEvaluation, PlaybookProposal, TrajectoryRange } from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";

import { createNexusPlaybookProposalStore } from "../proposal.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const trajRange: TrajectoryRange = {
  sessionId: "sess-1",
  fromStepIndex: 0,
  toStepIndex: 4,
};

function makeProposal(id: string, playbookId: string): PlaybookProposal {
  return {
    id,
    playbookId,
    baseVersion: 1,
    operations: [{ kind: "add", section: "errors", content: "check before edit" }],
    sourceTrajectoryRange: trajRange,
    reflection: {
      rootCause: "missed precondition",
      keyInsight: "verify state first",
      bulletTags: [{ id: "b1", tag: "helpful" }],
    },
    createdAt: 100,
  };
}

function makeEvaluation(id: string, proposalId: string): PlaybookEvaluation {
  return {
    id,
    proposalId,
    verdict: "promote",
    metrics: { helpfulRate: 0.7, tokenDelta: 12 },
    notes: "passed thresholds",
    evaluatedAt: 200,
  };
}

function newStore() {
  return createNexusPlaybookProposalStore({ transport: createFakeNexusTransport() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusPlaybookProposalStore", () => {
  test("recordProposal → getProposal round-trip", async () => {
    const store = newStore();
    await store.recordProposal(makeProposal("p1", "pb-a"));
    const got = await store.getProposal("p1");
    expect(got?.id).toBe("p1");
    expect(got?.playbookId).toBe("pb-a");
    expect(got?.baseVersion).toBe(1);
  });

  test("getProposal returns undefined for missing", async () => {
    const store = newStore();
    expect(await store.getProposal("nope")).toBeUndefined();
  });

  test("listProposals returns proposals for given playbook only", async () => {
    const store = newStore();
    await store.recordProposal(makeProposal("p1", "pb-a"));
    await store.recordProposal(makeProposal("p2", "pb-a"));
    await store.recordProposal(makeProposal("p3", "pb-b"));
    const forA = await store.listProposals("pb-a");
    expect(forA.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    const forB = await store.listProposals("pb-b");
    expect(forB.map((p) => p.id)).toEqual(["p3"]);
  });

  test("listProposals for unknown playbook returns []", async () => {
    const store = newStore();
    const result = await store.listProposals("unknown-pb");
    expect(result).toEqual([]);
  });

  test("recordEvaluation persists alongside proposal", async () => {
    const store = newStore();
    await store.recordProposal(makeProposal("p1", "pb-a"));
    await expect(store.recordEvaluation(makeEvaluation("e1", "p1"))).resolves.toBeUndefined();
  });
});
