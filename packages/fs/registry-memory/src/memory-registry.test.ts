/**
 * Tests for the in-memory registry implementation.
 *
 * Runs the shared contract test suite plus implementation-specific tests
 * for index streams, factory rebuild, and stream-id helpers.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { EventBackend, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryEventBackend } from "@koi/events-memory";
import { runAgentRegistryContractTests, runMemoryRegistryContractTests } from "@koi/test-utils";
import type { MemoryRegistry } from "./memory-registry.js";
import { createMemoryRegistry } from "./memory-registry.js";
import { agentStreamId, parseAgentStreamId, REGISTRY_INDEX_STREAM } from "./stream-ids.js";

// ---------------------------------------------------------------------------
// Run shared contract tests (generic AgentRegistry + memory-registry specific)
// ---------------------------------------------------------------------------

runAgentRegistryContractTests(async () => {
  const backend = createInMemoryEventBackend();
  return createMemoryRegistry(backend);
});

runMemoryRegistryContractTests(async () => {
  const backend = createInMemoryEventBackend();
  const registry = await createMemoryRegistry(backend);
  return { registry, backend };
});

// ---------------------------------------------------------------------------
// Stream ID helpers
// ---------------------------------------------------------------------------

describe("stream-ids", () => {
  test("agentStreamId creates correct format", () => {
    expect(agentStreamId(agentId("abc-123"))).toBe("agent:abc-123");
  });

  test("parseAgentStreamId parses valid stream ID", () => {
    const result = parseAgentStreamId("agent:abc-123");
    expect(result).toBe(agentId("abc-123"));
  });

  test("parseAgentStreamId returns undefined for invalid prefix", () => {
    expect(parseAgentStreamId("brick:abc")).toBeUndefined();
    expect(parseAgentStreamId("agent:")).toBeUndefined();
    expect(parseAgentStreamId("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Implementation-specific tests
// ---------------------------------------------------------------------------

describe("createMemoryRegistry — impl-specific", () => {
  let backend: EventBackend;
  let registry: MemoryRegistry;

  beforeEach(async () => {
    backend = createInMemoryEventBackend();
    registry = await createMemoryRegistry(backend);
  });

  // -------------------------------------------------------------------------
  // Index stream
  // -------------------------------------------------------------------------

  test("index stream is populated on register", async () => {
    await registry.register(makeEntry("a1"));

    const result = await backend.read(REGISTRY_INDEX_STREAM);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events.length).toBeGreaterThanOrEqual(1);
      const types = result.value.events.map((e) => e.type);
      expect(types).toContain("index:registered");
    }
  });

  test("index stream records deregister", async () => {
    await registry.register(makeEntry("a1"));
    await registry.deregister(agentId("a1"));

    const result = await backend.read(REGISTRY_INDEX_STREAM);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const types = result.value.events.map((e) => e.type);
      expect(types).toContain("index:deregistered");
    }
  });

  // -------------------------------------------------------------------------
  // Factory rebuild from pre-existing events
  // -------------------------------------------------------------------------

  test("factory rebuilds projection from pre-existing events", async () => {
    // Create initial state
    await registry.register(makeEntry("a1"));
    await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
    await registry.register(makeEntry("a2"));

    // Create a fresh registry from the same backend
    const registry2 = await createMemoryRegistry(backend);

    const a1 = registry2.lookup(agentId("a1"));
    const a2 = registry2.lookup(agentId("a2"));
    expect(a1).toBeDefined();
    expect(a1?.status.phase).toBe("running");
    expect(a1?.status.generation).toBe(1);
    expect(a2).toBeDefined();
    expect(a2?.status.phase).toBe("created");

    await registry2[Symbol.asyncDispose]();
  });

  // -------------------------------------------------------------------------
  // rebuild() method
  // -------------------------------------------------------------------------

  test("rebuild produces identical state to fresh creation", async () => {
    await registry.register(makeEntry("a1"));
    await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
    await registry.transition(agentId("a1"), "waiting", 1, { kind: "awaiting_response" });

    const before = registry.lookup(agentId("a1"));

    await registry.rebuild();

    const after = registry.lookup(agentId("a1"));
    expect(after?.status.phase).toBe(before?.status.phase);
    expect(after?.status.generation).toBe(before?.status.generation);
  });

  // -------------------------------------------------------------------------
  // Per-agent event streams
  // -------------------------------------------------------------------------

  test("each agent has its own event stream", async () => {
    await registry.register(makeEntry("a1"));
    await registry.register(makeEntry("a2"));

    const stream1 = await backend.read("agent:a1");
    const stream2 = await backend.read("agent:a2");

    expect(stream1.ok).toBe(true);
    expect(stream2.ok).toBe(true);
    if (stream1.ok && stream2.ok) {
      expect(stream1.value.events).toHaveLength(1);
      expect(stream2.value.events).toHaveLength(1);
    }
  });

  test("transition appends to agent event stream", async () => {
    await registry.register(makeEntry("a1"));
    await registry.transition(agentId("a1"), "running", 0, { kind: "assembly_complete" });
    await registry.transition(agentId("a1"), "waiting", 1, { kind: "awaiting_response" });

    const result = await backend.read("agent:a1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(3); // registered + 2 transitions
    }
  });

  // -------------------------------------------------------------------------
  // Deregistered agent rebuilt as absent
  // -------------------------------------------------------------------------

  test("deregistered agent is absent after rebuild", async () => {
    await registry.register(makeEntry("a1"));
    await registry.deregister(agentId("a1"));

    await registry.rebuild();

    expect(registry.lookup(agentId("a1"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string): RegistryEntry {
  return {
    agentId: agentId(id),
    status: {
      phase: "created",
      generation: 0,
      conditions: [],
      lastTransitionAt: Date.now(),
    },
    agentType: "worker",
    metadata: {},
    registeredAt: Date.now(),
    priority: 10,
  };
}
