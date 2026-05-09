/**
 * Adapter-integration tests for the promotion gate (#1715).
 *
 * Unlike promotion-gate.test.ts (permissive in-memory mocks), these tests
 * wire the gate through real proposal/structured stores — both sqlite and
 * Nexus over a fake transport — to exercise FK constraints, etag CAS,
 * monotonic version checks, and audit-first crash recovery on the real
 * adapter contracts.
 */

import { describe, expect, test } from "bun:test";

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PromotionThresholds,
  StructuredPlaybook,
  StructuredPlaybookStore,
} from "@koi/ace-types";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import {
  createNexusPlaybookProposalStore,
  createNexusStructuredPlaybookStore,
} from "@koi/playbook-store-nexus";
import { createSqlitePlaybookStore } from "@koi/playbook-store-sqlite";

import { commitPromotion, rollbackPromotion } from "../promotion-gate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAYBOOK_ID = "spb-pg";
const PROPOSAL_ID = "p-pg";
const EVAL_ID = "e-pg";

const thresholds: PromotionThresholds = {
  minHelpfulRate: 0.5,
  maxHarmfulRate: 0.5,
  minTrials: 1,
};

function structuredPlaybook(overrides: Partial<StructuredPlaybook> = {}): StructuredPlaybook {
  return {
    id: PLAYBOOK_ID,
    title: "v",
    sections: [
      {
        name: "Existing",
        slug: "existing",
        bullets: [
          {
            id: "b1",
            content: "first",
            helpful: 1,
            harmful: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
    ],
    tags: [],
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 0,
    version: 1,
    ...overrides,
  };
}

function proposal(overrides: Partial<PlaybookProposal> = {}): PlaybookProposal {
  return {
    id: PROPOSAL_ID,
    playbookId: PLAYBOOK_ID,
    baseVersion: 1,
    operations: [{ kind: "add", section: "Existing", content: "newly promoted insight" }],
    sourceTrajectoryRange: { sessionId: "sess", fromStepIndex: 0, toStepIndex: 1 },
    reflection: { rootCause: "rc", keyInsight: "ki", bulletTags: [] },
    createdAt: 0,
    ...overrides,
  };
}

function evaluation(overrides: Partial<PlaybookEvaluation> = {}): PlaybookEvaluation {
  return {
    id: EVAL_ID,
    proposalId: PROPOSAL_ID,
    verdict: "promote",
    metrics: { helpfulRate: 0.9, harmfulRate: 0.0, trials: 5 },
    evaluatedAt: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Adapter fixtures: each test runs against both sqlite and nexus
// ---------------------------------------------------------------------------

interface AdapterCtx {
  readonly structuredStore: StructuredPlaybookStore;
  readonly proposalStore: PlaybookProposalStore;
  readonly cleanup?: () => void;
}

function makeSqlite(): AdapterCtx {
  const store = createSqlitePlaybookStore({ path: ":memory:" });
  return {
    structuredStore: store.structuredPlaybooks,
    proposalStore: store.proposals,
    cleanup: () => store.close(),
  };
}

function makeNexus(): AdapterCtx {
  const transport = createFakeNexusTransport();
  return {
    structuredStore: createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-it",
      requirePreProvisioned: false,
    }),
    proposalStore: createNexusPlaybookProposalStore({ transport, basePath: "ace-it" }),
  };
}

const adapters: ReadonlyArray<readonly [string, () => AdapterCtx]> = [
  ["sqlite", makeSqlite],
  ["nexus", makeNexus],
];

// ---------------------------------------------------------------------------
// Cross-adapter parity tests (run against sqlite + nexus)
// ---------------------------------------------------------------------------

describe.each(adapters)("promotion-gate integration: %s", (label, mk) => {
  test("commitPromotion: happy path advances head, records proposal+evaluation", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      // Real adapters: the proposal must be persisted before evaluation runs.
      await ctx.proposalStore.recordProposal(proposal());

      const decision = await commitPromotion(ctx, proposal(), evaluation(), thresholds);

      expect(decision.outcome).toBe("promoted");
      expect(decision.fromVersion).toBe(1);
      expect(decision.toVersion).toBe(2);

      const head = await ctx.structuredStore.get(PLAYBOOK_ID);
      expect(head?.version).toBe(2);
      expect(head?.provenance?.proposalId).toBe(PROPOSAL_ID);
      expect(head?.provenance?.evaluationId).toBe(EVAL_ID);

      // Evaluation persisted; proposal persisted.
      const persistedProposal = await ctx.proposalStore.getProposal(PROPOSAL_ID);
      expect(persistedProposal?.id).toBe(PROPOSAL_ID);
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion: advances lastReflectedStepIndex watermark on promote", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      await ctx.proposalStore.recordProposal(proposal());

      await commitPromotion(ctx, proposal(), evaluation(), thresholds);

      const head = await ctx.structuredStore.get(PLAYBOOK_ID);
      // Watermark advances to the trajectory window's toStepIndex so a
      // restart cannot re-reflect the same window and re-promote.
      expect(head?.lastReflectedStepIndex).toBe(1);
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion: watermark is monotonic across successive commits", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      await ctx.proposalStore.recordProposal(proposal());
      await commitPromotion(ctx, proposal(), evaluation(), thresholds);

      // Second commit with a HIGHER watermark — must advance.
      const p2 = proposal({
        id: "p-second",
        baseVersion: 2,
        sourceTrajectoryRange: { sessionId: "sess", fromStepIndex: 1, toStepIndex: 5 },
      });
      const e2 = evaluation({ id: "e-second", proposalId: "p-second" });
      await ctx.proposalStore.recordProposal(p2);
      await commitPromotion(ctx, p2, e2, thresholds);
      expect((await ctx.structuredStore.get(PLAYBOOK_ID))?.lastReflectedStepIndex).toBe(5);

      // Third commit with a LOWER watermark — must NOT regress.
      const p3 = proposal({
        id: "p-third",
        baseVersion: 3,
        sourceTrajectoryRange: { sessionId: "sess", fromStepIndex: 0, toStepIndex: 2 },
      });
      const e3 = evaluation({ id: "e-third", proposalId: "p-third" });
      await ctx.proposalStore.recordProposal(p3);
      await commitPromotion(ctx, p3, e3, thresholds);
      expect((await ctx.structuredStore.get(PLAYBOOK_ID))?.lastReflectedStepIndex).toBe(5);
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion: idempotent retry returns prior success when head provenance matches", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      await ctx.proposalStore.recordProposal(proposal());
      await commitPromotion(ctx, proposal(), evaluation(), thresholds);

      // Retry with byte-identical payload: head already at v2 with our
      // provenance. Must return the prior success, not throw.
      const retry = await commitPromotion(ctx, proposal(), evaluation(), thresholds);
      expect(retry.outcome).toBe("promoted");
      expect(retry.toVersion).toBe(2);

      const head = await ctx.structuredStore.get(PLAYBOOK_ID);
      expect(head?.version).toBe(2);
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion: indeterminate retry throws when head superseded by another commit", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      await ctx.proposalStore.recordProposal(proposal());
      await commitPromotion(ctx, proposal(), evaluation(), thresholds);

      // Simulate another caller advancing the head to v3 with a different
      // proposal/evaluation, leaving our provenance no longer named on head.
      const otherProposal = proposal({
        id: "p-other",
        baseVersion: 2,
        operations: [{ kind: "add", section: "Existing", content: "another insight" }],
      });
      const otherEval = evaluation({ id: "e-other", proposalId: "p-other" });
      await ctx.proposalStore.recordProposal(otherProposal);
      const second = await commitPromotion(ctx, otherProposal, otherEval, thresholds);
      expect(second.toVersion).toBe(3);

      // Now the original caller retries — head moved past, original
      // provenance not named. Must throw "indeterminate retry", not
      // misclassify as fresh failure.
      await expect(commitPromotion(ctx, proposal(), evaluation(), thresholds)).rejects.toThrow(
        /indeterminate retry/i,
      );
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion: rollback verdict fails closed (must use rollbackPromotion)", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      await ctx.proposalStore.recordProposal(proposal());
      await expect(
        commitPromotion(ctx, proposal(), evaluation({ verdict: "rollback" }), thresholds),
      ).rejects.toThrow(/rollback verdict.*rollbackPromotion/i);
      // Head unchanged.
      const head = await ctx.structuredStore.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion reject path: stale base + proposal pre-recorded → audit lands", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      // Pre-record proposal at v1.
      await ctx.proposalStore.recordProposal(proposal());

      // Concurrently another commit advances head to v2.
      const otherProposal = proposal({
        id: "p-other",
        baseVersion: 1,
        operations: [{ kind: "prune", bulletId: "b1" }],
      });
      const otherEval = evaluation({ id: "e-other", proposalId: "p-other" });
      await ctx.proposalStore.recordProposal(otherProposal);
      await commitPromotion(ctx, otherProposal, otherEval, thresholds);

      // Now original caller's evaluation comes back with verdict="reject".
      // Audit must land even though current.version (2) !== baseVersion (1).
      const decision = await commitPromotion(
        ctx,
        proposal(),
        evaluation({ verdict: "reject" }),
        thresholds,
      );
      expect(decision.outcome).toBe("rejected");
      expect(decision.fromVersion).toBe(2);
      expect(decision.toVersion).toBe(2);
    } finally {
      ctx.cleanup?.();
    }
  });

  test("commitPromotion reject path: stale base + proposal NOT pre-recorded → precondition error", async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));

      // Another commit advances head to v2; the original proposal was never
      // durably stored.
      const otherProposal = proposal({
        id: "p-other",
        baseVersion: 1,
        operations: [{ kind: "prune", bulletId: "b1" }],
      });
      const otherEval = evaluation({ id: "e-other", proposalId: "p-other" });
      await ctx.proposalStore.recordProposal(otherProposal);
      await commitPromotion(ctx, otherProposal, otherEval, thresholds);

      // Reject path with a stale-AND-never-recorded proposal must surface a
      // clear precondition error, not an opaque baseVersion FK violation.
      await expect(
        commitPromotion(ctx, proposal(), evaluation({ verdict: "reject" }), thresholds),
      ).rejects.toThrow(/never durably stored|pre-record proposals before evaluation/i);
    } finally {
      ctx.cleanup?.();
    }
  });

  test(`rollbackPromotion: ${label} respects lineageSupported capability`, async () => {
    const ctx = mk();
    try {
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      await ctx.proposalStore.recordProposal(proposal());
      await commitPromotion(ctx, proposal(), evaluation(), thresholds);

      // Build a rollback proposal/evaluation against the current head v2,
      // targeting v1.
      const rbProposal = proposal({
        id: "p-rb",
        baseVersion: 2,
        operations: [],
      });
      const rbEval = evaluation({ id: "e-rb", proposalId: "p-rb", verdict: "rollback" });
      await ctx.proposalStore.recordProposal(rbProposal);

      if (label === "nexus") {
        // Nexus has lineageSupported === false: rollback fails closed at the
        // capability boundary instead of a misleading version-not-found.
        await expect(rollbackPromotion(ctx, rbProposal, 1, rbEval)).rejects.toThrow(
          /lineage support/i,
        );
      } else {
        // sqlite has lineageSupported === true: rollback restores v1 as v3.
        const decision = await rollbackPromotion(ctx, rbProposal, 1, rbEval);
        expect(decision.outcome).toBe("rolled_back");
        expect(decision.toVersion).toBe(3);
        const head = await ctx.structuredStore.get(PLAYBOOK_ID);
        expect(head?.version).toBe(3);
      }
    } finally {
      ctx.cleanup?.();
    }
  });

  test(`rollbackPromotion: ${label} advances watermark monotonically`, async () => {
    const ctx = mk();
    try {
      if (label === "nexus") return; // lineage unsupported on this adapter
      await ctx.structuredStore.save(structuredPlaybook({ version: 1 }));
      // Promote with a high watermark so rollback must NOT regress it.
      const p1 = proposal({
        sourceTrajectoryRange: { sessionId: "sess", fromStepIndex: 0, toStepIndex: 7 },
      });
      await ctx.proposalStore.recordProposal(p1);
      await commitPromotion(ctx, p1, evaluation(), thresholds);
      expect((await ctx.structuredStore.get(PLAYBOOK_ID))?.lastReflectedStepIndex).toBe(7);

      // Rollback with a lower toStepIndex — must keep watermark at 7
      // (monotonic) AND advance to its own toStepIndex if it were higher.
      const rbProposal = proposal({
        id: "p-rb",
        baseVersion: 2,
        operations: [],
        sourceTrajectoryRange: { sessionId: "sess", fromStepIndex: 0, toStepIndex: 3 },
      });
      const rbEval = evaluation({ id: "e-rb", proposalId: "p-rb", verdict: "rollback" });
      await ctx.proposalStore.recordProposal(rbProposal);
      await rollbackPromotion(ctx, rbProposal, 1, rbEval);
      const head = await ctx.structuredStore.get(PLAYBOOK_ID);
      expect(head?.lastReflectedStepIndex).toBe(7);
    } finally {
      ctx.cleanup?.();
    }
  });
});

