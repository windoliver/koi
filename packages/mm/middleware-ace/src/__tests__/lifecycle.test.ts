/**
 * Integration test — full session lifecycle.
 *
 * Start → 5 turns → end. Verify trajectories flushed, curation ran,
 * playbooks updated. Next session verifies playbook injection.
 */

import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import type {
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { createAceMiddleware } from "../ace.js";
import type { CuratorAdapter } from "../curator.js";
import type { ReflectorAdapter } from "../reflector.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "../stores.js";
import type { CurationCandidate, Playbook } from "../types.js";

function makeSessionCtx(sessionId: string): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: sessionId as never,
    runId: "run-1" as never,
    metadata: {},
  };
}

function makeTurnCtx(turnIndex: number): TurnContext {
  return {
    session: makeSessionCtx("s1"),
    turnIndex,
    turnId: `run-1:t${turnIndex}` as never,
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text: "hello" }],
        senderId: "user",
        timestamp: 1000,
      } satisfies InboundMessage,
    ],
    model: "gpt-4",
  };
}

function makeModelResponse(): ModelResponse {
  return {
    content: "response",
    model: "gpt-4",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function makeToolResponse(): ToolResponse {
  return { output: "done" };
}

describe("ACE lifecycle integration", () => {
  test("full session: record → flush → curate → consolidate", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const curated: CurationCandidate[] = [];

    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      clock: () => 1000,
      onCurate: (c) => curated.push(...c),
      consolidate: (candidates, _existing) =>
        candidates.map(
          (c): Playbook => ({
            id: `pb-${c.identifier}`,
            title: `Strategy for ${c.identifier}`,
            strategy: `${c.identifier} scored ${c.score.toFixed(2)}`,
            tags: [c.kind],
            confidence: c.score,
            source: "curated",
            createdAt: 1000,
            updatedAt: 1000,
            sessionCount: 1,
          }),
        ),
    });

    // Simulate 5 turns
    for (let i = 0; i < 5; i++) {
      const turnCtx = makeTurnCtx(i);
      await mw.wrapModelCall?.(turnCtx, makeModelRequest(), async () => makeModelResponse());
      await mw.wrapToolCall?.(turnCtx, { toolId: "read-file", input: {} }, async () =>
        makeToolResponse(),
      );
    }

    // End session
    await mw.onSessionEnd?.(makeSessionCtx("s1"));

    // Verify trajectory was persisted
    const entries = await trajectoryStore.getSession("s1");
    expect(entries).toHaveLength(10); // 5 model + 5 tool

    // Verify curation ran
    expect(curated.length).toBeGreaterThan(0);

    // Verify playbooks were consolidated
    const playbooks = await playbookStore.list();
    expect(playbooks.length).toBeGreaterThan(0);
  });

  test("second session gets playbooks injected from first", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();

    // Pre-populate a playbook (as if from a previous session)
    await playbookStore.save({
      id: "pb-cached",
      title: "Caching Strategy",
      strategy: "Always use caching for read-heavy ops",
      tags: [],
      confidence: 0.9,
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 3,
    });

    const injected: Playbook[] = [];
    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      clock: () => 2000,
      onInject: (pbs) => injected.push(...pbs),
    });

    const turnCtx = makeTurnCtx(0);
    let capturedMessages: readonly InboundMessage[] = [];

    await mw.wrapModelCall?.(turnCtx, makeModelRequest(), async (req) => {
      capturedMessages = req.messages;
      return makeModelResponse();
    });

    // Verify playbook was injected
    expect(injected).toHaveLength(1);
    expect(injected[0]?.id).toBe("pb-cached");

    // Verify message was prepended
    expect(capturedMessages.length).toBe(2);
    const first = capturedMessages[0];
    expect(first?.senderId).toBe("system:ace");
    const textBlock = first?.content[0];
    expect(textBlock?.kind).toBe("text");
    if (textBlock?.kind === "text") {
      expect(textBlock.text).toContain("Caching Strategy");
    }
  });

  test("empty session produces no side effects", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const curated: CurationCandidate[] = [];

    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      clock: () => 1000,
      onCurate: (c) => curated.push(...c),
    });

    await mw.onSessionEnd?.(makeSessionCtx("empty-session"));

    const entries = await trajectoryStore.getSession("empty-session");
    expect(entries).toHaveLength(0);
    expect(curated).toHaveLength(0);
  });

  test("tool failures are recorded in trajectory", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore: createInMemoryPlaybookStore(),
      clock: () => 1000,
    });

    const turnCtx = makeTurnCtx(0);
    try {
      await mw.wrapToolCall?.(turnCtx, { toolId: "bad-tool", input: {} }, async () => {
        throw new Error("kaboom");
      });
    } catch {
      // expected
    }

    await mw.onSessionEnd?.(makeSessionCtx("s-fail"));
    const entries = await trajectoryStore.getSession("s-fail");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("failure");
  });

  test("full session auto-consolidates without custom consolidate function", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const curated: CurationCandidate[] = [];

    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      clock: () => 1000,
      onCurate: (c) => curated.push(...c),
      // No consolidate function provided — default consolidator should kick in
    });

    // Simulate 5 turns to generate enough data
    for (let i = 0; i < 5; i++) {
      const turnCtx = makeTurnCtx(i);
      await mw.wrapModelCall?.(turnCtx, makeModelRequest(), async () => makeModelResponse());
      await mw.wrapToolCall?.(turnCtx, { toolId: "read-file", input: {} }, async () =>
        makeToolResponse(),
      );
    }

    await mw.onSessionEnd?.(makeSessionCtx("s-auto"));

    // Verify curation ran
    expect(curated.length).toBeGreaterThan(0);

    // Verify playbooks were auto-consolidated without a custom consolidate function
    const playbooks = await playbookStore.list();
    expect(playbooks.length).toBeGreaterThan(0);

    // Verify playbook IDs follow ace:<kind>:<identifier> format
    for (const pb of playbooks) {
      expect(pb.id).toMatch(/^ace:(tool_call|model_call):/);
      expect(pb.source).toBe("curated");
      expect(pb.sessionCount).toBe(1);
    }
  });

  test("buffer eviction callback fires when buffer is full", async () => {
    const evictions: number[] = [];
    const mw = createAceMiddleware({
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore: createInMemoryPlaybookStore(),
      clock: () => 1000,
      maxBufferEntries: 2,
      onBufferEvict: (count) => evictions.push(count),
    });

    const turnCtx = makeTurnCtx(0);
    // Fill buffer beyond capacity: 3 tool calls with buffer size 2
    for (let i = 0; i < 3; i++) {
      await mw.wrapToolCall?.(
        { ...turnCtx, turnIndex: i },
        { toolId: `tool-${i}`, input: {} },
        async () => makeToolResponse(),
      );
    }

    expect(evictions.length).toBeGreaterThan(0);
  });

  test("LLM pipeline: record → reflect → curate → persist structured playbook", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    let reflectCalled = false; // let: flag for reflector callback detection
    let curateCalled = false; // let: flag for curator callback detection

    const mockReflector: ReflectorAdapter = {
      async analyze() {
        reflectCalled = true;
        return {
          rootCause: "Tool calls sometimes fail",
          keyInsight: "Add retry logic for file operations",
          bulletTags: [],
        };
      },
    };

    const mockCurator: CuratorAdapter = {
      async curate() {
        curateCalled = true;
        return [
          { kind: "add" as const, section: "str", content: "Retry file operations on failure" },
        ];
      },
    };

    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      structuredPlaybookStore,
      reflector: mockReflector,
      curator: mockCurator,
      clock: () => 1000,
    });

    // Simulate turns
    for (let i = 0; i < 3; i++) {
      const turnCtx = makeTurnCtx(i);
      await mw.wrapModelCall?.(turnCtx, makeModelRequest(), async () => makeModelResponse());
      await mw.wrapToolCall?.(turnCtx, { toolId: "read-file", input: {} }, async () =>
        makeToolResponse(),
      );
    }

    // End session — stat pipeline runs synchronously, LLM pipeline fires-and-forgets
    await mw.onSessionEnd?.(makeSessionCtx("s-llm"));

    // Wait a tick for fire-and-forget to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify LLM pipeline ran
    expect(reflectCalled).toBe(true);
    expect(curateCalled).toBe(true);

    // Verify structured playbook was persisted
    const structuredPlaybooks = await structuredPlaybookStore.list();
    expect(structuredPlaybooks.length).toBeGreaterThan(0);

    // Verify the ADD operation was applied
    const pb = structuredPlaybooks[0];
    const strSection = pb.sections.find((s) => s.slug === "str");
    expect(strSection).toBeDefined();
    expect(strSection?.bullets.length).toBeGreaterThan(0);
    expect(strSection?.bullets.some((b) => b.content.includes("Retry"))).toBe(true);

    // Verify stat-based playbooks also created (both pipelines run)
    const statPlaybooks = await playbookStore.list();
    expect(statPlaybooks.length).toBeGreaterThan(0);
  });

  test("LLM pipeline failure does not block session end", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();

    const mockReflector: ReflectorAdapter = {
      async analyze() {
        throw new Error("LLM API down");
      },
    };

    const mockCurator: CuratorAdapter = {
      async curate() {
        return [];
      },
    };

    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      structuredPlaybookStore,
      reflector: mockReflector,
      curator: mockCurator,
      clock: () => 1000,
    });

    // Record entries
    const turnCtx = makeTurnCtx(0);
    await mw.wrapModelCall?.(turnCtx, makeModelRequest(), async () => makeModelResponse());

    // onSessionEnd should NOT throw even though LLM pipeline fails
    await mw.onSessionEnd?.(makeSessionCtx("s-llm-fail"));

    // Wait for fire-and-forget to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Stat-based playbooks should still be created
    const statPlaybooks = await playbookStore.list();
    expect(statPlaybooks.length).toBeGreaterThan(0);
  });
});
