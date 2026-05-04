import { describe, expect, test } from "bun:test";

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  StructuredPlaybook,
  TrajectoryRange,
} from "@koi/ace-types";
import type { KoiError, Result } from "@koi/core";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import type { NexusTransport } from "@koi/nexus-client";

import { createNexusPlaybookProposalStore } from "../proposal.js";
import { createNexusStructuredPlaybookStore } from "../structured.js";

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

function makeStructuredPlaybook(id: string, version: number): StructuredPlaybook {
  return {
    id,
    title: "Test Playbook",
    sections: [],
    tags: [],
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 0,
    version,
  };
}

function makeProposalWithBase(
  id: string,
  playbookId: string,
  baseVersion: number,
): PlaybookProposal {
  return {
    ...makeProposal(id, playbookId),
    baseVersion,
  };
}

/**
 * Creates a fresh store pair (proposal + structured) sharing the same transport.
 * Returns both so tests can pre-save structured playbooks as needed.
 */
function newStores() {
  const transport = createFakeNexusTransport();
  const proposal = createNexusPlaybookProposalStore({ transport });
  const structured = createNexusStructuredPlaybookStore({ transport });
  return { proposal, structured };
}

/**
 * Convenience: create stores AND pre-save a structured playbook with version 1
 * for playbookId. Returns the proposal store for immediate use.
 */