// ---------------------------------------------------------------------------
// Nexus-specific: etag CAS, monotonic, divergent content, degraded head
// ---------------------------------------------------------------------------

describe("nexus structured store: corner cases", () => {
  test("concurrent save() at same version — exactly one wins via etag CAS", async () => {
    const transport = createFakeNexusTransport();
    const store = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-conc",
      requirePreProvisioned: false,
    });

    // Bootstrap v1 so both racers see the same etag.
    await store.save(structuredPlaybook({ id: "race", version: 1 }));

    // Two store instances over the SAME transport (shared file map) racing
    // both attempt to advance v1 -> v2 with different content. Server-side
    // if_match etag must reject one with CONFLICT.
    const storeA = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-conc",
      requirePreProvisioned: false,
    });
    const storeB = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-conc",
      requirePreProvisioned: false,
    });

    const [resA, resB] = await Promise.allSettled([
      storeA.save(structuredPlaybook({ id: "race", version: 2, title: "A" })),
      storeB.save(structuredPlaybook({ id: "race", version: 2, title: "B" })),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");
    // In-process lock serializes them; both must NOT silently overwrite.
    // Either both see same-version-divergent-content rejection on second,
    // or one wins and the other gets a CAS conflict / divergent error.
    expect(fulfilled.length + rejected.length).toBe(2);
    if (fulfilled.length === 2) {
      // Both succeeded — must mean second was idempotent (same content),
      // not divergent. But we used different titles, so this should not
      // happen with the new contract. Fail the test.
      throw new Error("expected at least one writer to be rejected, both succeeded");
    }
  });

  test("below-head save rejected (monotonic version check)", async () => {
    const transport = createFakeNexusTransport();
    const store = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-mono",
      requirePreProvisioned: false,
    });
    await store.save(structuredPlaybook({ id: "m", version: 2 }));
    await expect(store.save(structuredPlaybook({ id: "m", version: 1 }))).rejects.toThrow(
      /below current version/i,
    );
  });

  test("same-version idempotent re-save with REORDERED keys is accepted (canonical JSON)", async () => {
    const transport = createFakeNexusTransport();
    const store = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-canon",
      requirePreProvisioned: false,
    });

    const original = structuredPlaybook({ id: "k", version: 1 });
    await store.save(original);

    // Same content, different key order on the top level. Canonical-JSON
    // comparison must treat this as identical, not divergent.
    const reordered: StructuredPlaybook = {
      version: 1,
      sessionCount: 0,
      updatedAt: 0,
      createdAt: 0,
      source: "curated",
      tags: [],
      sections: original.sections,
      title: "v",
      id: "k",
    };
    await expect(store.save(reordered)).resolves.toBeUndefined();
  });

  test("same-version DIVERGENT content rejected (canonical JSON)", async () => {
    const transport = createFakeNexusTransport();
    const store = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-div",
      requirePreProvisioned: false,
    });
    await store.save(structuredPlaybook({ id: "d", version: 1, title: "A" }));
    await expect(
      store.save(structuredPlaybook({ id: "d", version: 1, title: "B" })),
    ).rejects.toThrow(/divergent content/i);
  });

  test("degraded head (read returns empty content) — refuses to overwrite", async () => {
    const baseTransport = createFakeNexusTransport();
    // Pre-write a structured playbook through the base transport.
    const seedStore = createNexusStructuredPlaybookStore({
      transport: baseTransport,
      basePath: "ace-deg",
      requirePreProvisioned: false,
    });
    await seedStore.save(structuredPlaybook({ id: "deg", version: 1 }));

    // Wrap transport: intercept the read for our path and return an empty
    // content envelope (simulates corruption / protocol shift).
    const wrapped = {
      ...baseTransport,
      call: async <T>(method: string, params: Record<string, unknown>) => {
        if (method === "read" && typeof params.path === "string" && params.path.includes("/deg.")) {
          return {
            ok: true as const,
            value: { content: "", metadata: { etag: "stale" } } as T,
          };
        }
        return baseTransport.call<T>(method, params);
      },
    };

    const wrappedStore = createNexusStructuredPlaybookStore({
      transport: wrapped,
      basePath: "ace-deg",
      requirePreProvisioned: false,
    });
    await expect(
      wrappedStore.save(structuredPlaybook({ id: "deg", version: 2, title: "v2" })),
    ).rejects.toThrow(/empty\/non-string content|degraded head/i);
  });

  test("initial-create race (no etag) — DOCUMENTED LIMIT: both writers can succeed", async () => {
    // This documents the known cross-process create race (no if_none_match
    // support on the transport). When both writers race on a missing path,
    // both writes succeed — the loser is lost. Fix requires backend
    // create-if-absent semantics. Distributed deployments must funnel
    // initial creation through a single coordinator.
    const transport = createFakeNexusTransport();
    const storeA = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-init",
      requirePreProvisioned: false,
    });
    const storeB = createNexusStructuredPlaybookStore({
      transport,
      basePath: "ace-init",
      requirePreProvisioned: false,
    });

    const [resA, resB] = await Promise.allSettled([
      storeA.save(structuredPlaybook({ id: "init", version: 1, title: "A" })),
      storeB.save(structuredPlaybook({ id: "init", version: 1, title: "B" })),
    ]);

    // In-process lock makes this deterministic in a single process: the
    // second writer sees the first's content as current at version 1 and
    // rejects with divergent-content. Across processes (no shared lock),
    // both would succeed — that is the documented limitation.
    const allFulfilled = resA.status === "fulfilled" && resB.status === "fulfilled";
    const oneRejected =
      (resA.status === "fulfilled" && resB.status === "rejected") ||
      (resA.status === "rejected" && resB.status === "fulfilled");
    expect(allFulfilled || oneRejected).toBe(true);
  });
});
