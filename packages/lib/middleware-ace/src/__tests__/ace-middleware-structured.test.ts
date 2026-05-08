/**
 * ACE middleware × promotion gate wiring (#1715).
 *
 * Drives onSessionEnd → reflector → curator → evaluator → commitPromotion
 * end-to-end through the real sqlite stores. No LLM required: stub
 * reflector/curator/evaluator carry deterministic outputs so the test
 * exercises the wiring, not model behavior.
 */

import { describe, expect, test } from "bun:test";

import type {
  CuratorOperation,
  PlaybookEvaluation,
  PromotionThresholds,
  ReflectionResult,
  StructuredPlaybook,
} from "@koi/ace-types";
import type { SessionContext, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createSqlitePlaybookStore } from "@koi/playbook-store-sqlite";

import {
  type CuratorFn,
  createAceMiddleware,
  type EvaluatorFn,
  type ReflectorFn,
} from "../ace-middleware.js";

const PLAYBOOK_ID = "spb-acemw";

const thresholds: PromotionThresholds = {
  minHelpfulRate: 0.5,
  maxHarmfulRate: 0.5,
  minTrials: 1,
};

function seedStructuredPlaybook(): StructuredPlaybook {
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
  };
}

const reflection: ReflectionResult = {
  rootCause: "model-call timed out twice on tool dispatch",
  keyInsight: "shorten retry backoff; cite bullet b1",
  bulletTags: [{ id: "b1", tag: "helpful" }],
};

const stubReflector: ReflectorFn = async () => reflection;

const addOperation: readonly CuratorOperation[] = [
  { kind: "add", section: "Existing", content: "shorten retry backoff" },
];

const stubCurator: CuratorFn = async () => addOperation;

function makeEvaluator(verdict: PlaybookEvaluation["verdict"]): EvaluatorFn {
  return async ({ proposal }) => ({
    id: `eval-${proposal.id}`,
    proposalId: proposal.id,
    verdict,
    metrics:
      verdict === "promote"
        ? { helpfulRate: 0.9, harmfulRate: 0.0, trials: 5 }
        : { helpfulRate: 0.0, harmfulRate: 0.9, trials: 5 },
    evaluatedAt: 1,
  });
}

const sessionCtx = (sid: string): SessionContext => ({
  sessionId: sessionId(sid),
  runId: runId(`run-${sid}`),
  agentId: "agent-1",
  metadata: {},
});

const turnCtx = (sid: string, turnIndex: number): TurnContext => {
  const session = sessionCtx(sid);
  return {
    session,
    turnIndex,
    turnId: turnId(session.runId, turnIndex),
    messages: [],
    metadata: {},
  };
};

// ---------------------------------------------------------------------------

describe("createAceMiddleware × promotion gate (sqlite, no LLM)", () => {
  test("promote verdict → head advances, proposal+evaluation lineage recorded", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      let counter = 0;
      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
          idGenerator: () => `id-${++counter}`,
        },
      });

      // Drive a fake session: start → record one tool entry → end.
      const ctx = sessionCtx("sess-promote");
      await mw.onSessionStart!(ctx);
      const t = turnCtx("sess-promote", 0);
      await mw.wrapToolCall!(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd!(ctx);

      // Head advanced via commitPromotion.
      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(2);
      expect(head?.provenance?.proposalId).toBe("id-1");
      expect(head?.sections[0]?.bullets.some((b) => b.content.includes("shorten retry"))).toBe(
        true,
      );

      // Lineage recorded.
      const persistedProposal = await store.proposals.getProposal("id-1");
      expect(persistedProposal?.id).toBe("id-1");
      expect(persistedProposal?.baseVersion).toBe(1);
    } finally {
      store.close();
    }
  });

  test("reject verdict → head unchanged, evaluation still recorded for audit", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      let counter = 0;
      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: stubCurator,
          evaluator: makeEvaluator("reject"),
          thresholds,
          idGenerator: () => `id-${++counter}`,
        },
      });

      const ctx = sessionCtx("sess-reject");
      await mw.onSessionStart!(ctx);
      const t = turnCtx("sess-reject", 0);
      await mw.wrapToolCall!(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd!(ctx);

      // Head NOT advanced (reject is audit-only).
      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);

      // Proposal still recorded — explains why we evaluated.
      const persistedProposal = await store.proposals.getProposal("id-1");
      expect(persistedProposal?.id).toBe("id-1");
    } finally {
      store.close();
    }
  });

  test("empty curator output → no proposal recorded, no head change", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      let counter = 0;
      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          // Empty operations: no-op curation.
          curator: async () => [],
          evaluator: makeEvaluator("promote"),
          thresholds,
          idGenerator: () => `id-${++counter}`,
        },
      });

      const ctx = sessionCtx("sess-noop");
      await mw.onSessionStart!(ctx);
      const t = turnCtx("sess-noop", 0);
      await mw.wrapToolCall!(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd!(ctx);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
      // Counter never incremented: no proposal record attempted.
      expect(counter).toBe(0);
    } finally {
      store.close();
    }
  });

  test("structured-pipeline failure does not block session end (onError observes)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());
      const observed: unknown[] = [];

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw new Error("reflector boom");
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
          onError: (e) => observed.push(e),
        },
      });

      const ctx = sessionCtx("sess-err");
      await mw.onSessionStart!(ctx);
      const t = turnCtx("sess-err", 0);
      await mw.wrapToolCall!(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      // Must NOT throw despite reflector failure.
      await mw.onSessionEnd!(ctx);

      expect(observed.length).toBe(1);
      expect(String(observed[0])).toMatch(/reflector boom/);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  test("rollback verdict from evaluator routed back through onError (not silently ignored)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());
      const observed: unknown[] = [];

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: stubCurator,
          evaluator: makeEvaluator("rollback"),
          thresholds,
          onError: (e) => observed.push(e),
        },
      });

      const ctx = sessionCtx("sess-rb");
      await mw.onSessionStart!(ctx);
      const t = turnCtx("sess-rb", 0);
      await mw.wrapToolCall!(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd!(ctx);

      expect(observed.length).toBe(1);
      expect(String(observed[0])).toMatch(/rollback.*pipeline only handles promote\/reject/);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });
});
