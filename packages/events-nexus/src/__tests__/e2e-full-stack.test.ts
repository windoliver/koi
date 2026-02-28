/**
 * End-to-end tests for Nexus event backend with the full Koi runtime.
 *
 * Validates @koi/events-nexus through createKoi (L1) + createPiAdapter
 * with real LLM calls. Exercises:
 *   - Full runtime assembly (createKoi + createPiAdapter + real Anthropic API)
 *   - Nexus event backend (createNexusEventBackend with fake fetch)
 *   - Event-sourced registry (createEventSourcedRegistry + nexus backend)
 *   - Middleware chain (observer fires wrapToolCall, onSessionStart/End)
 *   - Tool execution (LLM calls registered tool, flows through middleware)
 *   - Event persistence (events read back from nexus backend after agent run)
 *   - Subscription delivery (registry watch() receives live events)
 *   - OCC (CAS conflict during concurrent registry transitions)
 *   - Projection rebuild (fresh registry from same nexus backend)
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1 — skipped during parallel runs.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  RegistryEntry,
  RegistryEvent,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, evolveRegistryEntry, isAgentStateEvent, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createEventSourcedRegistry } from "@koi/registry-event-sourced";
import { createFakeNexusFetch } from "../fake-nexus-fetch.js";
import { createNexusEventBackend } from "../nexus-backend.js";

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
  name: "nexus-e2e-agent",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNexusBackend(): ReturnType<typeof createNexusEventBackend> {
  return createNexusEventBackend({
    baseUrl: "http://fake-nexus:2026",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  });
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E(
  "e2e: nexus event backend with real Anthropic API via createKoi + createPiAdapter",
  () => {
    // -- Test 1: Text response through full runtime ----------------------------

    test(
      "text response through full runtime with nexus-backed registry",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        // Register + transition to running
        const agentEntry = makeEntry("nexus-e2e-1");
        await registry.register(agentEntry);

        const registered = registry.lookup(agentId("nexus-e2e-1"));
        expect(registered).toBeDefined();
        expect(registered?.status.phase).toBe("created");

        await registry.transition(agentId("nexus-e2e-1"), "running", 0, {
          kind: "assembly_complete",
        });

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

        // Run with real LLM call
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with exactly: hello-nexus-e2e" }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");
        expect(output?.metrics.totalTokens).toBeGreaterThan(0);

        const text = extractText(events);
        expect(text.toLowerCase()).toContain("hello");

        // Transition to terminated
        const running = registry.lookup(agentId("nexus-e2e-1"));
        expect(running?.status.phase).toBe("running");
        expect(running?.status.generation).toBe(1);

        const termResult = await registry.transition(agentId("nexus-e2e-1"), "terminated", 1, {
          kind: "completed",
        });
        expect(termResult.ok).toBe(true);

        // Verify final state
        const terminated = registry.lookup(agentId("nexus-e2e-1"));
        expect(terminated?.status.phase).toBe("terminated");
        expect(terminated?.status.generation).toBe(2);

        // Verify events persisted in nexus backend
        const streamResult = await backend.read("agent:nexus-e2e-1");
        expect(streamResult.ok).toBe(true);
        if (streamResult.ok) {
          // registered + transitioned(running) + transitioned(terminated) = 3
          expect(streamResult.value.events).toHaveLength(3);
          const types = streamResult.value.events.map((e) => e.type);
          expect(types).toContain("agent_registered");
          expect(types).toContain("agent_transitioned");
        }

        await runtime.dispose();
        await registry[Symbol.asyncDispose]();
        backend.close();
      },
      TIMEOUT_MS,
    );

    // -- Test 2: Tool call through middleware chain -----------------------------

    test(
      "tool call flows through middleware chain with nexus-backed registry",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        await registry.register(makeEntry("nexus-e2e-tool"));
        await registry.transition(agentId("nexus-e2e-tool"), "running", 0, {
          kind: "assembly_complete",
        });

        // Track tool calls through middleware
        // let: collector mutated by middleware callback
        let toolCallObserved = false;
        let toolName = "";

        const toolObserver: KoiMiddleware = {
          name: "tool-observer",
          describeCapabilities: () => undefined,
          async wrapToolCall(
            _ctx,
            req: ToolRequest,
            next: (r: ToolRequest) => Promise<ToolResponse>,
          ) {
            toolCallObserved = true;
            toolName = req.toolId;
            return next(req);
          },
        };

        // Create tool via ECS ComponentProvider
        const getTimeTool: Tool = {
          descriptor: {
            name: "get_time",
            description: "Returns the current time as an ISO string.",
            inputSchema: { type: "object", properties: {} },
          },
          trustTier: "sandbox",
          execute: async () => "2026-01-15T10:30:00Z",
        };

        const toolProvider: ComponentProvider = {
          name: "nexus-e2e-tool-provider",
          attach: async () =>
            new Map([[toolToken(getTimeTool.descriptor.name) as string, getTimeTool]]),
        };

        const piAdapter = createPiAdapter({
          model: E2E_MODEL,
          systemPrompt:
            "You have a tool called get_time. When asked for the time, call it. Reply concisely.",
          getApiKey: async () => ANTHROPIC_KEY,
        });

        const runtime = await createKoi({
          manifest: E2E_MANIFEST,
          adapter: piAdapter,
          middleware: [toolObserver],
          providers: [toolProvider],
          loopDetection: false,
          limits: { maxTurns: 5, maxDurationMs: 55_000, maxTokens: 10_000 },
        });

        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What time is it? Use the get_time tool." }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");
        expect(toolCallObserved).toBe(true);
        expect(toolName).toBe("get_time");

        // Terminate in registry
        await registry.transition(agentId("nexus-e2e-tool"), "terminated", 1, {
          kind: "completed",
        });

        // Verify nexus backend persisted events
        const streamResult = await backend.read("agent:nexus-e2e-tool");
        expect(streamResult.ok).toBe(true);
        if (streamResult.ok) {
          expect(streamResult.value.events).toHaveLength(3);
        }

        await runtime.dispose();
        await registry[Symbol.asyncDispose]();
        backend.close();
      },
      TIMEOUT_MS,
    );

    // -- Test 3: Registry watch fires during lifecycle -------------------------

    test(
      "registry watch emits events via nexus-backed subscriptions",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        // Collect registry events
        // let: collector mutated by watch callback
        const registryEvents: RegistryEvent[] = [];
        registry.watch((event) => registryEvents.push(event));

        // Register + transition
        await registry.register(makeEntry("nexus-e2e-watched"));
        await registry.transition(agentId("nexus-e2e-watched"), "running", 0, {
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
        expect(findDoneOutput(events)?.stopReason).toBe("completed");

        // Terminate
        await registry.transition(agentId("nexus-e2e-watched"), "terminated", 1, {
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
        backend.close();
      },
      TIMEOUT_MS,
    );

    // -- Test 4: Rebuild from persisted nexus events ---------------------------

    test(
      "fresh registry from same nexus backend reconstructs state",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        // Full lifecycle: register -> running -> waiting -> running -> terminated
        await registry.register(makeEntry("nexus-e2e-rebuild"));
        await registry.transition(agentId("nexus-e2e-rebuild"), "running", 0, {
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

        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Say: rebuild-test" }),
        );
        expect(findDoneOutput(events)?.stopReason).toBe("completed");

        // More transitions
        await registry.transition(agentId("nexus-e2e-rebuild"), "waiting", 1, {
          kind: "awaiting_response",
        });
        await registry.transition(agentId("nexus-e2e-rebuild"), "running", 2, {
          kind: "response_received",
        });
        await registry.transition(agentId("nexus-e2e-rebuild"), "terminated", 3, {
          kind: "completed",
        });

        // Snapshot state before rebuild
        const beforeState = registry.lookup(agentId("nexus-e2e-rebuild"));
        expect(beforeState?.status.phase).toBe("terminated");
        expect(beforeState?.status.generation).toBe(4);

        // Rebuild projection from persisted events
        await registry.rebuild();

        // Verify rebuild matches
        const afterState = registry.lookup(agentId("nexus-e2e-rebuild"));
        expect(afterState?.status.phase).toBe(beforeState?.status.phase);
        expect(afterState?.status.generation).toBe(beforeState?.status.generation);
        expect(afterState?.agentId).toBe(beforeState?.agentId);

        // Create a completely fresh registry from the same nexus backend
        const registry2 = await createEventSourcedRegistry(backend);
        const freshState = registry2.lookup(agentId("nexus-e2e-rebuild"));
        expect(freshState?.status.phase).toBe("terminated");
        expect(freshState?.status.generation).toBe(4);

        await runtime.dispose();
        await registry[Symbol.asyncDispose]();
        await registry2[Symbol.asyncDispose]();
        backend.close();
      },
      TIMEOUT_MS,
    );

    // -- Test 5: Multi-agent concurrent lifecycle ------------------------------

    test(
      "two agents sharing nexus backend have independent streams",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        // Register two agents
        await registry.register(makeEntry("nexus-multi-1"));
        await registry.register(makeEntry("nexus-multi-2"));

        // Transition both to running
        await registry.transition(agentId("nexus-multi-1"), "running", 0, {
          kind: "assembly_complete",
        });
        await registry.transition(agentId("nexus-multi-2"), "running", 0, {
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
            manifest: { ...E2E_MANIFEST, name: `nexus-${name}` },
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
        await registry.transition(agentId("nexus-multi-1"), "terminated", 1, {
          kind: "completed",
        });
        await registry.transition(agentId("nexus-multi-2"), "terminated", 1, {
          kind: "completed",
        });

        // Verify both agents have their own event streams
        const stream1 = await backend.read("agent:nexus-multi-1");
        const stream2 = await backend.read("agent:nexus-multi-2");
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
        const registry2 = await createEventSourcedRegistry(backend);
        const freshAll = registry2.list();
        expect(freshAll).toHaveLength(2);
        expect(freshAll.every((e) => e.status.phase === "terminated")).toBe(true);

        await runtime1.dispose();
        await runtime2.dispose();
        await registry[Symbol.asyncDispose]();
        await registry2[Symbol.asyncDispose]();
        backend.close();
      },
      TIMEOUT_MS,
    );

    // -- Test 6: Middleware lifecycle hooks -------------------------------------

    test(
      "middleware lifecycle hooks fire with nexus-backed registry",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        await registry.register(makeEntry("nexus-e2e-mw"));
        await registry.transition(agentId("nexus-e2e-mw"), "running", 0, {
          kind: "assembly_complete",
        });

        // let: counters mutated by middleware callbacks
        let sessionStarted = false;
        let sessionEnded = false;
        let turnCount = 0;

        const observerMiddleware: KoiMiddleware = {
          name: "nexus-e2e-observer",
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

        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Say: middleware-ok" }),
        );

        expect(findDoneOutput(events)?.stopReason).toBe("completed");
        expect(sessionStarted).toBe(true);
        expect(sessionEnded).toBe(true);
        expect(turnCount).toBeGreaterThanOrEqual(1);

        // Terminate in registry
        await registry.transition(agentId("nexus-e2e-mw"), "terminated", 1, {
          kind: "completed",
        });

        // Verify events persisted in nexus backend
        const stream = await backend.read("agent:nexus-e2e-mw");
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
        backend.close();
      },
      TIMEOUT_MS,
    );

    // -- Test 7: CAS conflict on concurrent transitions ------------------------

    test(
      "CAS conflict detected during concurrent transitions with nexus backend",
      async () => {
        const backend = createNexusBackend();
        const registry = await createEventSourcedRegistry(backend);

        await registry.register(makeEntry("nexus-e2e-cas"));
        await registry.transition(agentId("nexus-e2e-cas"), "running", 0, {
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
          registry.transition(agentId("nexus-e2e-cas"), "waiting", 1, {
            kind: "awaiting_response",
          }),
          registry.transition(agentId("nexus-e2e-cas"), "terminated", 1, {
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
        const final = registry.lookup(agentId("nexus-e2e-cas"));
        expect(final?.status.generation).toBe(2);

        await runtime.dispose();
        await registry[Symbol.asyncDispose]();
        backend.close();
      },
      TIMEOUT_MS,
    );
  },
);
