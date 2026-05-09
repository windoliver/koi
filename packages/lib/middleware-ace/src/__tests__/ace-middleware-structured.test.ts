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
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";
import { createPlaybookStoreNexus } from "@koi/playbook-store-nexus";
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
          onError: () => hostileThenable as unknown as undefined,
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
      expect(wrapped.stage).toBe("rollback-decline");
      expect(String(wrapped.cause)).toMatch(/no resolveRollbackTarget handler is configured/);

      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  test("session-id reuse: onSessionStart serializes — second lifecycle waits for first teardown", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Block the first lifecycle's teardown on a deferred promise so we can
      // start a second lifecycle (same id) while it's still running.
      let releaseFirst: () => void;
      const firstBlocker = new Promise<void>((r) => {
        releaseFirst = r;
      });
      let firstReflectorCalls = 0;
      let secondReflectorCalls = 0;

      const sharedId = "sess-reuse";
      let counter = 0;
      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            const which = ++counter;
            if (which === 1) {
              firstReflectorCalls++;
              await firstBlocker;
            } else {
              secondReflectorCalls++;
            }
            return reflection;
          },
          curator: stubCurator,
          evaluator: makeEvaluator("reject"),
          thresholds,
          idGenerator: () => `id-reuse-${counter}`,
        },
      });

      // Lifecycle 1: start, record, end (teardown will block on firstBlocker).
      const ctx1 = sessionCtx(sharedId);
      await mw.onSessionStart?.(ctx1);
      const t1 = turnCtx(sharedId, 0);
      await mw.wrapToolCall?.(t1, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      const teardown1 = mw.onSessionEnd?.(ctx1);

      // Lifecycle 2 attempts to start with the same id while teardown1 is
      // still pending. The middleware must serialize: onSessionStart awaits
      // the prior teardown so callbacks for the new lifecycle cannot collide
      // with stale state from the old one.
      const ctx2 = sessionCtx(sharedId);
      const start2 = mw.onSessionStart?.(ctx2);

      // Release the first teardown so the second start can proceed.
      releaseFirst!();
      await teardown1;
      await start2;

      const t2 = turnCtx(sharedId, 0);
      await mw.wrapToolCall?.(t2, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx2);

      // BOTH lifecycles ran independently — second session reflector fired
      // exactly once with its own state.
      expect(firstReflectorCalls).toBe(1);
      expect(secondReflectorCalls).toBe(1);
    } finally {
      store.close();
    }
  });

  test("in-flight wrapToolCall is drained (entry included) before teardown seals", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Block the tool call so it's still pending when onSessionEnd fires.
      let releaseTool: () => void;
      const toolBlocker = new Promise<void>((r) => {
        releaseTool = r;
      });
      let observedEntryCount = -1;

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async ({ trajectory }) => {
            observedEntryCount = trajectory.length;
            return reflection;
          },
          curator: stubCurator,
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-inflight");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-inflight", 0);

      // Start a tool call that won't resolve until we let it.
      const toolCallPromise = mw.wrapToolCall?.(t, { toolId: "slow-tool", input: {} }, async () => {
        await toolBlocker;
        return { output: "ok", isError: false };
      });

      // Trigger teardown — must drain the in-flight tool before recording.
      const teardown = mw.onSessionEnd?.(ctx);

      // Allow the tool to complete. Its trajectory entry MUST be recorded
      // before the structured pipeline sees the trajectory.
      releaseTool!();
      await toolCallPromise;
      await teardown;

      // The drained tool's entry was visible to the reflector.
      expect(observedEntryCount).toBe(1);
    } finally {
      store.close();
    }
  });

  test("drain bounded by timeout — never-settling tool does not wedge teardown", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());
      let reflectorRan = false;

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        drainTimeoutMs: 50,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            reflectorRan = true;
            return reflection;
          },
          curator: async () => [],
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-stuck");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-stuck", 0);

      // First, a normal tool call that resolves — gives the trajectory at
      // least one entry so the pipeline runs after drain.
      await mw.wrapToolCall?.(t, { toolId: "ok", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));

      // Then a stuck tool that never resolves — must not wedge teardown.
      const stuck = mw.wrapToolCall?.(
        t,
        { toolId: "stuck", input: {} },
        () => new Promise<{ output: string; isError: boolean }>(() => {}),
      );
      void stuck;

      const start = Date.now();
      await mw.onSessionEnd?.(ctx);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(2000);
      // On timeout: trajectory prefix (completed entries) is persisted, but
      // the promotion pipeline is skipped — so reflector never runs.
      expect(reflectorRan).toBe(false);
      expect(logs.some((l) => /drain timed out/.test(l))).toBe(true);
      expect(logs.some((l) => /skipping promotion pipeline/.test(l))).toBe(true);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test("drain timeout persists completed trajectory prefix (drops only promotion)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    const appended: { readonly sessionId: string; readonly count: number }[] = [];
    const trajectoryStore = {
      append: async (sessionId: string, entries: readonly unknown[]): Promise<void> => {
        appended.push({ sessionId, count: entries.length });
      },
      getSession: async (): Promise<readonly never[]> => [],
      listSessions: async (): Promise<readonly string[]> => [],
    };
    const originalError = console.error;
    console.error = (): void => {};
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());
      let reflectorRan = false;

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        trajectoryStore,
        clock: () => 1000,
        drainTimeoutMs: 50,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async () => {
            reflectorRan = true;
            return reflection;
          },
          curator: async () => [],
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-prefix");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-prefix", 0);

      await mw.wrapToolCall?.(t, { toolId: "ok", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));

      const stuck = mw.wrapToolCall?.(
        t,
        { toolId: "stuck", input: {} },
        () => new Promise<{ output: string; isError: boolean }>(() => {}),
      );
      void stuck;

      await mw.onSessionEnd?.(ctx);

      // Trajectory prefix WAS persisted (one completed entry).
      expect(appended).toHaveLength(1);
      expect(appended[0]?.sessionId).toBe("sess-prefix");
      expect(appended[0]?.count).toBe(1);
      // Promotion pipeline was skipped on timeout.
      expect(reflectorRan).toBe(false);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test("shutdownInFlight late additions are awaited (loop drains until empty)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        drainTimeoutMs: 5000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: async () => [],
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-late");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-late", 0);

      // Block teardown's primary drain so the closing window is wide.
      let releaseInitial: () => void = () => {};
      const initialBlocker = new Promise<void>((r) => {
        releaseInitial = r;
      });
      const initial = mw.wrapToolCall?.(t, { toolId: "init", input: {} }, async () => {
        await initialBlocker;
        return { output: "ok", isError: false };
      });
      void initial;

      const teardown = mw.onSessionEnd?.(ctx);

      // First closing-window call — registered in shutdownInFlight before the
      // shutdown drain begins.
      let firstSettled = false;
      let releaseFirst: () => void = () => {};
      const firstBlocker = new Promise<void>((r) => {
        releaseFirst = r;
      });
      const first = mw
        .wrapToolCall?.(t, { toolId: "first", input: {} }, async () => {
          await firstBlocker;
          return { output: "ok", isError: false };
        })
        .then(() => {
          firstSettled = true;
        });

      // Release the initial blocker so primary drain completes and shutdown
      // drain begins — first is now in shutdownInFlight.
      releaseInitial();

      // After a tick, register a SECOND closing-window call. This is the
      // "late addition" — added after shutdown drain has already sampled.
      let secondSettled = false;
      let releaseSecond: () => void = () => {};
      const secondBlocker = new Promise<void>((r) => {
        releaseSecond = r;
      });
      void Promise.resolve().then(() => {
        const second = mw
          .wrapToolCall?.(t, { toolId: "second", input: {} }, async () => {
            await secondBlocker;
            return { output: "ok", isError: false };
          })
          .then(() => {
            secondSettled = true;
          });
        // Release first ONLY after second is registered, so when shutdown
        // drain awaits its snapshot, second is already pending.
        Promise.resolve().then(() => {
          releaseFirst();
          // Then release second after another tick.
          Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => releaseSecond());
        });
        void second;
      });

      await teardown;
      await first;

      // Both wrappers must have settled before teardown resolved.
      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(true);
    } finally {
      store.close();
    }
  });

  test("closing-state model call still receives playbook injection", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());
      // Seed a flat playbook so the middleware injects content.
      await store.playbooks.save({
        id: "pb-inject",
        title: "Active",
        strategy: "must-see-this",
        version: 1,
        tags: [],
        source: "curated",
        confidence: 1,
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 0,
      });

      let releaseFirst: () => void;
      const firstBlocker = new Promise<void>((r) => {
        releaseFirst = r;
      });

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: async () => [],
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-inject-closing");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-inject-closing", 0);

      // First tool blocks teardown's drain so we have a closing window.
      const blocker = mw.wrapToolCall?.(t, { toolId: "block", input: {} }, async () => {
        await firstBlocker;
        return { output: "ok", isError: false };
      });

      const teardown = mw.onSessionEnd?.(ctx);

      // Late model call during closing window — must still receive injection.
      let observedSystemPrompt: string | undefined;
      await mw.wrapModelCall?.(
        t,
        { model: "test-model", messages: [], systemPrompt: "base" },
        async (req) => {
          observedSystemPrompt = req.systemPrompt;
          return { model: "test-model", content: "", finishReason: "stop" };
        },
      );

      releaseFirst!();
      await blocker;
      await teardown;

      // Late model call during closing must still see the injected playbook.
      expect(observedSystemPrompt).toMatch(/Active Playbooks|must-see-this/i);
    } finally {
      store.close();
    }
  });

  test("new wrapToolCall during drain window IS recorded (no audit hole)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Block the FIRST tool call to keep drain in-flight.
      let releaseFirst: () => void;
      const firstBlocker = new Promise<void>((r) => {
        releaseFirst = r;
      });
      let observedEntryCount = -1;

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async ({ trajectory }) => {
            observedEntryCount = trajectory.length;
            return reflection;
          },
          curator: stubCurator,
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-bounded");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-bounded", 0);

      // Tool call 1: in-flight when teardown starts → must be drained.
      const toolCall1 = mw.wrapToolCall?.(t, { toolId: "first", input: {} }, async () => {
        await firstBlocker;
        return { output: "ok", isError: false };
      });

      const teardown = mw.onSessionEnd?.(ctx);

      // Tool call 2: starts AFTER onSessionEnd flipped `closing`. Must run
      // (host contract), is tracked in shutdownInFlight, drained by the
      // unified drain loop, AND records a trajectory entry — closing the
      // audit hole where post-closing side-effects ran invisibly.
      let secondCallRan = false;
      const toolCall2 = mw.wrapToolCall?.(t, { toolId: "second", input: {} }, async () => {
        secondCallRan = true;
        return { output: "post", isError: false };
      });

      // Allow first to complete; teardown drains both before sealing.
      releaseFirst!();
      await toolCall1;
      await toolCall2;
      await teardown;

      expect(secondCallRan).toBe(true); // host contract: call still runs
      // Reflector saw BOTH entries — drain waited for the late call too.
      expect(observedEntryCount).toBe(2);
    } finally {
      store.close();
    }
  });

  test("late wrapToolCall after onSessionEnd starts IS recorded (drained before seal)", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());

      // Block teardown's reflector so we have a window to fire late events.
      let releaseReflector: () => void = () => {};
      const reflectorBlocker = new Promise<void>((r) => {
        releaseReflector = r;
      });
      let observedEntryCount = 0;

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: store.structuredPlaybooks,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: async ({ trajectory }) => {
            observedEntryCount = trajectory.length;
            await reflectorBlocker;
            return reflection;
          },
          curator: stubCurator,
          evaluator: makeEvaluator("reject"),
          thresholds,
        },
      });

      const ctx = sessionCtx("sess-late");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-late", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      // Trigger teardown but do not await — it will pause inside reflector.
      const teardown = mw.onSessionEnd?.(ctx);

      // Fire a late wrapToolCall AFTER teardown started. The unified drain
      // tracks it in shutdownInFlight and waits for it before sealing
      // closed=true, so its entry IS recorded — closes the audit hole
      // where post-closing side-effects ran invisibly.
      await mw.wrapToolCall?.(t, { toolId: "late-search", input: {} }, async () => ({
        output: "late",
        isError: false,
      }));

      releaseReflector();
      await teardown;

      // Both the pre-teardown and the late call appear in the trajectory
      // observed by the structured pipeline.
      expect(observedEntryCount).toBe(2);
    } finally {
      store.close();
    }
  });

  test("public Nexus bundle preserves lineageSupported=false → rollback fails closed via gate", async () => {
    // Wire a real public-bundle structured store into the middleware. The
    // bundle MUST surface lineageSupported so rollbackPromotion's gate check
    // fails closed at the right level instead of producing an opaque commit
    // failure later.
    const transport = createFakeNexusTransport();
    const bundle = createPlaybookStoreNexus({
      transport,
      basePath: "ace-bundle-rb",
      requirePreProvisioned: false,
    });
    try {
      // Pre-provision a v1 playbook through the bundle.
      await bundle.structuredPlaybooks.save({
        id: PLAYBOOK_ID,
        title: "v1",
        sections: [],
        tags: [],
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 0,
        version: 1,
      });

      const observed: unknown[] = [];
      const mw = createAceMiddleware({
        playbookStore: bundle.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: bundle.structuredPlaybooks,
          proposalStore: bundle.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: stubCurator,
          evaluator: makeEvaluator("rollback"),
          thresholds,
          resolveRollbackTarget: async (): Promise<number | null> => 1,
          onError: (e) => observed.push(e),
        },
      });

      const ctx = sessionCtx("sess-bundle-rb");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-bundle-rb", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      expect(bundle.structuredPlaybooks.lineageSupported).toBe(false);
      // Gate check inside rollbackPromotion fires → stage="rollback-commit",
      // cause includes the lineage-support error.
      expect(observed.length).toBe(1);
      const wrapped = observed[0] as { stage?: unknown; cause?: unknown };
      expect(wrapped.stage).toBe("rollback-commit");
      expect(String(wrapped.cause)).toMatch(/lineage support/i);
    } finally {
      bundle.close();
    }
  });

  test("rollback-commit failure surfaces as distinct stage (not rollback-decline)", async () => {
    // No lineage on the structured store → rollbackPromotion throws. Stage
    // must be `rollback-commit` so operators can distinguish operational
    // failure from a caller's benign decline.
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      await store.structuredPlaybooks.save(seedStructuredPlaybook());
      const observed: unknown[] = [];
      // Wrap the structured store to disable lineage, forcing rollbackPromotion
      // to throw at the lineage-support gate.
      const noLineageStore: typeof store.structuredPlaybooks = {
        ...store.structuredPlaybooks,
        lineageSupported: false,
      };

      const mw = createAceMiddleware({
        playbookStore: store.playbooks,
        clock: () => 1000,
        structuredPipeline: {
          structuredStore: noLineageStore,
          proposalStore: store.proposals,
          playbookId: PLAYBOOK_ID,
          reflector: stubReflector,
          curator: stubCurator,
          evaluator: makeEvaluator("rollback"),
          thresholds,
          resolveRollbackTarget: async (): Promise<number | null> => 1,
          onError: (e) => observed.push(e),
        },
      });

      const ctx = sessionCtx("sess-rb-fail");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-rb-fail", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      expect(observed.length).toBe(1);
      const wrapped = observed[0] as { stage?: unknown };
      expect(wrapped.stage).toBe("rollback-commit");
    } finally {
      store.close();
    }
  });

  test("rollback verdict + resolveRollbackTarget → gate-enforced rollback runs", async () => {
    const store = createSqlitePlaybookStore({ path: ":memory:" });
    try {
      // Seed v1, then advance to v2 via a manual save so a prior version
      // exists for rollback to target.
      const v1 = seedStructuredPlaybook();
      await store.structuredPlaybooks.save(v1);
      const v2: StructuredPlaybook = {
        ...v1,
        version: 2,
        title: "v2",
        sections: [
          {
            ...v1.sections[0]!,
            bullets: [
              ...v1.sections[0]!.bullets,
              {
                id: "b2",
                content: "v2 bullet",
                helpful: 0,
                harmful: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        ],
      };
      await store.structuredPlaybooks.save(v2);

      let counter = 0;
      let onRollbackInvoked = false;
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
          idGenerator: () => `id-${++counter}`,
          resolveRollbackTarget: async ({ playbookBefore }): Promise<number | null> => {
            onRollbackInvoked = true;
            expect(playbookBefore.version).toBe(2);
            // Caller-supplied policy: roll back to v1.
            return 1;
          },
        },
      });

      const ctx = sessionCtx("sess-rb-handled");
      await mw.onSessionStart?.(ctx);
      const t = turnCtx("sess-rb-handled", 0);
      await mw.wrapToolCall?.(t, { toolId: "search", input: {} }, async () => ({
        output: "ok",
        isError: false,
      }));
      await mw.onSessionEnd?.(ctx);

      expect(onRollbackInvoked).toBe(true);
      // rollbackPromotion advances head to a NEW version that mirrors v1's
      // content; gate enforces version monotonicity (cannot literally write
      // version=1 over version=2).
      const head = await store.structuredPlaybooks.get(PLAYBOOK_ID);
      expect(head?.version ?? 0).toBeGreaterThan(2);
      expect(head?.title).toBe("v");
      expect(head?.sections[0]?.bullets.length).toBe(1);
    } finally {
      store.close();
    }
  });
});
