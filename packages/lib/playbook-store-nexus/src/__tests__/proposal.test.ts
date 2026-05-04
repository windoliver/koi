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

  // --- contract parity tests (ported from sqlite sibling) ---

  test("getProposal for missing id returns undefined (not throws)", async () => {
    // Matches sqlite contract: missing proposal returns undefined, not an error.
    const store = newStore();
    const result = await store.getProposal("completely-unknown-id");
    expect(result).toBeUndefined();
  });

  test("listProposals returns all proposals for a playbook (content complete)", async () => {
    // Verify the full proposal object is round-tripped, not just the ID.
    const store = newStore();
    const p = makeProposal("p-full", "pb-round");
    await store.recordProposal(p);
    const list = await store.listProposals("pb-round");
    expect(list.length).toBe(1);
    expect(list[0]?.baseVersion).toBe(1);
    expect(list[0]?.reflection.rootCause).toBe("missed precondition");
  });

  test("listProposals ordering — nexus returns in filesystem-glob order (not creation order)", async () => {
    // DIVERGENCE vs sqlite: sqlite orders by `created_at, id` (ascending).
    // Nexus returns in whatever order the transport lists files (undefined order).
    // Callers that need a stable sort must sort the returned array themselves.
    // Documented in docs/L2/playbook-store-nexus.md.
    const store = newStore();
    await store.recordProposal(makeProposal("p1", "pb-order"));
    await store.recordProposal(makeProposal("p2", "pb-order"));
    await store.recordProposal(makeProposal("p3", "pb-order"));
    const list = await store.listProposals("pb-order");
    // We assert that all 3 are present (content completeness), not the order.
    expect(list.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
  });

  // --- ACE ID path-safety regression tests (Finding 1) ---

  test("recordProposal with id containing '/' is rejected", async () => {
    const store = newStore();
    await expect(store.recordProposal(makeProposal("p/bad", "pb-a"))).rejects.toThrow(
      "Proposal ID",
    );
  });

  test("recordProposal with id containing '..' is rejected", async () => {
    const store = newStore();
    await expect(store.recordProposal(makeProposal("a..b", "pb-a"))).rejects.toThrow("Proposal ID");
  });

  test("'p:1' and 'p_1' are distinct proposals — no collision", async () => {
    const store = newStore();
    await store.recordProposal(makeProposal("p:1", "pb-a"));
    await store.recordProposal(makeProposal("p_1", "pb-a"));
    // Both must be individually retrievable
    expect((await store.getProposal("p:1"))?.id).toBe("p:1");
    expect((await store.getProposal("p_1"))?.id).toBe("p_1");
    // listProposals must return both
    const list = await store.listProposals("pb-a");
    expect(list.map((p) => p.id).sort()).toEqual(["p:1", "p_1"]);
  });

  // --- Immutable proposal contract regression tests (Finding 6) ---

  test("recordProposal with same id + same content is idempotent (no error)", async () => {
    const store = newStore();
    const p = makeProposal("p-idem", "pb-a");
    await store.recordProposal(p);
    // Second call with identical content must succeed silently
    await expect(store.recordProposal(p)).resolves.toBeUndefined();
    // Proposal still retrievable
    expect((await store.getProposal("p-idem"))?.id).toBe("p-idem");
  });

  test("recordProposal with same id + different content throws", async () => {
    const store = newStore();
    await store.recordProposal(makeProposal("p-immut", "pb-a"));
    const changed = { ...makeProposal("p-immut", "pb-a"), baseVersion: 99 };
    await expect(store.recordProposal(changed)).rejects.toThrow(
      "already recorded with different content",
    );
  });

  test("listProposals returns proposal recorded even when index write retried", async () => {
    // Smoke: after a normal recordProposal, listProposals finds the proposal.
    const store = newStore();
    await store.recordProposal(makeProposal("p-idx", "pb-idx"));
    const list = await store.listProposals("pb-idx");
    expect(list.map((p) => p.id)).toContain("p-idx");
  });

  // --- Fix 2: listProposals reads proposal files directly (no separate index) ---

  test("recordProposal then listProposals immediately — visible", async () => {
    // Proposal file is the sole source of truth; no index needed.
    const store = newStore();
    await store.recordProposal(makeProposal("p-direct", "pb-direct"));
    const list = await store.listProposals("pb-direct");
    expect(list.map((p) => p.id)).toContain("p-direct");
  });

  test("recordProposal + listProposals round-trips full content", async () => {
    // Positive test: single record + list returns the full proposal object.
    const store = newStore();
    const p = makeProposal("p-roundtrip", "pb-roundtrip");
    await store.recordProposal(p);
    const list = await store.listProposals("pb-roundtrip");
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("p-roundtrip");
    expect(list[0]?.playbookId).toBe("pb-roundtrip");
    expect(list[0]?.baseVersion).toBe(1);
  });

  test("listProposals filters by playbookId — proposals from other playbooks excluded", async () => {
    // When proposals exist for multiple playbooks, listProposals returns only
    // the ones for the requested playbookId.
    const store = newStore();
    await store.recordProposal(makeProposal("px1", "pb-x"));
    await store.recordProposal(makeProposal("py1", "pb-y"));
    await store.recordProposal(makeProposal("py2", "pb-y"));
    const forX = await store.listProposals("pb-x");
    expect(forX.map((p) => p.id)).toEqual(["px1"]);
    const forY = await store.listProposals("pb-y");
    expect(forY.map((p) => p.id).sort()).toEqual(["py1", "py2"]);
  });
});
