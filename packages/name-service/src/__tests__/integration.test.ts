import { afterEach, describe, expect, test } from "bun:test";
import type { AgentId, AgentRegistry, BrickId, NameServiceBackend, RegistryEvent } from "@koi/core";
import { createInMemoryNameService } from "../in-memory-backend.js";
import { createRegistrySync } from "../registry-sync.js";

/** Minimal mock AgentRegistry for integration testing. */
function createMockRegistry(): {
  readonly registry: AgentRegistry;
  readonly emit: (event: RegistryEvent) => void;
} {
  const listeners: Array<(event: RegistryEvent) => void> = [];

  const registry = {
    watch: (listener: (event: RegistryEvent) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    register: () => {
      throw new Error("not implemented");
    },
    deregister: () => {
      throw new Error("not implemented");
    },
    lookup: () => {
      throw new Error("not implemented");
    },
    list: () => {
      throw new Error("not implemented");
    },
    transition: () => {
      throw new Error("not implemented");
    },
    patch: () => {
      throw new Error("not implemented");
    },
    [Symbol.asyncDispose]: async () => {},
  } as unknown as AgentRegistry;

  return {
    registry,
    emit: (event) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

describe("ANS integration", () => {
  let ns: NameServiceBackend;

  afterEach(() => {
    ns?.dispose?.();
  });

  test("end-to-end: registry sync + manual brick + resolution + suggestions", async () => {
    // 1. Create in-memory backend
    ns = createInMemoryNameService({ defaultTtlMs: 0 });

    // 2. Create registry sync with mock registry
    const { registry, emit } = createMockRegistry();
    const unsub = createRegistrySync(registry, ns);

    // 3. Simulate agent registration via mock registry event
    emit({
      kind: "registered",
      entry: {
        agentId: "agent-cr" as AgentId,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { name: "code-reviewer" },
        registeredAt: Date.now(),
        priority: 10,
      },
    });

    // 4. Resolve agent by name → success
    const agentResult = await ns.resolve("code-reviewer");
    expect(agentResult.ok).toBe(true);
    if (agentResult.ok) {
      expect(agentResult.value.record.binding).toEqual({
        kind: "agent",
        agentId: "agent-cr" as AgentId,
      });
      expect(agentResult.value.matchedAlias).toBe(false);
    }

    // 5. Register a brick manually
    const brickResult = await ns.register({
      name: "format-tool",
      binding: { kind: "brick", brickId: "brick-fmt" as BrickId, brickKind: "tool" },
      scope: "global",
      aliases: ["fmt"],
      registeredBy: "integration-test",
    });
    expect(brickResult.ok).toBe(true);

    // 6. Resolve brick by name → success
    const brickResolve = await ns.resolve("format-tool");
    expect(brickResolve.ok).toBe(true);
    if (brickResolve.ok) {
      expect(brickResolve.value.record.binding).toEqual({
        kind: "brick",
        brickId: "brick-fmt" as BrickId,
        brickKind: "tool",
      });
    }

    // Resolve brick by alias
    const aliasResolve = await ns.resolve("fmt");
    expect(aliasResolve.ok).toBe(true);
    if (aliasResolve.ok) {
      expect(aliasResolve.value.matchedAlias).toBe(true);
    }

    // 7. Simulate agent deregistration → resolve fails
    emit({
      kind: "deregistered",
      agentId: "agent-cr" as AgentId,
    });

    const afterDeregister = await ns.resolve("code-reviewer");
    expect(afterDeregister.ok).toBe(false);

    // 8. Verify fuzzy suggestions work for near-miss names
    const suggestions = await ns.suggest("formt-tool"); // typo
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.name).toBe("format-tool");

    // Brick is still resolvable
    expect((await ns.resolve("format-tool")).ok).toBe(true);

    // Search by binding kind
    const brickSearch = await ns.search({ bindingKind: "brick" });
    expect(brickSearch).toHaveLength(1);
    expect(brickSearch[0]?.name).toBe("format-tool");

    unsub();
  });

  test("scoped resolution: agent scope shadows global", async () => {
    ns = createInMemoryNameService({ defaultTtlMs: 0 });

    await ns.register({
      name: "helper",
      binding: { kind: "agent", agentId: "global-helper" as AgentId },
      scope: "global",
      registeredBy: "test",
    });

    await ns.register({
      name: "helper",
      binding: { kind: "agent", agentId: "local-helper" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });

    // Unscoped resolve → agent scope wins
    const result = await ns.resolve("helper");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.record.binding).toEqual({
        kind: "agent",
        agentId: "local-helper" as AgentId,
      });
    }

    // Explicit global scope → global binding
    const globalResult = await ns.resolve("helper", "global");
    expect(globalResult.ok).toBe(true);
    if (globalResult.ok) {
      expect(globalResult.value.record.binding).toEqual({
        kind: "agent",
        agentId: "global-helper" as AgentId,
      });
    }
  });
});