async function storeWithPlaybook(playbookId: string, version = 1) {
  const { proposal, structured } = newStores();
  await structured.save(makeStructuredPlaybook(playbookId, version));
  return { proposal, structured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusPlaybookProposalStore", () => {
  test("recordProposal → getProposal round-trip", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-a");
    await store.recordProposal(makeProposal("p1", "pb-a"));
    const got = await store.getProposal("p1");
    expect(got?.id).toBe("p1");
    expect(got?.playbookId).toBe("pb-a");
    expect(got?.baseVersion).toBe(1);
  });

  test("getProposal returns undefined for missing", async () => {
    const { proposal: store } = newStores();
    expect(await store.getProposal("nope")).toBeUndefined();
  });

  test("listProposals returns proposals for given playbook only", async () => {
    const { proposal: store, structured } = newStores();
    await structured.save(makeStructuredPlaybook("pb-a", 1));
    await structured.save(makeStructuredPlaybook("pb-b", 1));
    await store.recordProposal(makeProposal("p1", "pb-a"));
    await store.recordProposal(makeProposal("p2", "pb-a"));
    await store.recordProposal(makeProposal("p3", "pb-b"));
    const forA = await store.listProposals("pb-a");
    expect(forA.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    const forB = await store.listProposals("pb-b");
    expect(forB.map((p) => p.id)).toEqual(["p3"]);
  });

  test("listProposals for unknown playbook returns []", async () => {
    const { proposal: store } = newStores();
    const result = await store.listProposals("unknown-pb");
    expect(result).toEqual([]);
  });

  test("recordEvaluation persists alongside proposal", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-a");
    await store.recordProposal(makeProposal("p1", "pb-a"));
    await expect(store.recordEvaluation(makeEvaluation("e1", "p1"))).resolves.toBeUndefined();
  });

  // --- contract parity tests (ported from sqlite sibling) ---

  test("getProposal for missing id returns undefined (not throws)", async () => {
    // Matches sqlite contract: missing proposal returns undefined, not an error.
    const { proposal: store } = newStores();
    const result = await store.getProposal("completely-unknown-id");
    expect(result).toBeUndefined();
  });

  test("listProposals returns all proposals for a playbook (content complete)", async () => {
    // Verify the full proposal object is round-tripped, not just the ID.
    const { proposal: store } = await storeWithPlaybook("pb-round");
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
    const { proposal: store } = await storeWithPlaybook("pb-order");
    await store.recordProposal(makeProposal("p1", "pb-order"));
    await store.recordProposal(makeProposal("p2", "pb-order"));
    await store.recordProposal(makeProposal("p3", "pb-order"));
    const list = await store.listProposals("pb-order");
    // We assert that all 3 are present (content completeness), not the order.
    expect(list.map((p) => p.id).sort()).toEqual(["p1", "p2", "p3"]);
  });

  // --- ACE ID path-safety regression tests (Finding 1) ---

  test("recordProposal with id containing '/' is rejected", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-a");
    await expect(store.recordProposal(makeProposal("p/bad", "pb-a"))).rejects.toThrow(
      "Proposal ID",
    );
  });

  test("recordProposal with id containing '..' is rejected", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-a");
    await expect(store.recordProposal(makeProposal("a..b", "pb-a"))).rejects.toThrow("Proposal ID");
  });

  test("'p:1' and 'p_1' are distinct proposals — no collision", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-a");
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
    const { proposal: store } = await storeWithPlaybook("pb-a");
    const p = makeProposal("p-idem", "pb-a");
    await store.recordProposal(p);
    // Second call with identical content must succeed silently
    await expect(store.recordProposal(p)).resolves.toBeUndefined();
    // Proposal still retrievable
    expect((await store.getProposal("p-idem"))?.id).toBe("p-idem");
  });

  test("recordProposal with same id + different content throws", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-a");
    await store.recordProposal(makeProposal("p-immut", "pb-a"));
    // Changing baseVersion to 1 (already saved version) but alter another field
    const changed = {
      ...makeProposal("p-immut", "pb-a"),
      reflection: { ...makeProposal("p-immut", "pb-a").reflection, rootCause: "different" },
    };
    await expect(store.recordProposal(changed)).rejects.toThrow(
      "already recorded with different content",
    );
  });

  test("listProposals returns proposal recorded even when index write retried", async () => {
    // Smoke: after a normal recordProposal, listProposals finds the proposal.
    const { proposal: store } = await storeWithPlaybook("pb-idx");
    await store.recordProposal(makeProposal("p-idx", "pb-idx"));
    const list = await store.listProposals("pb-idx");
    expect(list.map((p) => p.id)).toContain("p-idx");
  });

  // --- Fix 2: listProposals reads proposal files directly (no separate index) ---

  test("recordProposal then listProposals immediately — visible", async () => {
    // Proposal file is the sole source of truth; no index needed.
    const { proposal: store } = await storeWithPlaybook("pb-direct");
    await store.recordProposal(makeProposal("p-direct", "pb-direct"));
    const list = await store.listProposals("pb-direct");
    expect(list.map((p) => p.id)).toContain("p-direct");
  });

  test("recordProposal + listProposals round-trips full content", async () => {
    // Positive test: single record + list returns the full proposal object.
    const { proposal: store } = await storeWithPlaybook("pb-roundtrip");
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
    const { proposal: store, structured } = newStores();
    await structured.save(makeStructuredPlaybook("pb-x", 1));
    await structured.save(makeStructuredPlaybook("pb-y", 1));
    await store.recordProposal(makeProposal("px1", "pb-x"));
    await store.recordProposal(makeProposal("py1", "pb-y"));
    await store.recordProposal(makeProposal("py2", "pb-y"));
    const forX = await store.listProposals("pb-x");
    expect(forX.map((p) => p.id)).toEqual(["px1"]);
    const forY = await store.listProposals("pb-y");
    expect(forY.map((p) => p.id).sort()).toEqual(["py1", "py2"]);
  });

  // --- Fix 4: immutable evaluation audit + require proposal exists ---

  test("recordEvaluation twice with same proposalId + same content is idempotent", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-eval");
    await store.recordProposal(makeProposal("p-eval-idem", "pb-eval"));
    const e = makeEvaluation("e-idem", "p-eval-idem");
    await store.recordEvaluation(e);
    // Second call with identical content must succeed silently
    await expect(store.recordEvaluation(e)).resolves.toBeUndefined();
  });

  test("recordEvaluation twice with same proposalId + different verdict throws", async () => {
    const { proposal: store } = await storeWithPlaybook("pb-eval");
    await store.recordProposal(makeProposal("p-eval-conflict", "pb-eval"));
    await store.recordEvaluation(makeEvaluation("e-conflict", "p-eval-conflict"));
    const changed = {
      ...makeEvaluation("e-conflict", "p-eval-conflict"),
      verdict: "reject" as const,
    };
    await expect(store.recordEvaluation(changed)).rejects.toThrow(
      "already recorded with different content",
    );
  });

  test("recordEvaluation for nonexistent proposal throws", async () => {
    const { proposal: store } = newStores();
    await expect(
      store.recordEvaluation(makeEvaluation("e-orphan", "p-nonexistent")),
    ).rejects.toThrow("not found");
  });

  // --- Fix 3: stale baseVersion rejection ---

  test("recordProposal with matching baseVersion succeeds", async () => {
    const transport = createFakeNexusTransport();
    const spbStore = createNexusStructuredPlaybookStore({ transport });
    const proposalStore = createNexusPlaybookProposalStore({ transport });
    await spbStore.save(makeStructuredPlaybook("pb-ver5", 5));
    // baseVersion=5 matches saved version=5 → should succeed
    await expect(
      proposalStore.recordProposal(makeProposalWithBase("p-v5", "pb-ver5", 5)),
    ).resolves.toBeUndefined();
  });

  test("recordProposal with stale baseVersion throws containing 'version'", async () => {
    const transport = createFakeNexusTransport();
    const spbStore = createNexusStructuredPlaybookStore({ transport });
    const proposalStore = createNexusPlaybookProposalStore({ transport });
    await spbStore.save(makeStructuredPlaybook("pb-stale", 5));
    // baseVersion=4 is stale vs current version=5 → must throw
    await expect(
      proposalStore.recordProposal(makeProposalWithBase("p-stale", "pb-stale", 4)),
    ).rejects.toThrow("version");
  });

  // Fix 2 regression: absent structured playbook must now be rejected (not silently accepted)
  test("recordProposal against never-saved structured playbook throws", async () => {
    // sqlite sibling rejects this case; nexus now matches that behaviour.
    const { proposal: store } = newStores();
    await expect(
      store.recordProposal(makeProposalWithBase("p-fresh", "pb-fresh", 0)),
    ).rejects.toThrow("does not exist");
  });

  // --- Fix 1: per-id in-process mutex closes same-process audit race ---

  test("concurrent recordProposal for same id + same content is idempotent (both resolve)", async () => {
    // Two concurrent calls with identical content must both succeed.
    const { proposal: store } = await storeWithPlaybook("pb-conc");
    const p = makeProposal("p-conc-same", "pb-conc");
    await expect(
      Promise.all([store.recordProposal(p), store.recordProposal(p)]),
    ).resolves.toBeDefined();
    expect((await store.getProposal("p-conc-same"))?.id).toBe("p-conc-same");
  });

  test("concurrent recordProposal for same id + different content — second rejects", async () => {
    // Two concurrent calls with different content: the second to acquire the lock
    // must see the already-written record and throw immutability error.
    const { proposal: store } = await storeWithPlaybook("pb-conc2");
    const p1 = makeProposal("p-race", "pb-conc2");
    const p2 = {
      ...makeProposal("p-race", "pb-conc2"),
      reflection: { ...makeProposal("p-race", "pb-conc2").reflection, rootCause: "different" },
    };
    const results = await Promise.allSettled([store.recordProposal(p1), store.recordProposal(p2)]);
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    // Exactly one must succeed and one must be rejected with immutability error
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const err = rejected[0];
    if (err?.status === "rejected") {
      expect(String(err.reason)).toContain("already recorded with different content");
    }
  });

  test("concurrent recordEvaluation for same proposalId + different content — second rejects", async () => {
    // Same invariant for evaluations: concurrent conflicting writes → one wins, one throws.
    const { proposal: store } = await storeWithPlaybook("pb-eval-conc");
    await store.recordProposal(makeProposal("p-eval-race", "pb-eval-conc"));
    const e1 = makeEvaluation("e-race", "p-eval-race");
    const e2 = { ...makeEvaluation("e-race", "p-eval-race"), verdict: "reject" as const };
    const results = await Promise.allSettled([
      store.recordEvaluation(e1),
      store.recordEvaluation(e2),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const err = rejected[0];
    if (err?.status === "rejected") {
      expect(String(err.reason)).toContain("already recorded with different content");
    }
  });

  // --- Fix 3: listProposals propagates non-NOT_FOUND errors ---

  test("listProposals propagates EXTERNAL error from proposal file read", async () => {
    // Scenario: proposal is written normally, then a transport wrapper injects
    // EXTERNAL on the read call during listProposals. The loop must throw.
    const baseTransport = createFakeNexusTransport();
    const spbStore = createNexusStructuredPlaybookStore({ transport: baseTransport });
    const proposalStoreBase = createNexusPlaybookProposalStore({ transport: baseTransport });
    await spbStore.save(makeStructuredPlaybook("pb-lp-err", 1));
    await proposalStoreBase.recordProposal(makeProposal("p-lp-err", "pb-lp-err"));

    // Wrap the transport so that reads of proposal files return EXTERNAL.
    // We allow list and the structured-playbook reads (which don't match proposals/).
    let listCallDone = false;
    const wrappedTransport: NexusTransport = {
      call: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        const path = params.path as string | undefined;
        // Fail reads of proposal files with EXTERNAL after the list is done.
        if (
          listCallDone &&
          method === "read" &&
          typeof path === "string" &&
          path.includes("/proposals/")
        ) {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "simulated backend failure", retryable: true },
          } as Result<T, KoiError>;
        }
        if (method === "list") listCallDone = true;
        return baseTransport.call<T>(method, params);
      },
      subscribe: baseTransport.subscribe.bind(baseTransport),
      submitAuthCode: baseTransport.submitAuthCode.bind(baseTransport),
      close: baseTransport.close.bind(baseTransport),
    };

    const proposalStoreWrapped = createNexusPlaybookProposalStore({ transport: wrappedTransport });
    await expect(proposalStoreWrapped.listProposals("pb-lp-err")).rejects.toThrow(
      "simulated backend failure",
    );
  });
});
