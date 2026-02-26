/**
 * Reusable contract test suite for event-sourced AgentRegistry implementations.
 *
 * Validates both standard AgentRegistry behavior and event-sourcing invariants:
 * - Events are persisted and readable from the backend
 * - rebuild() produces identical state to the original
 * - Concurrent transitions respect optimistic concurrency
 *
 * Accepts a factory that returns a registry + its underlying EventBackend.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentId,
  AgentStateEvent,
  EventBackend,
  KoiError,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  Result,
  TransitionReason,
} from "@koi/core";
import { agentId, evolveRegistryEntry, isAgentStateEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

/** Registry with a rebuild method for event-sourcing tests. */
export interface EventSourcedRegistryForTest {
  readonly register: (entry: RegistryEntry) => RegistryEntry | Promise<RegistryEntry>;
  readonly deregister: (agentId: AgentId) => boolean | Promise<boolean>;
  readonly lookup: (
    agentId: AgentId,
  ) => RegistryEntry | undefined | Promise<RegistryEntry | undefined>;
  readonly list: (filter?: {
    readonly phase?: ProcessState;
  }) => readonly RegistryEntry[] | Promise<readonly RegistryEntry[]>;
  readonly transition: (
    agentId: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ) => Result<RegistryEntry, KoiError> | Promise<Result<RegistryEntry, KoiError>>;
  readonly watch: (listener: (event: RegistryEvent) => void) => () => void;
  readonly rebuild: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => PromiseLike<void>;
}

