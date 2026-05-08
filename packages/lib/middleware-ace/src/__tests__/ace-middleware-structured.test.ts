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
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-promote", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

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
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-reject", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

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
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-noop", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
      // Counter never incremented: no proposal record attempted.
      expect(counter).toBe(0);
    } finally {
      store.close();
    }
  });

  test("empty session (no recorded calls) → no proposal, no evaluation, no head change", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      let reflectorCalls = 0;
      let curatorCalls = 0;
      let evaluatorCalls = 0;
      let counter = 0;

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            reflectorCalls++;
            return reflection;
          },
          curator: async () => {
            curatorCalls++;
            return addOperation;
          },
          evaluator: async (args) => {
            evaluatorCalls++;
            return makeEvaluator("promote")(args);
          },
          thresholds,
          idGenerator: () => `id-${++counter}`,
        },
      });

      const ctx = sessionCtx("sess-empty");
      await mw.onSessionStart?.(ctx);
      // No wrapToolCall / wrapModelCall — session ends with zero entries.
      await mw.onSessionEnd?.(ctx);

      expect(reflectorCalls).toBe(0);
      expect(curatorCalls).toBe(0);
      expect(evaluatorCalls).toBe(0);
      expect(counter).toBe(0);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
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
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-err", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      // Must NOT throw despite reflector failure.
      await mw.onSessionEnd?.(ctx);

      expect(observed.length).toBe(1);
      const wrapped = observed[0] as { cause?: unknown; stage?: unknown };
      expect(String(wrapped.cause)).toMatch(/reflector boom/);
      expect(wrapped.stage).toBe("reflect");

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  test("hostile thrown value with no onError still resolves session end", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Proxy whose every property access throws — exercises the safeString
      // fallback so that console.error inspection can't rethrow.
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("hostile getter");
          },
        },
      );

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw hostile;
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
          // Intentionally no onError — exercises default fail-loud path.
        },
      });

      const ctx = sessionCtx("sess-hostile");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-hostile", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      // Must not throw despite hostile error value passed through default logger.
      await mw.onSessionEnd?.(ctx);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  test("proxy with throwing getPrototypeOf trap does not break onSessionEnd", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Trap fires for any `instanceof` probe; verifies safeString avoids it.
      const proto = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("hostile prototype");
          },
        },
      );

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw proto;
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-proto");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-proto", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  test("throwing onError still leaves an operator-visible log trail", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]): void => {
      logged.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw new Error("pipeline boom");
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
          onError: () => {
            throw new Error("handler boom");
          },
        },
      });

      const ctx = sessionCtx("sess-handler-throws");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-handler-throws", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      expect(logged.length).toBeGreaterThan(0);
      const trail = logged.join("\n");
      expect(trail).toMatch(/structured pipeline failure/);
      expect(trail).toMatch(/onError handler also failed/);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test("default logger emits sanitized one-liner (no raw Error object)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    const originalError = console.error;
    const captured: unknown[][] = [];
    console.error = (...args: unknown[]): void => {
      captured.push(args);
    };
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw new Error("ordinary boom");
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-ordinary");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-ordinary", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      // Default path must NOT pass the raw Error to console.error (data-leak
      // guard); it must emit a single sanitized string containing message text.
      expect(captured.length).toBeGreaterThan(0);
      for (const args of captured) {
        for (const a of args) {
          expect(a instanceof Error).toBe(false);
        }
      }
      const trail = captured.map((a) => a.join(" ")).join("\n");
      expect(trail).toMatch(/structured pipeline failure/);
      // Default path must NOT leak the error message text — only class metadata.
      expect(trail).not.toMatch(/ordinary boom/);
      expect(trail).toMatch(/class=StagedPipelineError/);
      expect(trail).toMatch(/stage=reflect/);
      expect(trail).toMatch(/sessionId=sess-ordinary/);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test("async-rejecting onError still produces fallback log trail", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]): void => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw new Error("pipeline boom");
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
          onError: async () => {
            throw new Error("async handler boom");
          },
        },
      });

      const ctx = sessionCtx("sess-async-handler");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-async-handler", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      // Async rejection lands on next microtask; flush.
      await new Promise((r) => setTimeout(r, 0));

      const trail = logged.join("\n");
      expect(trail).toMatch(/structured pipeline failure/);
      expect(trail).toMatch(/onError handler also failed/);
      // Class-only metadata; messages must NOT leak to default log path.
      expect(trail).not.toMatch(/async handler boom/);
      expect(trail).not.toMatch(/pipeline boom/);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test("onError returning a hostile thenable does not break onSessionEnd", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Looks like a thenable but `then` getter throws. Promise.resolve will
      // see the throwing getter and either capture it in a rejected promise
      // (newer engines) or throw — invokeOnErrorDetached must contain both.
      const hostileThenable = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") throw new Error("hostile then getter");
            return undefined;
          },
        },
      );

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            throw new Error("pipeline boom");
          },
          curator: stubCurator,
          evaluator: makeEvaluator("promote"),
          thresholds,
          onError: () => hostileThenable as unknown as void,
        },
      });

      const ctx = sessionCtx("sess-hostile-thenable");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-hostile-thenable", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      // Must not throw.
      await mw.onSessionEnd?.(ctx);

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
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-rb", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      expect(observed.length).toBe(1);
      const wrapped = observed[0] as { cause?: unknown; stage?: unknown };
      expect(wrapped.stage).toBe("rollback-rejected");
      expect(String(wrapped.cause)).toMatch(/rollback.*pipeline only handles promote\/reject/);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });
});
