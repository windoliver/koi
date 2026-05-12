/**
 * E2E corner cases for createAceMiddleware that exercise the full
 * trajectory → pipeline → store flow on real sqlite.
 *
 * Covers:
 *  - A: a tool call whose Promise resolves after onBeforeTurn for the next
 *       turn is stamped with its CALLER turnIndex (round-9 fix), not the
 *       newer mutable session.turnIndex
 *  - F: lifecycle nonce — a wrapper captured from a prior session.runId
 *       cannot leak entries into a fresh session that reuses the sessionId
 *  - phase-3-rerun: late tool completing during the structured pipeline
 *       still feeds the next pipeline iteration before seal
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CuratorOperation,
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
} from "../../ace-middleware.js";

const PLAYBOOK_ID = "spb-corner";

const thresholds: PromotionThresholds = {
  minHelpfulRate: 0.5,
  maxHarmfulRate: 0.5,
  minTrials: 1,
};

function seed(): StructuredPlaybook {
  return {
    id: PLAYBOOK_ID,
    title: "v",
    sections: [
      {
        name: "S",
        slug: "s",
        bullets: [{ id: "b1", content: "x", helpful: 1, harmful: 0, createdAt: 0, updatedAt: 0 }],
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
  rootCause: "rc",
  keyInsight: "ki",
  bulletTags: [],
};
const ops: readonly CuratorOperation[] = [{ kind: "add", section: "S", content: "insight" }];

const stubReflector: ReflectorFn = async () => reflection;
const stubCurator: CuratorFn = async () => ops;
const promoteEvaluator: EvaluatorFn = async ({ proposal }) => ({
  id: `eval-${proposal.id}`,
  proposalId: proposal.id,
  verdict: "promote",
  metrics: { helpfulRate: 0.9, harmfulRate: 0.0, trials: 5 },
  evaluatedAt: 1,
});

const sessionCtx = (sid: string, rid: string): SessionContext => ({
  sessionId: sessionId(sid),
  runId: runId(rid),
  agentId: "agent-1",
  metadata: {},
});

const turnCtx = (sid: string, rid: string, turnIndex: number): TurnContext => {
  const session = sessionCtx(sid, rid);
  return {
    session,
    turnIndex,
    turnId: turnId(session.runId, turnIndex),
    messages: [],
    metadata: {},
  };
};

function withTmpDb<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ace-mw-e2e-"));
  const path = join(dir, "ace.sqlite");
  return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("ACE e2e: middleware corner cases on real sqlite", () => {
  test("A: tool resolving after next-turn boundary is stamped with caller turnIndex", async () => {
    await withTmpDb(async (path) => {
      const store = createSqlitePlaybookStore({ path });
      try {
        await store.structuredPlaybooks.save(seed());

        // Capture trajectory entries that the middleware records.
        const captured: Array<{ turnIndex: number; identifier: string }> = [];
        const trajectoryStore = {
          append: async (
            _sid: string,
            entries: readonly { turnIndex: number; identifier: string }[],
          ): Promise<void> => {
            for (const e of entries)
              captured.push({ turnIndex: e.turnIndex, identifier: e.identifier });
          },
          getSession: async () => [],
          listSessions: async () => [],
        };

        let counter = 0;
        const mw = createAceMiddleware({
          playbookStore: store.playbooks,
          trajectoryStore,
          clock: () => 1000,
          structuredPipeline: {
            structuredStore: store.structuredPlaybooks,
            proposalStore: store.proposals,
            playbookId: PLAYBOOK_ID,
            reflector: stubReflector,
            curator: stubCurator,
            evaluator: promoteEvaluator,
            thresholds,
            idGenerator: () => `id-${++counter}`,
          },
        });

        const sid = "sess-A";
        const rid = "run-A";
        await mw.onSessionStart?.(sessionCtx(sid, rid));

        // Start tool on turn 0; resolve it AFTER onBeforeTurn(1) advances state.
        const t0 = turnCtx(sid, rid, 0);
        let resolveT0!: () => void;
        const t0Done = new Promise<void>((r) => {
          resolveT0 = r;
        });
        const t0Call = mw.wrapToolCall?.(t0, { toolId: "search-slow", input: {} }, async () => {
          await t0Done;
          return { output: "ok", isError: false };
        });

        // Advance the mutable turn index.
        await mw.onBeforeTurn?.(turnCtx(sid, rid, 1));

        // Now resolve the slow tool. If we read state.turnIndex at that
        // moment we'd attribute it to turn 1; we want turn 0.
        resolveT0();
        await t0Call;

        // Fire a normal turn-1 tool to make sure mapping isn't accidental.
        await mw.wrapToolCall?.(
          turnCtx(sid, rid, 1),
          { toolId: "search-fast", input: {} },
          async () => ({ output: "ok", isError: false }),
        );

        await mw.onSessionEnd?.(sessionCtx(sid, rid));

        const slow = captured.find((c) => c.identifier === "search-slow");
        const fast = captured.find((c) => c.identifier === "search-fast");
        expect(slow?.turnIndex).toBe(0);
        expect(fast?.turnIndex).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  test("F: stale wrapper from prior runId cannot leak into a reused-sessionId session", async () => {
    await withTmpDb(async (path) => {
      const store = createSqlitePlaybookStore({ path });
      try {
        await store.structuredPlaybooks.save(seed());

        const captured: Array<{ turnIndex: number; identifier: string }> = [];
        const trajectoryStore = {
          append: async (
            _sid: string,
            entries: readonly { turnIndex: number; identifier: string }[],
          ): Promise<void> => {
            for (const e of entries)
              captured.push({ turnIndex: e.turnIndex, identifier: e.identifier });
          },
          getSession: async () => [],
          listSessions: async () => [],
        };

        let counter = 0;
        const mw = createAceMiddleware({
          playbookStore: store.playbooks,
          trajectoryStore,
          clock: () => 1000,
          structuredPipeline: {
            structuredStore: store.structuredPlaybooks,
            proposalStore: store.proposals,
            playbookId: PLAYBOOK_ID,
            reflector: stubReflector,
            curator: stubCurator,
            evaluator: promoteEvaluator,
            thresholds,
            idGenerator: () => `id-${++counter}`,
          },
        });

        const SID = "sess-reused";

        // First lifecycle: start, capture a wrapper handle, do NOT invoke yet.
        const ctx1 = sessionCtx(SID, "run-1");
        await mw.onSessionStart?.(ctx1);
        const t1 = turnCtx(SID, "run-1", 0);
        let releaseStale!: () => void;
        const stalePending = new Promise<void>((r) => {
          releaseStale = r;
        });
        const stalePromise = mw.wrapToolCall?.(
          t1,
          { toolId: "stale-tool", input: {} },
          async () => {
            await stalePending;
            return { output: "ok", isError: false };
          },
        );
        // Release before onSessionEnd so the entry IS captured legitimately.
        releaseStale();
        await stalePromise;
        await mw.onSessionEnd?.(ctx1);
        const sess1Captures = captured.length;

        // Second lifecycle: same sessionId, fresh runId.
        const ctx2 = sessionCtx(SID, "run-2");
        await mw.onSessionStart?.(ctx2);

        // Now fire a wrapper using a turn context built from the OLD runId.
        // Lifecycle nonce should reject this — it must NOT be recorded under
        // the new lifecycle's state.
        const tStale = turnCtx(SID, "run-1", 0);
        await mw.wrapToolCall?.(tStale, { toolId: "ghost-from-run1", input: {} }, async () => ({
          output: "ok",
          isError: false,
        }));

        // Legitimate wrapper under run-2.
        await mw.wrapToolCall?.(
          turnCtx(SID, "run-2", 0),
          { toolId: "fresh-run2", input: {} },
          async () => ({ output: "ok", isError: false }),
        );

        await mw.onSessionEnd?.(ctx2);

        const newCaptures = captured.slice(sess1Captures);
        expect(newCaptures.some((c) => c.identifier === "fresh-run2")).toBe(true);
        // Ghost from run-1 must NOT be tracked under the run-2 lifecycle.
        expect(newCaptures.some((c) => c.identifier === "ghost-from-run1")).toBe(false);
      } finally {
        store.close();
      }
    });
  });

  test("phase-3-rerun: late tool during pipeline feeds the next iteration before seal", async () => {
    await withTmpDb(async (path) => {
      const store = createSqlitePlaybookStore({ path });
      try {
        await store.structuredPlaybooks.save(seed());

        const captured: Array<{ identifier: string }> = [];
        const trajectoryStore = {
          append: async (
            _sid: string,
            entries: readonly { identifier: string }[],
          ): Promise<void> => {
            for (const e of entries) captured.push({ identifier: e.identifier });
          },
          getSession: async () => [],
          listSessions: async () => [],
        };

        // Reflector that fires a NEW wrapper on its first invocation, then
        // returns deterministically. This simulates a host that is still
        // emitting tool calls while the structured pipeline is running.
        let reflectInvocations = 0;
        let lateTriggered = false;
        let lateResolver!: () => void;
        const latePromise = new Promise<void>((r) => {
          lateResolver = r;
        });

        const reflectorWithLateFire: ReflectorFn = async () => {
          reflectInvocations += 1;
          if (!lateTriggered) {
            lateTriggered = true;
            // Fire a wrapper concurrently — pipeline must drain & re-run.
            // We schedule on next tick so the pipeline returns first.
            setTimeout(() => {
              void mwRef
                .wrapToolCall?.(
                  turnCtx("sess-late", "run-late", 0),
                  {
                    toolId: "late-tool",
                    input: {},
                  },
                  async () => ({ output: "ok", isError: false }),
                )
                .then(() => {
                  lateResolver();
                });
            }, 0);
          }
          // Wait for the late wrapper to land before completing this
          // reflector run, to guarantee state.entries grows during phase 3.
          if (reflectInvocations === 1) await latePromise;
          return reflection;
        };

        let counter = 0;
        const mw = createAceMiddleware({
          playbookStore: store.playbooks,
          trajectoryStore,
          clock: () => 1000,
          structuredPipeline: {
            structuredStore: store.structuredPlaybooks,
            proposalStore: store.proposals,
            playbookId: PLAYBOOK_ID,
            reflector: reflectorWithLateFire,
            curator: stubCurator,
            evaluator: promoteEvaluator,
            thresholds,
            idGenerator: () => `id-${++counter}`,
          },
        });
        const mwRef = mw;

        const ctx = sessionCtx("sess-late", "run-late");
        await mw.onSessionStart?.(ctx);

        // Initial tool that makes the pipeline run at all.
        await mw.wrapToolCall?.(
          turnCtx("sess-late", "run-late", 0),
          { toolId: "initial", input: {} },
          async () => ({ output: "ok", isError: false }),
        );
        await mw.onSessionEnd?.(ctx);

        // Both tools must be persisted to trajectory store.
        expect(captured.some((c) => c.identifier === "initial")).toBe(true);
        expect(captured.some((c) => c.identifier === "late-tool")).toBe(true);
        // Reflector must have run more than once because phase-3-rerun
        // detected the new entry.
        expect(reflectInvocations).toBeGreaterThanOrEqual(2);
      } finally {
        store.close();
      }
    });
  });
});