export interface EventSourcedRegistryTestContext {
  readonly registry: EventSourcedRegistryForTest;
  readonly backend: EventBackend;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(id: string, phase: ProcessState = "created", generation = 0): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase,
      generation,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

/**
 * Run the event-sourced AgentRegistry contract test suite.
 *
 * The factory should return a fresh registry + backend pair for each test.
 */
export function runEventSourcedRegistryContractTests(
  createContext: () => EventSourcedRegistryTestContext | Promise<EventSourcedRegistryTestContext>,
): void {
  describe("EventSourcedRegistry contract", () => {
    let ctx: EventSourcedRegistryTestContext;

    beforeEach(async () => {
      ctx = await createContext();
    });

    // -----------------------------------------------------------------------
    // Basic CRUD (mirrors InMemoryRegistry tests)
    // -----------------------------------------------------------------------

    describe("basic CRUD", () => {
      test("register stores and returns entry", async () => {
        const e = entry("agent-1");
        const stored = await ctx.registry.register(e);
        expect(stored.agentId).toBe(agentId("agent-1"));
      });

      test("lookup returns registered entry", async () => {
        await ctx.registry.register(entry("agent-1"));
        const found = await ctx.registry.lookup(agentId("agent-1"));
        expect(found).toBeDefined();
        expect(found?.agentId).toBe(agentId("agent-1"));
      });

      test("lookup returns undefined for unknown agent", async () => {
        const found = await ctx.registry.lookup(agentId("ghost"));
        expect(found).toBeUndefined();
      });

      test("deregister removes agent and returns true", async () => {
        await ctx.registry.register(entry("agent-1"));
        const removed = await ctx.registry.deregister(agentId("agent-1"));
        expect(removed).toBe(true);
        expect(await ctx.registry.lookup(agentId("agent-1"))).toBeUndefined();
      });

      test("deregister returns false for unknown agent", async () => {
        const removed = await ctx.registry.deregister(agentId("ghost"));
        expect(removed).toBe(false);
      });

      test("list returns all agents when no filter", async () => {
        await ctx.registry.register(entry("a1"));
        await ctx.registry.register(entry("a2"));
        await ctx.registry.register(entry("a3"));
        const all = await ctx.registry.list();
        expect(all).toHaveLength(3);
      });

      test("list filters by phase", async () => {
        await ctx.registry.register(entry("a1", "created"));
        // Transition a2 to running
        await ctx.registry.register(entry("a2", "created"));
        await ctx.registry.transition(agentId("a2"), "running", 0, { kind: "assembly_complete" });

        const created = await ctx.registry.list({ phase: "created" });
        expect(created).toHaveLength(1);
      });
    });

    // -----------------------------------------------------------------------
    // Transition (CAS)
    // -----------------------------------------------------------------------

    describe("transition with CAS", () => {
      test("transition with correct generation succeeds", async () => {
        await ctx.registry.register(entry("a1", "created", 0));
        const result = await ctx.registry.transition(agentId("a1"), "running", 0, {
          kind: "assembly_complete",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status.phase).toBe("running");
          expect(result.value.status.generation).toBe(1);
        }
      });

      test("transition with stale generation returns CONFLICT", async () => {
        await ctx.registry.register(entry("a1", "created", 0));
        // First transition succeeds: gen 0 → 1
        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        // Second transition with stale gen 0 should fail
        const result = await ctx.registry.transition(agentId("a1"), "waiting", 0, {
          kind: "awaiting_response",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("CONFLICT");
        }
      });

      test("transition on unknown agent returns NOT_FOUND", async () => {
        const result = await ctx.registry.transition(agentId("ghost"), "running", 0, {
          kind: "assembly_complete",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_FOUND");
        }
      });

      test("invalid transition returns VALIDATION error", async () => {
        await ctx.registry.register(entry("a1", "created", 0));
        const result = await ctx.registry.transition(agentId("a1"), "waiting", 0, {
          kind: "awaiting_response",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("VALIDATION");
        }
      });
    });

    // -----------------------------------------------------------------------
    // Watch notifications
    // -----------------------------------------------------------------------

    describe("watch notifications", () => {
      test("watch fires on register", async () => {
        const events: RegistryEvent[] = [];
        ctx.registry.watch((event) => events.push(event));

        await ctx.registry.register(entry("a1"));

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("registered");
      });

      test("watch fires on deregister", async () => {
        await ctx.registry.register(entry("a1"));

        const events: RegistryEvent[] = [];
        ctx.registry.watch((event) => events.push(event));
        await ctx.registry.deregister(agentId("a1"));

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("deregistered");
      });

      test("watch fires on successful transition with reason", async () => {
        await ctx.registry.register(entry("a1", "created", 0));

        const events: RegistryEvent[] = [];
        ctx.registry.watch((event) => events.push(event));

        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });

        expect(events).toHaveLength(1);
        expect(events[0]?.kind).toBe("transitioned");
        if (events[0]?.kind === "transitioned") {
          expect(events[0].from).toBe("created");
          expect(events[0].to).toBe("running");
          expect(events[0].generation).toBe(1);
          expect(events[0].reason.kind).toBe("assembly_complete");
        }
      });

      test("unsubscribe stops notifications", async () => {
        const events: RegistryEvent[] = [];
        const unsub = ctx.registry.watch((event) => events.push(event));

        await ctx.registry.register(entry("a1"));
        expect(events).toHaveLength(1);

        unsub();

        await ctx.registry.register(entry("a2"));
        expect(events).toHaveLength(1); // no new event
      });
    });

    // -----------------------------------------------------------------------
    // Event-sourcing invariants
    // -----------------------------------------------------------------------

    describe("event-sourcing invariants", () => {
      test("events are persisted in the backend", async () => {
        await ctx.registry.register(entry("a1", "created", 0));
        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });

        // Read events from the agent's stream
        const result = await ctx.backend.read("agent:a1");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.events.length).toBeGreaterThanOrEqual(2);
          const types = result.value.events.map((e) => e.type);
          expect(types).toContain("agent_registered");
          expect(types).toContain("agent_transitioned");
        }
      });

      test("rebuild produces identical state to pre-rebuild", async () => {
        // Register and transition multiple agents
        await ctx.registry.register(entry("a1", "created", 0));
        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await ctx.registry.transition(agentId("a1"), "waiting", 1, { kind: "awaiting_response" });

        await ctx.registry.register(entry("a2", "created", 0));
        await ctx.registry.transition(agentId("a2"), "running", 0, { kind: "assembly_complete" });

        // Snapshot state before rebuild
        const beforeA1 = await ctx.registry.lookup(agentId("a1"));
        const beforeA2 = await ctx.registry.lookup(agentId("a2"));
        const beforeList = await ctx.registry.list();

        // Rebuild from events
        await ctx.registry.rebuild();

        // Verify state matches
        const afterA1 = await ctx.registry.lookup(agentId("a1"));
        const afterA2 = await ctx.registry.lookup(agentId("a2"));
        const afterList = await ctx.registry.list();

        expect(afterA1?.status.phase).toBe(beforeA1?.status.phase);
        expect(afterA1?.status.generation).toBe(beforeA1?.status.generation);
        expect(afterA2?.status.phase).toBe(beforeA2?.status.phase);
        expect(afterA2?.status.generation).toBe(beforeA2?.status.generation);
        expect(afterList).toHaveLength(beforeList.length);
      });

      test("deregistered agent events are preserved in backend (audit trail)", async () => {
        await ctx.registry.register(entry("a1", "created", 0));
        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await ctx.registry.deregister(agentId("a1"));

        // Agent is gone from projection
        expect(await ctx.registry.lookup(agentId("a1"))).toBeUndefined();

        // But events are still in the backend
        const result = await ctx.backend.read("agent:a1");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.events.length).toBeGreaterThanOrEqual(3);
          const types = result.value.events.map((e) => e.type);
          expect(types).toContain("agent_deregistered");
        }
      });

