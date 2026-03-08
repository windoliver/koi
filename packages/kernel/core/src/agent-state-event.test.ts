/**
 * Unit tests for the AgentStateEvent fold function and type guard.
 *
 * Tests the pure L0 functions directly: evolveRegistryEntry, isAgentStateEvent,
 * and INITIAL_AGENT_STATUS.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentDeregisteredEvent,
  AgentRegisteredEvent,
  AgentStateEvent,
  AgentTransitionedEvent,
} from "./agent-state-event.js";
import {
  evolveRegistryEntry,
  INITIAL_AGENT_STATUS,
  isAgentStateEvent,
} from "./agent-state-event.js";
import { agentId } from "./ecs.js";
import type { RegistryEntry } from "./lifecycle.js";
import { zoneId } from "./zone.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REGISTERED_EVENT: AgentRegisteredEvent = {
  kind: "agent_registered",
  agentId: agentId("test-1"),
  agentType: "worker",
  metadata: { name: "test-agent" },
  registeredAt: 1000,
};

const REGISTERED_WITH_PARENT: AgentRegisteredEvent = {
  kind: "agent_registered",
  agentId: agentId("child-1"),
  agentType: "copilot",
  parentId: agentId("parent-1"),
  metadata: {},
  registeredAt: 2000,
};

const TRANSITIONED_EVENT: AgentTransitionedEvent = {
  kind: "agent_transitioned",
  agentId: agentId("test-1"),
  from: "created",
  to: "running",
  generation: 1,
  reason: { kind: "assembly_complete" },
  conditions: ["Initialized"],
  transitionedAt: 3000,
};

const DEREGISTERED_EVENT: AgentDeregisteredEvent = {
  kind: "agent_deregistered",
  agentId: agentId("test-1"),
  deregisteredAt: 4000,
};

// ---------------------------------------------------------------------------
// INITIAL_AGENT_STATUS
// ---------------------------------------------------------------------------

describe("INITIAL_AGENT_STATUS", () => {
  test("has correct default values", () => {
    expect(INITIAL_AGENT_STATUS.phase).toBe("created");
    expect(INITIAL_AGENT_STATUS.generation).toBe(0);
    expect(INITIAL_AGENT_STATUS.conditions).toEqual([]);
    expect(INITIAL_AGENT_STATUS.lastTransitionAt).toBe(0);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(INITIAL_AGENT_STATUS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAgentStateEvent
// ---------------------------------------------------------------------------

describe("isAgentStateEvent", () => {
  test("returns true for agent_registered", () => {
    expect(isAgentStateEvent(REGISTERED_EVENT)).toBe(true);
  });

  test("returns true for agent_transitioned", () => {
    expect(isAgentStateEvent(TRANSITIONED_EVENT)).toBe(true);
  });

  test("returns true for agent_deregistered", () => {
    expect(isAgentStateEvent(DEREGISTERED_EVENT)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isAgentStateEvent(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isAgentStateEvent(undefined)).toBe(false);
  });

  test("returns false for non-object", () => {
    expect(isAgentStateEvent("string")).toBe(false);
    expect(isAgentStateEvent(42)).toBe(false);
    expect(isAgentStateEvent(true)).toBe(false);
  });

  test("returns false for object without kind", () => {
    expect(isAgentStateEvent({ agentId: "a1" })).toBe(false);
  });

  test("returns false for object with unknown kind", () => {
    expect(isAgentStateEvent({ kind: "unknown_event" })).toBe(false);
    expect(isAgentStateEvent({ kind: "agent_updated" })).toBe(false);
  });

  test("returns false for empty object", () => {
    expect(isAgentStateEvent({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evolveRegistryEntry — agent_registered
// ---------------------------------------------------------------------------

describe("evolveRegistryEntry — agent_registered", () => {
  test("creates entry from undefined state", () => {
    const result = evolveRegistryEntry(undefined, REGISTERED_EVENT);

    expect(result).toBeDefined();
    expect(result?.agentId).toBe(agentId("test-1"));
    expect(result?.agentType).toBe("worker");
    expect(result?.metadata).toEqual({ name: "test-agent" });
    expect(result?.registeredAt).toBe(1000);
    expect(result?.status.phase).toBe("created");
    expect(result?.status.generation).toBe(0);
    expect(result?.status.conditions).toEqual([]);
    expect(result?.status.lastTransitionAt).toBe(1000);
  });

  test("sets parentId when provided", () => {
    const result = evolveRegistryEntry(undefined, REGISTERED_WITH_PARENT);

    expect(result?.parentId).toBe(agentId("parent-1"));
    expect(result?.agentType).toBe("copilot");
  });

  test("omits parentId when not provided", () => {
    const result = evolveRegistryEntry(undefined, REGISTERED_EVENT);

    expect(result?.parentId).toBeUndefined();
    expect("parentId" in (result ?? {})).toBe(false);
  });

  test("sets spawner when provided", () => {
    const event: AgentRegisteredEvent = {
      ...REGISTERED_WITH_PARENT,
      spawner: agentId("spawner-1"),
    };
    const result = evolveRegistryEntry(undefined, event);

    expect(result?.spawner).toBe(agentId("spawner-1"));
  });

  test("omits spawner when not provided", () => {
    const result = evolveRegistryEntry(undefined, REGISTERED_EVENT);

    expect(result?.spawner).toBeUndefined();
    expect("spawner" in (result ?? {})).toBe(false);
  });

  test("preserves priority when provided", () => {
    const event: AgentRegisteredEvent = {
      ...REGISTERED_EVENT,
      priority: 5,
    };
    const result = evolveRegistryEntry(undefined, event);

    expect(result?.priority).toBe(5);
  });

  test("defaults priority to 10 when not provided", () => {
    const result = evolveRegistryEntry(undefined, REGISTERED_EVENT);

    expect(result?.priority).toBe(10);
  });

  test("preserves zoneId when provided", () => {
    const event: AgentRegisteredEvent = {
      ...REGISTERED_EVENT,
      zoneId: zoneId("us-east-1"),
    };
    const result = evolveRegistryEntry(undefined, event);

    expect(result?.zoneId).toBe(zoneId("us-east-1"));
  });

  test("omits zoneId when not provided", () => {
    const result = evolveRegistryEntry(undefined, REGISTERED_EVENT);

    expect(result?.zoneId).toBeUndefined();
    expect("zoneId" in (result ?? {})).toBe(false);
  });

  test("re-register replaces existing state", () => {
    const existing = evolveRegistryEntry(undefined, REGISTERED_EVENT);
    const reRegistered = evolveRegistryEntry(existing, {
      ...REGISTERED_EVENT,
      metadata: { name: "new-name" },
      registeredAt: 5000,
    });

    expect(reRegistered?.metadata).toEqual({ name: "new-name" });
    expect(reRegistered?.registeredAt).toBe(5000);
    expect(reRegistered?.status.phase).toBe("created");
    expect(reRegistered?.status.generation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evolveRegistryEntry — agent_transitioned
// ---------------------------------------------------------------------------

describe("evolveRegistryEntry — agent_transitioned", () => {
  test("transitions existing entry to new phase", () => {
    const initial = evolveRegistryEntry(undefined, REGISTERED_EVENT);
    const result = evolveRegistryEntry(initial, TRANSITIONED_EVENT);

    expect(result?.status.phase).toBe("running");
    expect(result?.status.generation).toBe(1);
    expect(result?.status.reason).toEqual({ kind: "assembly_complete" });
    expect(result?.status.conditions).toEqual(["Initialized"]);
    expect(result?.status.lastTransitionAt).toBe(3000);
  });

  test("preserves non-status fields across transition", () => {
    const initial = evolveRegistryEntry(undefined, REGISTERED_EVENT);
    const result = evolveRegistryEntry(initial, TRANSITIONED_EVENT);

    expect(result?.agentId).toBe(agentId("test-1"));
    expect(result?.agentType).toBe("worker");
    expect(result?.metadata).toEqual({ name: "test-agent" });
    expect(result?.registeredAt).toBe(1000);
  });

  test("returns undefined when transitioning undefined state", () => {
    const result = evolveRegistryEntry(undefined, TRANSITIONED_EVENT);

    expect(result).toBeUndefined();
  });

  test("chains multiple transitions", () => {
    // let: state evolves through fold
    let state = evolveRegistryEntry(undefined, REGISTERED_EVENT);

    state = evolveRegistryEntry(state, {
      ...TRANSITIONED_EVENT,
      to: "running",
      generation: 1,
      transitionedAt: 3000,
    });
    expect(state?.status.phase).toBe("running");
    expect(state?.status.generation).toBe(1);

    state = evolveRegistryEntry(state, {
      kind: "agent_transitioned",
      agentId: agentId("test-1"),
      from: "running",
      to: "waiting",
      generation: 2,
      reason: { kind: "awaiting_response" },
      conditions: ["Initialized", "Ready"],
      transitionedAt: 4000,
    });
    expect(state?.status.phase).toBe("waiting");
    expect(state?.status.generation).toBe(2);
    expect(state?.status.conditions).toEqual(["Initialized", "Ready"]);
  });
});

// ---------------------------------------------------------------------------
// evolveRegistryEntry — agent_deregistered
// ---------------------------------------------------------------------------

describe("evolveRegistryEntry — agent_deregistered", () => {
  test("returns undefined for existing entry", () => {
    const initial = evolveRegistryEntry(undefined, REGISTERED_EVENT);
    expect(initial).toBeDefined();

    const result = evolveRegistryEntry(initial, DEREGISTERED_EVENT);
    expect(result).toBeUndefined();
  });

  test("returns undefined for undefined state", () => {
    const result = evolveRegistryEntry(undefined, DEREGISTERED_EVENT);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// evolveRegistryEntry — full lifecycle fold
// ---------------------------------------------------------------------------

describe("evolveRegistryEntry — full lifecycle", () => {
  test("fold sequence: register → transition → transition → deregister", () => {
    const events: readonly AgentStateEvent[] = [
      REGISTERED_EVENT,
      TRANSITIONED_EVENT,
      {
        kind: "agent_transitioned",
        agentId: agentId("test-1"),
        from: "running",
        to: "terminated",
        generation: 2,
        reason: { kind: "completed" },
        conditions: [],
        transitionedAt: 5000,
      },
      DEREGISTERED_EVENT,
    ];

    // let: state evolves across fold
    let state: RegistryEntry | undefined;
    for (const event of events) {
      state = evolveRegistryEntry(state, event);
    }

    expect(state).toBeUndefined();
  });

  test("deterministic: same events always produce same state", () => {
    const events: readonly AgentStateEvent[] = [
      REGISTERED_EVENT,
      TRANSITIONED_EVENT,
      {
        kind: "agent_transitioned",
        agentId: agentId("test-1"),
        from: "running",
        to: "waiting",
        generation: 2,
        reason: { kind: "awaiting_response" },
        conditions: ["Ready"],
        transitionedAt: 5000,
      },
    ];

    const fold = (evts: readonly AgentStateEvent[]): RegistryEntry | undefined => {
      // let: state evolves across fold
      let s: RegistryEntry | undefined;
      for (const e of evts) {
        s = evolveRegistryEntry(s, e);
      }
      return s;
    };

    const result1 = fold(events);
    const result2 = fold(events);

    expect(result1?.status.phase).toBe(result2?.status.phase);
    expect(result1?.status.generation).toBe(result2?.status.generation);
    expect(result1?.status.conditions).toEqual(result2?.status.conditions);
    expect(result1?.agentId).toBe(result2?.agentId);
  });
});
