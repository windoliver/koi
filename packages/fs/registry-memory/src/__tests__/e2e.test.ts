/**
 * End-to-end tests for memory registry with the full Koi runtime.
 *
 * Validates the memory AgentRegistry through createKoi (L1) + createPiAdapter
 * with real LLM calls. Exercises:
 *   - Agent registration in memory registry
 *   - Real LLM call through full middleware chain
 *   - Registry events emitted during agent lifecycle
 *   - Events persisted in backend (audit trail)
 *   - Projection rebuild from persisted events
 *   - Multi-agent scenarios with transitions
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during parallel runs.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  RegistryEntry,
  RegistryEvent,
} from "@koi/core";
import { agentId, evolveRegistryEntry, isAgentStateEvent } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemoryEventBackend } from "@koi/events-memory";
import { createMemoryRegistry } from "../memory-registry.js";
import { REGISTRY_INDEX_STREAM } from "../stream-ids.js";

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
  name: "event-sourced-e2e-agent",
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
    priority: 10,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: memory registry with real Anthropic API via createKoi + createPiAdapter", () => {
  // ── Test 1: Full lifecycle — register, run, verify events ──────────────

  test(
    "agent completes real LLM call with memory registry tracking lifecycle",
    async () => {
      // Create memory registry with in-memory backend
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      // Register the agent in the memory registry
      const agentEntry = makeEntry("e2e-agent-1");
      await registry.register(agentEntry);

      // Verify registration
      const registered = registry.lookup(agentId("e2e-agent-1"));
      expect(registered).toBeDefined();
      expect(registered?.status.phase).toBe("created");
      expect(registered?.status.generation).toBe(0);

      // Transition to running (simulating what L1 spawn-child does)
      const transResult = await registry.transition(agentId("e2e-agent-1"), "running", 0, {
        kind: "assembly_complete",
      });
      expect(transResult.ok).toBe(true);

      // Create Pi adapter + Koi runtime
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        middleware: [],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      // Run the agent with a real LLM call
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: hello-e2e" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.totalTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("hello");

      // Transition to terminated after completion
      const running = registry.lookup(agentId("e2e-agent-1"));
      expect(running?.status.phase).toBe("running");
      expect(running?.status.generation).toBe(1);

      const termResult = await registry.transition(agentId("e2e-agent-1"), "terminated", 1, {
        kind: "completed",
      });
      expect(termResult.ok).toBe(true);

      // Verify final state
      const terminated = registry.lookup(agentId("e2e-agent-1"));
      expect(terminated?.status.phase).toBe("terminated");
      expect(terminated?.status.generation).toBe(2);

      // Verify events are persisted in backend
      const streamResult = await backend.read("agent:e2e-agent-1");
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
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Registry watch fires during real agent lifecycle ────────────

  test(
    "registry watch emits events during real LLM agent lifecycle",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      // Collect registry events
      // let: collector mutated by watch callback
      const registryEvents: RegistryEvent[] = [];
      registry.watch((event) => registryEvents.push(event));

      // Register + transition
      await registry.register(makeEntry("e2e-watched"));
      await registry.transition(agentId("e2e-watched"), "running", 0, {
        kind: "assembly_complete",
      });

      // Run real LLM call
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: ok" }));

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      // Terminate
      await registry.transition(agentId("e2e-watched"), "terminated", 1, {
        kind: "completed",
      });

      // Verify all registry events captured
      expect(registryEvents).toHaveLength(3); // registered + running + terminated
      expect(registryEvents[0]?.kind).toBe("registered");
      expect(registryEvents[1]?.kind).toBe("transitioned");
      expect(registryEvents[2]?.kind).toBe("transitioned");

      if (registryEvents[1]?.kind === "transitioned") {
        expect(registryEvents[1].to).toBe("running");
        expect(registryEvents[1].reason.kind).toBe("assembly_complete");
      }
      if (registryEvents[2]?.kind === "transitioned") {
        expect(registryEvents[2].to).toBe("terminated");
        expect(registryEvents[2].reason.kind).toBe("completed");
      }

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Rebuild from persisted events after real agent run ──────────

  test(
    "rebuild from persisted events matches state after real agent run",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      // Full lifecycle: register → running → waiting → running → terminated
      await registry.register(makeEntry("e2e-rebuild"));
      await registry.transition(agentId("e2e-rebuild"), "running", 0, {
        kind: "assembly_complete",
      });

      // Run real LLM call during "running" phase
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply concisely.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: rebuild-test" }));
      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // More transitions
      await registry.transition(agentId("e2e-rebuild"), "waiting", 1, {
        kind: "awaiting_response",
      });
      await registry.transition(agentId("e2e-rebuild"), "running", 2, {
        kind: "response_received",
      });
      await registry.transition(agentId("e2e-rebuild"), "terminated", 3, {
        kind: "completed",
      });

      // Snapshot state before rebuild
      const beforeState = registry.lookup(agentId("e2e-rebuild"));
      expect(beforeState?.status.phase).toBe("terminated");
      expect(beforeState?.status.generation).toBe(4);

      // Rebuild projection from persisted events
      await registry.rebuild();

      // Verify rebuild matches
      const afterState = registry.lookup(agentId("e2e-rebuild"));
      expect(afterState?.status.phase).toBe(beforeState?.status.phase);
      expect(afterState?.status.generation).toBe(beforeState?.status.generation);
      expect(afterState?.agentId).toBe(beforeState?.agentId);

      // Create a completely fresh registry from the same backend
      const registry2 = await createMemoryRegistry(backend);
      const freshState = registry2.lookup(agentId("e2e-rebuild"));
      expect(freshState?.status.phase).toBe("terminated");
      expect(freshState?.status.generation).toBe(4);

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
      await registry2[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Multi-agent with shared backend ────────────────────────────

  test(
    "multi-agent lifecycle with shared event backend and real LLM calls",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      // Register two agents
      await registry.register(makeEntry("e2e-multi-1"));
      await registry.register(makeEntry("e2e-multi-2"));

      // Transition both to running
      await registry.transition(agentId("e2e-multi-1"), "running", 0, {
        kind: "assembly_complete",
      });
      await registry.transition(agentId("e2e-multi-2"), "running", 0, {
        kind: "assembly_complete",
      });

      // Run real LLM calls for both agents concurrently
      const createRuntime = async (name: string) => {
        const adapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt: `You are agent ${name}. Reply with your name only.`,
          getApiKey: async () => ANTHROPIC_KEY,
        });

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

      // Run both agents concurrently
      const [events1, events2] = await Promise.all([
        collectEvents(runtime1.run({ kind: "text", text: "Say your name" })),
        collectEvents(runtime2.run({ kind: "text", text: "Say your name" })),
      ]);

      expect(findDoneOutput(events1)?.stopReason).toBe("completed");
      expect(findDoneOutput(events2)?.stopReason).toBe("completed");

      // Terminate both
      await registry.transition(agentId("e2e-multi-1"), "terminated", 1, {
        kind: "completed",
      });
      await registry.transition(agentId("e2e-multi-2"), "terminated", 1, {
        kind: "completed",
      });

      // Verify both agents have their own event streams
      const stream1 = await backend.read("agent:e2e-multi-1");
      const stream2 = await backend.read("agent:e2e-multi-2");
      expect(stream1.ok).toBe(true);
      expect(stream2.ok).toBe(true);

      if (stream1.ok && stream2.ok) {
        // Each agent: registered + running + terminated = 3 events
        expect(stream1.value.events).toHaveLength(3);
        expect(stream2.value.events).toHaveLength(3);
      }

      // Verify list shows both
      const all = registry.list();
      expect(all).toHaveLength(2);
      expect(all.every((e) => e.status.phase === "terminated")).toBe(true);

      // Rebuild from fresh backend
      const registry2 = await createMemoryRegistry(backend);
      const freshAll = registry2.list();
      expect(freshAll).toHaveLength(2);
      expect(freshAll.every((e) => e.status.phase === "terminated")).toBe(true);

      await runtime1.dispose();
      await runtime2.dispose();
      await registry[Symbol.asyncDispose]();
      await registry2[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Middleware chain + registry combined ────────────────────────

  test(
    "middleware hooks fire during real LLM call with memory registry",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      await registry.register(makeEntry("e2e-mw"));
      await registry.transition(agentId("e2e-mw"), "running", 0, {
        kind: "assembly_complete",
      });

      // let: counters mutated by middleware callbacks
      let sessionStarted = false;
      let sessionEnded = false;
      let turnCount = 0;

      const observerMiddleware = {
        name: "e2e-observer",
        describeCapabilities: () => undefined,
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

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply concisely with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        middleware: [observerMiddleware],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: middleware-ok" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");
      expect(sessionStarted).toBe(true);
      expect(sessionEnded).toBe(true);
      expect(turnCount).toBeGreaterThanOrEqual(1);

      // Terminate in registry
      await registry.transition(agentId("e2e-mw"), "terminated", 1, {
        kind: "completed",
      });

      // Verify events persisted
      const stream = await backend.read("agent:e2e-mw");
      expect(stream.ok).toBe(true);
      if (stream.ok) {
        expect(stream.value.events).toHaveLength(3);

        // Verify fold of persisted events matches projection
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
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Deregister + rebuild (agent disappears) ────────────────────

  test(
    "deregistered agent is absent after rebuild with real LLM verification",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      // Register and run
      await registry.register(makeEntry("e2e-dereg"));
      await registry.transition(agentId("e2e-dereg"), "running", 0, {
        kind: "assembly_complete",
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Say: deregister-test" }),
      );
      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Deregister the agent
      const deregistered = await registry.deregister(agentId("e2e-dereg"));
      expect(deregistered).toBe(true);
      expect(registry.lookup(agentId("e2e-dereg"))).toBeUndefined();

      // Rebuild — agent should still be absent
      await registry.rebuild();
      expect(registry.lookup(agentId("e2e-dereg"))).toBeUndefined();
      expect(registry.list()).toHaveLength(0);

      // But events are preserved in the backend (audit trail)
      const stream = await backend.read("agent:e2e-dereg");
      expect(stream.ok).toBe(true);
      if (stream.ok) {
        expect(stream.value.events.length).toBeGreaterThanOrEqual(3);
        const types = stream.value.events.map((e) => e.type);
        expect(types).toContain("agent_registered");
        expect(types).toContain("agent_transitioned");
        expect(types).toContain("agent_deregistered");
      }

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: CAS conflict during concurrent transition after real run ───

  test(
    "CAS conflict detected during concurrent transitions after real LLM call",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      await registry.register(makeEntry("e2e-cas"));
      await registry.transition(agentId("e2e-cas"), "running", 0, {
        kind: "assembly_complete",
      });

      // Run real LLM call
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply concisely.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: cas-test" }));
      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      // Attempt concurrent transitions at generation 1
      const [r1, r2] = await Promise.all([
        registry.transition(agentId("e2e-cas"), "waiting", 1, {
          kind: "awaiting_response",
        }),
        registry.transition(agentId("e2e-cas"), "terminated", 1, {
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

      // Final state should be consistent
      const final = registry.lookup(agentId("e2e-cas"));
      expect(final?.status.generation).toBe(2);

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Token metrics verified through registry lifecycle ──────────

  test(
    "real LLM metrics are non-zero with memory registry tracking full lifecycle",
    async () => {
      const backend = createInMemoryEventBackend();
      const registry = await createMemoryRegistry(backend);

      await registry.register(makeEntry("e2e-metrics"));
      await registry.transition(agentId("e2e-metrics"), "running", 0, {
        kind: "assembly_complete",
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a math tutor. Explain clearly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "What is 2+2? Reply with just the answer." }),
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
      await registry.transition(agentId("e2e-metrics"), "terminated", 1, {
        kind: "completed",
      });

      // Verify everything persisted
      const stream = await backend.read("agent:e2e-metrics");
      expect(stream.ok).toBe(true);
      if (stream.ok) {
        expect(stream.value.events).toHaveLength(3);
      }

      await runtime.dispose();
      await registry[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );
});