      test("fold of persisted events matches projection state", async () => {
        await ctx.registry.register(entry("a1", "created", 0));
        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await ctx.registry.transition(agentId("a1"), "waiting", 1, { kind: "awaiting_response" });

        // Get state from projection
        const projected = await ctx.registry.lookup(agentId("a1"));

        // Manually fold events from backend
        const result = await ctx.backend.read("agent:a1");
        expect(result.ok).toBe(true);
        if (result.ok) {
          // let: state evolves across fold
          let folded: RegistryEntry | undefined;
          for (const envelope of result.value.events) {
            if (isAgentStateEvent(envelope.data)) {
              folded = evolveRegistryEntry(folded, envelope.data);
            }
          }

          expect(folded?.status.phase).toBe(projected?.status.phase);
          expect(folded?.status.generation).toBe(projected?.status.generation);
        }
      });

      test("multi-agent interleaved transitions then rebuild", async () => {
        // Register 3 agents
        await ctx.registry.register(entry("a1", "created", 0));
        await ctx.registry.register(entry("a2", "created", 0));
        await ctx.registry.register(entry("a3", "created", 0));

        // Interleaved transitions
        await ctx.registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
        await ctx.registry.transition(agentId("a2"), "running", 0, { kind: "assembly_complete" });
        await ctx.registry.transition(agentId("a1"), "waiting", 1, { kind: "awaiting_response" });
        await ctx.registry.transition(agentId("a3"), "running", 0, { kind: "assembly_complete" });
        await ctx.registry.transition(agentId("a2"), "terminated", 1, { kind: "completed" });

        // Snapshot state
        const beforeA1 = await ctx.registry.lookup(agentId("a1"));
        const beforeA2 = await ctx.registry.lookup(agentId("a2"));
        const beforeA3 = await ctx.registry.lookup(agentId("a3"));

        // Rebuild
        await ctx.registry.rebuild();

        // Verify
        const afterA1 = await ctx.registry.lookup(agentId("a1"));
        const afterA2 = await ctx.registry.lookup(agentId("a2"));
        const afterA3 = await ctx.registry.lookup(agentId("a3"));

        expect(afterA1?.status.phase).toBe(beforeA1?.status.phase);
        expect(afterA2?.status.phase).toBe(beforeA2?.status.phase);
        expect(afterA3?.status.phase).toBe(beforeA3?.status.phase);
      });
    });

    // -----------------------------------------------------------------------
    // Concurrency stress tests
    // -----------------------------------------------------------------------

    describe("concurrency", () => {
      test("N=10 concurrent transitions — exactly one succeeds per generation", async () => {
        await ctx.registry.register(entry("race-1", "created", 0));

        // CAS invariant: even under concurrent JS Promise scheduling,
        // only one transition per generation should succeed.
        const promises = Array.from({ length: 10 }, () =>
          Promise.resolve(
            ctx.registry.transition(agentId("race-1"), "running", 0, {
              kind: "assembly_complete",
            }),
          ),
        );

        const results = await Promise.all(promises);
        const successes = results.filter((r) => r.ok);
        const failures = results.filter((r) => !r.ok);

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(9);

        // Verify final state is consistent
        const final = await ctx.registry.lookup(agentId("race-1"));
        expect(final?.status.phase).toBe("running");
        expect(final?.status.generation).toBe(1);
      });

      test("event stream has no duplicates after concurrent attempts", async () => {
        await ctx.registry.register(entry("race-2", "created", 0));

        // Fire 5 concurrent transitions
        const promises = Array.from({ length: 5 }, () =>
          ctx.registry.transition(agentId("race-2"), "running", 0, {
            kind: "assembly_complete",
          }),
        );
        await Promise.all(promises);

        // Read events from backend — should have exactly 2 (register + 1 transition)
        const result = await ctx.backend.read("agent:race-2");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.events).toHaveLength(2);
        }
      });

      test("final state matches sequential fold of persisted events", async () => {
        await ctx.registry.register(entry("race-3", "created", 0));

        // Concurrent transitions
        const promises = Array.from({ length: 10 }, () =>
          ctx.registry.transition(agentId("race-3"), "running", 0, {
            kind: "assembly_complete",
          }),
        );
        await Promise.all(promises);

        // Get projection state
        const projected = await ctx.registry.lookup(agentId("race-3"));

        // Fold events from backend
        const result = await ctx.backend.read("agent:race-3");
        expect(result.ok).toBe(true);
        if (result.ok) {
          // let: state evolves across fold
          let folded: RegistryEntry | undefined;
          for (const envelope of result.value.events) {
            if (isAgentStateEvent(envelope.data)) {
              folded = evolveRegistryEntry(folded, envelope.data);
            }
          }

          expect(folded?.status.phase).toBe(projected?.status.phase);
          expect(folded?.status.generation).toBe(projected?.status.generation);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Golden fixture tests (schema stability)
    // -----------------------------------------------------------------------

    describe("golden fixtures — schema stability", () => {
      test("registered event folds to expected entry", () => {
        const event: AgentStateEvent = {
          kind: "agent_registered",
          agentId: agentId("golden-1"),
          agentType: "worker",
          metadata: { env: "test" },
          registeredAt: 1706140800000,
        };

        const result = evolveRegistryEntry(undefined, event);

        expect(result).toEqual({
          agentId: agentId("golden-1"),
          agentType: "worker",
          metadata: { env: "test" },
          registeredAt: 1706140800000,
          status: {
            phase: "created",
            generation: 0,
            conditions: [],
            lastTransitionAt: 1706140800000,
          },
        });
      });

      test("registered event with parentId folds correctly", () => {
        const event: AgentStateEvent = {
          kind: "agent_registered",
          agentId: agentId("golden-child"),
          agentType: "copilot",
          parentId: agentId("golden-parent"),
          metadata: {},
          registeredAt: 1706140800000,
        };

        const result = evolveRegistryEntry(undefined, event);

        expect(result).toEqual({
          agentId: agentId("golden-child"),
          agentType: "copilot",
          parentId: agentId("golden-parent"),
          metadata: {},
          registeredAt: 1706140800000,
          status: {
            phase: "created",
            generation: 0,
            conditions: [],
            lastTransitionAt: 1706140800000,
          },
        });
      });

      test("transitioned event folds to expected state", () => {
        const registered: AgentStateEvent = {
          kind: "agent_registered",
          agentId: agentId("golden-2"),
          agentType: "worker",
          metadata: {},
          registeredAt: 1706140800000,
        };

        const transitioned: AgentStateEvent = {
          kind: "agent_transitioned",
          agentId: agentId("golden-2"),
          from: "created",
          to: "running",
          generation: 1,
          reason: { kind: "assembly_complete" },
          conditions: ["Initialized"],
          transitionedAt: 1706140801000,
        };

        const state = evolveRegistryEntry(undefined, registered);
        const result = evolveRegistryEntry(state, transitioned);

        expect(result).toEqual({
          agentId: agentId("golden-2"),
          agentType: "worker",
          metadata: {},
          registeredAt: 1706140800000,
          status: {
            phase: "running",
            generation: 1,
            conditions: ["Initialized"],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: 1706140801000,
          },
        });
      });

      test("full lifecycle fold produces expected states at each step", () => {
        const events: readonly AgentStateEvent[] = [
          {
            kind: "agent_registered",
            agentId: agentId("golden-3"),
            agentType: "copilot",
            metadata: { version: 1 },
            registeredAt: 1706140800000,
          },
          {
            kind: "agent_transitioned",
            agentId: agentId("golden-3"),
            from: "created",
            to: "running",
            generation: 1,
            reason: { kind: "assembly_complete" },
            conditions: ["Initialized"],
            transitionedAt: 1706140801000,
          },
          {
            kind: "agent_transitioned",
            agentId: agentId("golden-3"),
            from: "running",
            to: "waiting",
            generation: 2,
            reason: { kind: "awaiting_response" },
            conditions: ["Initialized", "Ready"],
            transitionedAt: 1706140802000,
          },
          {
            kind: "agent_transitioned",
            agentId: agentId("golden-3"),
            from: "waiting",
            to: "running",
            generation: 3,
            reason: { kind: "response_received" },
            conditions: ["Initialized", "Ready", "Healthy"],
            transitionedAt: 1706140803000,
          },
          {
            kind: "agent_transitioned",
            agentId: agentId("golden-3"),
            from: "running",
            to: "terminated",
            generation: 4,
            reason: { kind: "completed" },
            conditions: [],
            transitionedAt: 1706140804000,
          },
          {
            kind: "agent_deregistered",
            agentId: agentId("golden-3"),
            deregisteredAt: 1706140805000,
          },
        ];

        // Expected states at each step
        const expectedPhases = [
          "created",
          "running",
          "waiting",
          "running",
          "terminated",
          undefined,
        ] as const;
        const expectedGens = [0, 1, 2, 3, 4, undefined] as const;

        // let: state evolves across fold
        let state: RegistryEntry | undefined;
        for (const [i, event] of events.entries()) {
          state = evolveRegistryEntry(state, event);
          if (expectedPhases[i] === undefined) {
            expect(state).toBeUndefined();
          } else {
            expect(state?.status.phase).toBe(expectedPhases[i]);
            expect(state?.status.generation).toBe(expectedGens[i]);
          }
        }
      });
    });
  });
}
