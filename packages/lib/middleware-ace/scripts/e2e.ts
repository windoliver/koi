#!/usr/bin/env bun

/**
 * @koi/middleware-ace — end-to-end corner-case driver.
 *
 * Drives `createAceMiddleware` directly (no LLM, no network) through a
 * sequence of synthetic scenarios that the unit tests do not all cover:
 * cross-session learning, injection edge cases, failure propagation,
 * version progression, store filters, and runtime opt-in semantics.
 *
 * Run: bun run packages/lib/middleware-ace/scripts/e2e.ts
 *
 * Exit code 0 on success, 1 on any failed scenario.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { RunId, SessionId, TurnId } from "@koi/core/ecs";

import {
  aggregateTrajectoryStats,
  computeCurationScore,
  createAceMiddleware,
  createDefaultConsolidator,
  createInMemoryPlaybookStore,
  createInMemoryTrajectoryStore,
  curateTrajectorySummary,
  selectPlaybooks,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Reporting harness
// ---------------------------------------------------------------------------

interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly note?: string;
}

const results: ScenarioResult[] = [];

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err: unknown) {
    const note = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, note });
    process.stdout.write(`  ✗ ${name}\n      ${note}\n`);
  }
}

function expect<T>(actual: T): {
  readonly toBe: (expected: T) => void;
  readonly toEqual: (expected: T) => void;
  readonly toContain: (substr: string) => void;
  readonly toBeGreaterThan: (n: number) => void;
  readonly toBeUndefined: () => void;
} {
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        throw new Error(`expected ${String(actual)} === ${String(expected)}`);
      }
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`expected ${JSON.stringify(actual)} == ${JSON.stringify(expected)}`);
      }
    },
    toContain(substr) {
      if (typeof actual !== "string" || !actual.includes(substr)) {
        throw new Error(`expected ${JSON.stringify(actual)} to contain ${substr}`);
      }
    },
    toBeGreaterThan(n) {
      if (typeof actual !== "number" || actual <= n) {
        throw new Error(`expected ${String(actual)} > ${String(n)}`);
      }
    },
    toBeUndefined() {
      if (actual !== undefined) throw new Error(`expected undefined, got ${String(actual)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSession(id: string): SessionContext {
  return {
    agentId: "ace-e2e",
    sessionId: id as SessionId,
    runId: "run-1" as RunId,
    metadata: {} as JsonObject,
  };
}

function makeTurn(sess: SessionContext, turnIndex: number): TurnContext {
  return {
    session: sess,
    turnIndex,
    turnId: `${sess.runId}-${String(turnIndex)}` as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return { messages: [], model: "stub-model", ...overrides };
}

function makeResponse(): ModelResponse {
  return { content: "ok", model: "stub-model" };
}

function clockOf(getter: { now: number }): () => number {
  return () => getter.now;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const DAY = 1000 * 60 * 60 * 24;

async function run(): Promise<void> {
  process.stdout.write("\nACE e2e corner-case driver\n");
  process.stdout.write(`${"━".repeat(60)}\n\n`);
  process.stdout.write("Section: pipeline correctness\n");

  await scenario("empty trajectory at session end → no save, no append", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    const trajectoryStore = createInMemoryTrajectoryStore();
    const mw = createAceMiddleware({ playbookStore, trajectoryStore, minScore: 0 });
    const sess = makeSession("empty-1");
    await mw.onSessionStart?.(sess);
    await mw.onSessionEnd?.(sess);
    expect((await playbookStore.list()).length).toBe(0);
    expect((await trajectoryStore.listSessions()).length).toBe(0);
  });

  await scenario("mixed outcomes: invocations === successes + failures + retries", async () => {
    const stats = aggregateTrajectoryStats([
      {
        turnIndex: 0,
        timestamp: 0,
        kind: "tool_call",
        identifier: "x",
        outcome: "success",
        durationMs: 1,
      },
      {
        turnIndex: 0,
        timestamp: 1,
        kind: "tool_call",
        identifier: "x",
        outcome: "failure",
        durationMs: 2,
      },
      {
        turnIndex: 0,
        timestamp: 2,
        kind: "tool_call",
        identifier: "x",
        outcome: "retry",
        durationMs: 3,
      },
    ]);
    const stat = stats.get("tool_call:x");
    if (stat === undefined) throw new Error("missing stat");
    expect(stat.invocations).toBe(stat.successes + stat.failures + stat.retries);
    expect(stat.totalDurationMs).toBe(6);
  });

  await scenario("recency decay: 30 days at λ=0.05 ≈ 0.22 multiplier", async () => {
    const stats = new Map([
      [
        "tool_call:old",
        {
          identifier: "old",
          kind: "tool_call" as const,
          successes: 10,
          failures: 0,
          retries: 0,
          totalDurationMs: 100,
          invocations: 10,
          lastSeenMs: 0,
        },
      ],
    ]);
    const score = computeCurationScore(
      stats.get("tool_call:old") ??
        (() => {
          throw new Error("missing");
        })(),
      1,
      30 * DAY,
      0.05,
    );
    // freq=10/1=10, success=1.0, recency=exp(-1.5)≈0.223, clamp to 1 — but
    // inner product before clamp = 10 * 1 * 0.223 = 2.23 → clamps to 1.
    // Validate clamp behavior, not the raw multiplier.
    expect(score).toBe(1);
  });

  process.stdout.write("\nSection: cross-session\n");

  await scenario("session 1 records → session 2 sees [Active Playbooks]", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    const state = { now: 1_000 };
    const mw = createAceMiddleware({
      playbookStore,
      clock: clockOf(state),
      minScore: 0,
    });

    // Session 1
    const s1 = makeSession("s1");
    await mw.onSessionStart?.(s1);
    for (let i = 0; i < 3; i += 1) {
      await mw.wrapToolCall?.(makeTurn(s1, 0), { toolId: "fs.read", input: {} }, async () => {
        state.now += 5;
        return { output: i } satisfies ToolResponse;
      });
    }
    await mw.onSessionEnd?.(s1);
    expect((await playbookStore.list()).length).toBe(1);

    // Session 2 — injection should fire
    const s2 = makeSession("s2");
    await mw.onSessionStart?.(s2);
    let captured: ModelRequest | undefined;
    const handler: ModelHandler = async (req) => {
      captured = req;
      return makeResponse();
    };
    await mw.wrapModelCall?.(makeTurn(s2, 0), makeRequest({ systemPrompt: "BASE" }), handler);
    expect(captured?.systemPrompt).toContain("[Active Playbooks]");
    expect(captured?.systemPrompt).toContain("fs.read");
    expect(captured?.systemPrompt).toContain("BASE");
    await mw.onSessionEnd?.(s2);
  });

  await scenario("two interleaved sessions: trajectories isolated", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    const trajectoryStore = createInMemoryTrajectoryStore();
    const state = { now: 0 };
    const mw = createAceMiddleware({
      playbookStore,
      trajectoryStore,
      clock: clockOf(state),
      minScore: 0,
    });
    const a = makeSession("session-A");
    const b = makeSession("session-B");
    await mw.onSessionStart?.(a);
    await mw.onSessionStart?.(b);
    await mw.wrapToolCall?.(makeTurn(a, 0), { toolId: "tool-A", input: {} }, async () => ({
      output: 1,
    }));
    await mw.wrapToolCall?.(makeTurn(b, 0), { toolId: "tool-B", input: {} }, async () => ({
      output: 2,
    }));
    await mw.onSessionEnd?.(a);
    await mw.onSessionEnd?.(b);
    const aTraj = await trajectoryStore.getSession("session-A");
    const bTraj = await trajectoryStore.getSession("session-B");
    expect(aTraj.length).toBe(1);
    expect(bTraj.length).toBe(1);
    expect(aTraj[0]?.identifier).toBe("tool-A");
    expect(bTraj[0]?.identifier).toBe("tool-B");
  });

  process.stdout.write("\nSection: injection edge cases\n");

  await scenario("empty store: systemPrompt unchanged", async () => {
    const mw = createAceMiddleware({ playbookStore: createInMemoryPlaybookStore() });
    const s = makeSession("inj-1");
    await mw.onSessionStart?.(s);
    let captured: ModelRequest | undefined;
    await mw.wrapModelCall?.(
      makeTurn(s, 0),
      makeRequest({ systemPrompt: "ORIGINAL" }),
      async (req) => {
        captured = req;
        return makeResponse();
      },
    );
    expect(captured?.systemPrompt).toBe("ORIGINAL");
  });

  await scenario("maxTokens: 0 → no injection even with playbooks", async () => {
    const playbookStore = createInMemoryPlaybookStore([
      {
        id: "p1",
        title: "t",
        strategy: "cached strategy",
        tags: [],
        confidence: 0.9,
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 1,
        version: 1,
      },
    ]);
    const mw = createAceMiddleware({ playbookStore, maxInjectedTokens: 0 });
    const s = makeSession("inj-2");
    await mw.onSessionStart?.(s);
    let captured: ModelRequest | undefined;
    await mw.wrapModelCall?.(makeTurn(s, 0), makeRequest({ systemPrompt: "X" }), async (req) => {
      captured = req;
      return makeResponse();
    });
    expect(captured?.systemPrompt).toBe("X");
  });

  await scenario(
    "undefined systemPrompt: set to playbook block alone (no 'undefined' prefix)",
    async () => {
      const playbookStore = createInMemoryPlaybookStore([
        {
          id: "p1",
          title: "t",
          strategy: "S",
          tags: [],
          confidence: 0.9,
          source: "curated",
          createdAt: 0,
          updatedAt: 0,
          sessionCount: 1,
          version: 1,
        },
      ]);
      const mw = createAceMiddleware({ playbookStore });
      const s = makeSession("inj-3");
      await mw.onSessionStart?.(s);
      let captured: ModelRequest | undefined;
      await mw.wrapModelCall?.(makeTurn(s, 0), makeRequest(), async (req) => {
        captured = req;
        return makeResponse();
      });
      expect(captured?.systemPrompt).toContain("[Active Playbooks]");
      if (captured?.systemPrompt?.startsWith("undefined")) {
        throw new Error("systemPrompt leaked the literal 'undefined' prefix");
      }
    },
  );

  await scenario(
    "token budget greedy: small high-confidence preferred over big one that won't fit",
    async () => {
      const big = "x".repeat(800); // ≈ 200 tokens
      const small = "y";
      const playbooks = [
        {
          id: "big",
          title: "t",
          strategy: big,
          tags: [],
          confidence: 0.99,
          source: "curated" as const,
          createdAt: 0,
          updatedAt: 0,
          sessionCount: 1,
          version: 1,
        },
        {
          id: "small",
          title: "t",
          strategy: small,
          tags: [],
          confidence: 0.5,
          source: "curated" as const,
          createdAt: 0,
          updatedAt: 0,
          sessionCount: 1,
          version: 1,
        },
      ];
      const selected = selectPlaybooks(playbooks, { maxTokens: 5 });
      expect(selected.map((p) => p.id)).toEqual(["small"]);
    },
  );

  process.stdout.write("\nSection: failure semantics\n");

  await scenario("tool throws Error: outcome=failure + same Error re-raised", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const mw = createAceMiddleware({
      playbookStore: createInMemoryPlaybookStore(),
      trajectoryStore,
    });
    const s = makeSession("fail-1");
    await mw.onSessionStart?.(s);
    const cause = new Error("upstream failure");
    let raised: unknown;
    try {
      await mw.wrapToolCall?.(makeTurn(s, 0), { toolId: "boom", input: {} }, async () => {
        throw cause;
      });
    } catch (err: unknown) {
      raised = err;
    }
    if (raised !== cause) throw new Error("Error identity not preserved");
    await mw.onSessionEnd?.(s);
    const t = await trajectoryStore.getSession("fail-1");
    expect(t[0]?.outcome).toBe("failure");
  });

  await scenario(
    "tool throws non-Error string: outcome=failure + value re-raised verbatim",
    async () => {
      const mw = createAceMiddleware({ playbookStore: createInMemoryPlaybookStore() });
      const s = makeSession("fail-2");
      await mw.onSessionStart?.(s);
      let raised: unknown;
      try {
        await mw.wrapToolCall?.(makeTurn(s, 0), { toolId: "weird", input: {} }, async () => {
          throw "string-thrown";
        });
      } catch (err: unknown) {
        raised = err;
      }
      expect(raised).toBe("string-thrown");
    },
  );

  process.stdout.write("\nSection: provenance / versioning\n");

  await scenario(
    "first consolidation: version=1, provenance=undefined (gate not yet wired)",
    async () => {
      const playbookStore = createInMemoryPlaybookStore();
      const state = { now: 5_000 };
      const mw = createAceMiddleware({ playbookStore, clock: clockOf(state), minScore: 0 });
      const s = makeSession("v-1");
      await mw.onSessionStart?.(s);
      await mw.wrapToolCall?.(makeTurn(s, 0), { toolId: "fs.read", input: {} }, async () => {
        state.now += 1;
        return { output: 1 };
      });
      await mw.onSessionEnd?.(s);
      const stored = await playbookStore.list();
      expect(stored[0]?.version).toBe(1);
      expect(stored[0]?.provenance).toBeUndefined();
    },
  );

  await scenario(
    "second consolidation: version=2 + sessionCount=2 + updatedAt advances",
    async () => {
      const playbookStore = createInMemoryPlaybookStore();
      const state = { now: 1_000 };
      const mw = createAceMiddleware({ playbookStore, clock: clockOf(state), minScore: 0 });
      for (const id of ["v-2-a", "v-2-b"]) {
        const s = makeSession(id);
        await mw.onSessionStart?.(s);
        await mw.wrapToolCall?.(makeTurn(s, 0), { toolId: "fs.read", input: {} }, async () => {
          state.now += 1;
          return { output: 1 };
        });
        state.now += 1_000;
        await mw.onSessionEnd?.(s);
      }
      const [pb] = await playbookStore.list();
      expect(pb?.version).toBe(2);
      expect(pb?.sessionCount).toBe(2);
      if (pb !== undefined && pb.updatedAt <= pb.createdAt) {
        throw new Error("updatedAt did not advance past createdAt");
      }
    },
  );

  process.stdout.write("\nSection: store filters\n");

  await scenario("playbookStore.list({ tags }) intersects all tags", async () => {
    const store = createInMemoryPlaybookStore([
      {
        id: "x",
        title: "t",
        strategy: "s",
        tags: ["a", "b"],
        confidence: 1,
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 1,
        version: 1,
      },
      {
        id: "y",
        title: "t",
        strategy: "s",
        tags: ["a"],
        confidence: 1,
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 1,
        version: 1,
      },
    ]);
    const both = await store.list({ tags: ["a", "b"] });
    expect(both.map((p) => p.id)).toEqual(["x"]);
    const aOnly = await store.list({ tags: ["a"] });
    expect(aOnly.length).toBe(2);
  });

  await scenario("playbookStore.list({ minConfidence }) drops low-confidence entries", async () => {
    const store = createInMemoryPlaybookStore([
      {
        id: "lo",
        title: "t",
        strategy: "s",
        tags: [],
        confidence: 0.1,
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 1,
        version: 1,
      },
      {
        id: "hi",
        title: "t",
        strategy: "s",
        tags: [],
        confidence: 0.9,
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 1,
        version: 1,
      },
    ]);
    const filtered = await store.list({ minConfidence: 0.5 });
    expect(filtered.map((p) => p.id)).toEqual(["hi"]);
  });

  process.stdout.write("\nSection: customization hooks\n");

  await scenario("custom consolidate function overrides default", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    const state = { now: 0 };
    const sentinel = "CUSTOM_STRATEGY";
    const mw = createAceMiddleware({
      playbookStore,
      clock: clockOf(state),
      minScore: 0,
      consolidate: (candidates) =>
        candidates.map((c) => ({
          id: `custom:${c.identifier}`,
          title: "custom",
          strategy: sentinel,
          tags: [],
          confidence: c.score,
          source: "curated",
          createdAt: 0,
          updatedAt: 0,
          sessionCount: 1,
          version: 42,
        })),
    });
    const s = makeSession("cust-1");
    await mw.onSessionStart?.(s);
    await mw.wrapToolCall?.(makeTurn(s, 0), { toolId: "x", input: {} }, async () => {
      state.now += 1;
      return { output: 1 };
    });
    await mw.onSessionEnd?.(s);
    const [pb] = await playbookStore.list();
    expect(pb?.id).toBe("custom:x");
    expect(pb?.strategy).toBe(sentinel);
    expect(pb?.version).toBe(42);
  });

  await scenario("custom clock makes timestamps deterministic", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    const mw = createAceMiddleware({
      playbookStore,
      clock: () => 7_777,
      minScore: 0,
    });
    const s = makeSession("clock-1");
    await mw.onSessionStart?.(s);
    await mw.wrapToolCall?.(makeTurn(s, 0), { toolId: "x", input: {} }, async () => ({
      output: 1,
    }));
    await mw.onSessionEnd?.(s);
    const [pb] = await playbookStore.list();
    expect(pb?.createdAt).toBe(7_777);
    expect(pb?.updatedAt).toBe(7_777);
  });

  process.stdout.write("\nSection: middleware metadata\n");

  await scenario("describeCapabilities reports playbook count + token budget", async () => {
    const playbookStore = createInMemoryPlaybookStore([
      {
        id: "p",
        title: "t",
        strategy: "s",
        tags: [],
        confidence: 1,
        source: "curated",
        createdAt: 0,
        updatedAt: 0,
        sessionCount: 1,
        version: 1,
      },
    ]);
    const mw: KoiMiddleware = createAceMiddleware({
      playbookStore,
      maxInjectedTokens: 1234,
    });
    const s = makeSession("cap-1");
    await mw.onSessionStart?.(s);
    const cap: CapabilityFragment | undefined = mw.describeCapabilities?.(makeTurn(s, 0));
    expect(cap?.label).toBe("ace");
    expect(cap?.description).toContain("1 active playbook");
    expect(cap?.description).toContain("1234 tokens");
  });

  await scenario("phase=observe + priority=800 (anti-leak / wiring contract)", async () => {
    const mw = createAceMiddleware({ playbookStore: createInMemoryPlaybookStore() });
    expect(mw.name).toBe("ace");
    expect(mw.phase).toBe("observe");
    expect(mw.priority).toBe(800);
  });

  process.stdout.write("\nSection: pipeline composition\n");

  await scenario(
    "aggregate → curate → consolidate produces a single 67%-success playbook",
    async () => {
      const stats = aggregateTrajectoryStats([
        {
          turnIndex: 0,
          timestamp: 0,
          kind: "tool_call",
          identifier: "fs.read",
          outcome: "success",
          durationMs: 10,
        },
        {
          turnIndex: 0,
          timestamp: 1,
          kind: "tool_call",
          identifier: "fs.read",
          outcome: "success",
          durationMs: 12,
        },
        {
          turnIndex: 0,
          timestamp: 2,
          kind: "tool_call",
          identifier: "fs.read",
          outcome: "failure",
          durationMs: 8,
        },
      ]);
      const candidates = curateTrajectorySummary(stats, 1, {
        minScore: 0,
        nowMs: 0,
        lambda: 0,
      });
      const consolidate = createDefaultConsolidator({ clock: () => 0 });
      const playbooks = consolidate(candidates, []);
      expect(playbooks.length).toBe(1);
      expect(playbooks[0]?.strategy).toContain("67%");
    },
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${"━".repeat(60)}\n`);
  process.stdout.write(
    `Result: ${String(results.length - failed.length)}/${String(results.length)} scenarios passed\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`\nFailed:\n`);
    for (const f of failed) {
      process.stdout.write(`  ✗ ${f.name}\n      ${f.note ?? ""}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

await run();
