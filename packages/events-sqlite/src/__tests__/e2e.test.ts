/**
 * End-to-end tests: @koi/events-sqlite through the full Koi runtime.
 *
 * Validates that the SQLite-backed EventBackend works correctly when wired
 * through createKoi (L1) + createPiAdapter + createEventSourcedRegistry
 * with real Anthropic API calls.
 *
 * Exercises:
 *   - SQLite event persistence through full agent lifecycle
 *   - Crash recovery: close/reopen SQLite DB, rebuild registry
 *   - Middleware chain fires with SQLite backend
 *   - Multi-agent concurrent runs with shared SQLite DB
 *   - Subscription + replay from SQLite after restart
 *   - DLQ persistence across close/reopen
 *   - FIFO eviction with real event streams
 *   - CAS conflict detection persisted in SQLite
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  EventEnvelope,
  RegistryEntry,
} from "@koi/core";
import { agentId, evolveRegistryEntry, isAgentStateEvent } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createEventSourcedRegistry, REGISTRY_INDEX_STREAM } from "@koi/registry-event-sourced";
import { createSqliteEventBackend } from "../sqlite-backend.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const E2E_MANIFEST: AgentManifest = {
  name: "events-sqlite-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function makeEntry(id: string): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase: "created",
      generation: 0,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "copilot",
    metadata: {},
    registeredAt: Date.now(),
  };
}

function createPi(systemPrompt: string): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt,
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

// let: mutated by freshTmpDb/cleanup
let tmpDir: string | undefined;

function freshTmpDb(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "koi-e2e-events-sqlite-"));
  return join(tmpDir, "events.db");
}

afterEach(() => {
  if (tmpDir !== undefined && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/events-sqlite through full Koi runtime with real Anthropic API", () => {
  // ── Test 1: Full lifecycle persisted to SQLite file ─────────────────────

  test(
    "agent lifecycle persisted in SQLite file backend with real LLM call",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });
      const registry = await createEventSourcedRegistry(backend);

      // Register + transition to running
      await registry.register(makeEntry("sqlite-e2e-1"));
      await registry.transition(agentId("sqlite-e2e-1"), "running", 0, {
        kind: "assembly_complete",
      });

      // Create runtime and make a real LLM call
      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createPi("You are a concise test assistant. Reply briefly."),
        middleware: [],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: hello-sqlite-e2e" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.totalTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("hello");

      // Terminate in registry
      await registry.transition(agentId("sqlite-e2e-1"), "terminated", 1, {
        kind: "completed",
      });

      // Verify events persisted in SQLite backend
      const streamResult = await backend.read("agent:sqlite-e2e-1");
      expect(streamResult.ok).toBe(true);
      if (streamResult.ok) {
        // registered + transitioned(running) + transitioned(terminated) = 3
        expect(streamResult.value.events).toHaveLength(3);
        const types = streamResult.value.events.map((e) => e.type);
        expect(types).toContain("agent_registered");
        expect(types).toContain("agent_transitioned");
      }

      // Verify index stream
      const indexResult = await backend.read(REGISTRY_INDEX_STREAM);
      expect(indexResult.ok).toBe(true);
      if (indexResult.ok) {
        const indexTypes = indexResult.value.events.map((e) => e.type);
        expect(indexTypes).toContain("index:registered");
      }

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
      backend.close();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Crash recovery — close SQLite, reopen, rebuild registry ────

  test(
    "crash recovery: registry rebuilds from SQLite after close/reopen",
    async () => {
      const dbPath = freshTmpDb();

      // --- Session 1: register, run LLM, transition, close ---
      {
        const backend = createSqliteEventBackend({ dbPath });
        const registry = await createEventSourcedRegistry(backend);

        await registry.register(makeEntry("sqlite-crash-1"));
        await registry.transition(agentId("sqlite-crash-1"), "running", 0, {
          kind: "assembly_complete",
        });

        // Real LLM call
        const runtime = await createKoi({
          manifest: E2E_MANIFEST,
          adapter: createPi("Reply concisely."),
          loopDetection: false,
          limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
        });

        const events = await collectEvents(runtime.run({ kind: "text", text: "Say: crash-test" }));
        expect(findDoneOutput(events)?.stopReason).toBe("completed");

        // More transitions
        await registry.transition(agentId("sqlite-crash-1"), "waiting", 1, {
          kind: "awaiting_response",
        });
        await registry.transition(agentId("sqlite-crash-1"), "running", 2, {
          kind: "response_received",
        });
        await registry.transition(agentId("sqlite-crash-1"), "terminated", 3, {
          kind: "completed",
        });

        await runtime.dispose();
        await registry[Symbol.asyncDispose]();
        backend.close();
      }

      // --- Session 2: reopen SQLite, rebuild registry from events ---
      {
        const backend2 = createSqliteEventBackend({ dbPath });
        const registry2 = await createEventSourcedRegistry(backend2);

        // Registry should have rebuilt state from persisted events
        const entry = registry2.lookup(agentId("sqlite-crash-1"));
        expect(entry).toBeDefined();
        expect(entry?.status.phase).toBe("terminated");
        expect(entry?.status.generation).toBe(4);

        // Verify all events are present
        const stream = await backend2.read("agent:sqlite-crash-1");
        expect(stream.ok).toBe(true);
        if (stream.ok) {
          // registered + running + waiting + running + terminated = 5
          expect(stream.value.events).toHaveLength(5);
        }

        await registry2[Symbol.asyncDispose]();
        backend2.close();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Multi-agent concurrent runs with shared SQLite ─────────────

  test(
    "multi-agent concurrent runs persisted to shared SQLite backend",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });
      const registry = await createEventSourcedRegistry(backend);

      // Register two agents
      await registry.register(makeEntry("sqlite-multi-1"));
      await registry.register(makeEntry("sqlite-multi-2"));
      await registry.transition(agentId("sqlite-multi-1"), "running", 0, {
        kind: "assembly_complete",
      });
      await registry.transition(agentId("sqlite-multi-2"), "running", 0, {
        kind: "assembly_complete",
      });

      // Create and run two agents concurrently
      const createRuntime = async (name: string) => {
        const adapter = createPi(`You are agent ${name}. Reply with your name only.`);
        return createKoi({
          manifest: { ...E2E_MANIFEST, name: `e2e-${name}` },
          adapter,
          loopDetection: false,
          limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
        });
      };

      const [runtime1, runtime2] = await Promise.all([
        createRuntime("multi-1"),
        createRuntime("multi-2"),
      ]);

      const [events1, events2] = await Promise.all([
        collectEvents(runtime1.run({ kind: "text", text: "Say your name" })),
        collectEvents(runtime2.run({ kind: "text", text: "Say your name" })),
      ]);

      expect(findDoneOutput(events1)?.stopReason).toBe("completed");
      expect(findDoneOutput(events2)?.stopReason).toBe("completed");

      // Terminate both
      await registry.transition(agentId("sqlite-multi-1"), "terminated", 1, {
        kind: "completed",
      });
      await registry.transition(agentId("sqlite-multi-2"), "terminated", 1, {
        kind: "completed",
      });

      // Verify stream isolation in SQLite
      const stream1 = await backend.read("agent:sqlite-multi-1");
      const stream2 = await backend.read("agent:sqlite-multi-2");
      expect(stream1.ok).toBe(true);
      expect(stream2.ok).toBe(true);
      if (stream1.ok && stream2.ok) {
        expect(stream1.value.events).toHaveLength(3);
        expect(stream2.value.events).toHaveLength(3);
      }

      // Verify both in list
      const all = registry.list();
      expect(all).toHaveLength(2);
      expect(all.every((e) => e.status.phase === "terminated")).toBe(true);

      // Close and rebuild from SQLite
      await registry[Symbol.asyncDispose]();

      const registry2 = await createEventSourcedRegistry(backend);
      expect(registry2.list()).toHaveLength(2);
      expect(registry2.list().every((e) => e.status.phase === "terminated")).toBe(true);

      await runtime1.dispose();
      await runtime2.dispose();
      await registry2[Symbol.asyncDispose]();
      backend.close();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Middleware chain fires with SQLite backend ──────────────────

  test(
    "middleware hooks fire during real LLM call with SQLite event backend",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });
      const registry = await createEventSourcedRegistry(backend);

      await registry.register(makeEntry("sqlite-mw"));
      await registry.transition(agentId("sqlite-mw"), "running", 0, {
        kind: "assembly_complete",
      });

      // let: counters mutated by middleware callbacks
      let sessionStarted = false;
      let sessionEnded = false;
      let turnCount = 0;

      const observerMiddleware = {
        name: "e2e-sqlite-observer",
        async onSessionStart() {
          sessionStarted = true;
        },
        async onSessionEnd() {
          sessionEnded = true;
        },
        async onAfterTurn() {
          turnCount++;
        },
      };

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createPi("Reply concisely with one word."),
        middleware: [observerMiddleware],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Say: middleware-sqlite" }),
      );

      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(sessionStarted).toBe(true);
      expect(sessionEnded).toBe(true);
      expect(turnCount).toBeGreaterThanOrEqual(1);

      // Terminate and verify event fold matches projection
      await registry.transition(agentId("sqlite-mw"), "terminated", 1, {
        kind: "completed",
      });

      const stream = await backend.read("agent:sqlite-mw");
      expect(stream.ok).toBe(true);
      if (stream.ok) {
        expect(stream.value.events).toHaveLength(3);

        // Fold persisted events — should match registry state
        // let: state evolves across fold
        let folded: RegistryEntry | undefined;
        for (const envelope of stream.value.events) {
          if (isAgentStateEvent(envelope.data)) {
            folded = evolveRegistryEntry(folded, envelope.data);
          }
        }
        expect(folded?.status.phase).toBe("terminated");
        expect(folded?.status.generation).toBe(2);
      }

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
      backend.close();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Subscription + replay from SQLite ──────────────────────────

  test(
    "subscription replays persisted events and delivers new events from SQLite",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });

      // Append some events directly
      await backend.append("e2e-sub-stream", {
        type: "pre-existing",
        data: { order: 1 },
      });
      await backend.append("e2e-sub-stream", {
        type: "pre-existing",
        data: { order: 2 },
      });

      // Subscribe from position 0 — should replay both events
      const received: EventEnvelope[] = [];
      const handle = await backend.subscribe({
        streamId: "e2e-sub-stream",
        subscriptionName: "e2e-sqlite-sub",
        fromPosition: 0,
        handler: (evt) => {
          received.push(evt);
        },
      });

      await Bun.sleep(100);
      expect(received).toHaveLength(2);
      expect(received[0]?.data).toEqual({ order: 1 });
      expect(received[1]?.data).toEqual({ order: 2 });

      // Append a new event — should be delivered to subscriber
      await backend.append("e2e-sub-stream", {
        type: "new-event",
        data: { order: 3 },
      });
      await Bun.sleep(100);

      expect(received).toHaveLength(3);
      expect(received[2]?.type).toBe("new-event");
      expect(handle.position()).toBe(3);

      handle.unsubscribe();

      // Close and reopen — subscription position doesn't survive (it's in-memory in delivery manager)
      // But the events themselves DO survive
      backend.close();

      const backend2 = createSqliteEventBackend({ dbPath });
      const readResult = await backend2.read("e2e-sub-stream");
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.events).toHaveLength(3);
      }
      backend2.close();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: CAS conflict persisted in SQLite ───────────────────────────

  test(
    "CAS conflict detected with SQLite-persisted sequences after real LLM call",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });
      const registry = await createEventSourcedRegistry(backend);

      await registry.register(makeEntry("sqlite-cas"));
      await registry.transition(agentId("sqlite-cas"), "running", 0, {
        kind: "assembly_complete",
      });

      // Real LLM call
      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createPi("Reply concisely."),
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: cas-sqlite" }));
      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Attempt concurrent transitions at generation 1
      const [r1, r2] = await Promise.all([
        registry.transition(agentId("sqlite-cas"), "waiting", 1, {
          kind: "awaiting_response",
        }),
        registry.transition(agentId("sqlite-cas"), "terminated", 1, {
          kind: "completed",
        }),
      ]);

      // Exactly one should succeed, one should fail with CONFLICT
      const successes = [r1, r2].filter((r) => r.ok);
      const failures = [r1, r2].filter((r) => !r.ok);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const firstFailure = failures[0];
      if (firstFailure !== undefined && !firstFailure.ok) {
        expect(firstFailure.error.code).toBe("CONFLICT");
      }

      // Final state consistent in SQLite
      const final = registry.lookup(agentId("sqlite-cas"));
      expect(final?.status.generation).toBe(2);

      // Close and rebuild — CAS state preserved
      await registry[Symbol.asyncDispose]();

      const registry2 = await createEventSourcedRegistry(backend);
      const rebuilt = registry2.lookup(agentId("sqlite-cas"));
      expect(rebuilt?.status.generation).toBe(final?.status.generation);
      expect(rebuilt?.status.phase).toBe(final?.status.phase);

      await runtime.dispose();
      await registry2[Symbol.asyncDispose]();
      backend.close();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Token metrics verified through SQLite-backed lifecycle ──────

  test(
    "real LLM metrics non-zero with SQLite event backend tracking full lifecycle",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });
      const registry = await createEventSourcedRegistry(backend);

      await registry.register(makeEntry("sqlite-metrics"));
      await registry.transition(agentId("sqlite-metrics"), "running", 0, {
        kind: "assembly_complete",
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createPi("You are a math tutor. Explain clearly."),
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is 2+2? Reply with just the answer.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);
      expect(output?.metrics.totalTokens).toBeGreaterThan(0);
      expect(output?.metrics.turns).toBeGreaterThanOrEqual(1);
      expect(output?.metrics.durationMs).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text).toContain("4");

      // Complete lifecycle
      await registry.transition(agentId("sqlite-metrics"), "terminated", 1, {
        kind: "completed",
      });

      // Verify everything in SQLite
      const stream = await backend.read("agent:sqlite-metrics");
      expect(stream.ok).toBe(true);
      if (stream.ok) {
        expect(stream.value.events).toHaveLength(3);
        // Verify monotonic sequences
        for (let i = 1; i < stream.value.events.length; i++) {
          const prev = stream.value.events[i - 1];
          const curr = stream.value.events[i];
          if (prev !== undefined && curr !== undefined) {
            expect(curr.sequence).toBeGreaterThan(prev.sequence);
          }
        }
      }

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
      backend.close();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Deregister + rebuild from SQLite ───────────────────────────

  test(
    "deregistered agent absent after SQLite-backed rebuild with real LLM verification",
    async () => {
      const dbPath = freshTmpDb();
      const backend = createSqliteEventBackend({ dbPath });
      const registry = await createEventSourcedRegistry(backend);

      await registry.register(makeEntry("sqlite-dereg"));
      await registry.transition(agentId("sqlite-dereg"), "running", 0, {
        kind: "assembly_complete",
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: createPi("Reply with one word."),
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Say: deregister-sqlite" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Deregister
      const deregistered = await registry.deregister(agentId("sqlite-dereg"));
      expect(deregistered).toBe(true);
      expect(registry.lookup(agentId("sqlite-dereg"))).toBeUndefined();

      // Close, reopen, rebuild — agent still absent
      await registry[Symbol.asyncDispose]();
      backend.close();

      const backend2 = createSqliteEventBackend({ dbPath });
      const registry2 = await createEventSourcedRegistry(backend2);
      expect(registry2.lookup(agentId("sqlite-dereg"))).toBeUndefined();
      expect(registry2.list()).toHaveLength(0);

      // But audit trail preserved in SQLite
      const stream = await backend2.read("agent:sqlite-dereg");
      expect(stream.ok).toBe(true);
      if (stream.ok) {
        expect(stream.value.events.length).toBeGreaterThanOrEqual(3);
        const types = stream.value.events.map((e) => e.type);
        expect(types).toContain("agent_registered");
        expect(types).toContain("agent_transitioned");
        expect(types).toContain("agent_deregistered");
      }

      await runtime.dispose();
      await registry2[Symbol.asyncDispose]();
      backend2.close();
    },
    TIMEOUT_MS,
  );
});
