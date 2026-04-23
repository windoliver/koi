import { describe, expect, test } from "bun:test";
import type { AgentManifest, ChildSpec } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { createInProcessSpawnChildFn } from "./in-process-spawn-child-fn.js";

const CHILD_MANIFEST: AgentManifest = {
  name: "child-worker",
  version: "1.0.0",
  model: { name: "test-model" },
};

const SPEC: ChildSpec = {
  name: "researcher",
  restart: "permanent",
  isolation: "in-process",
};

describe("createInProcessSpawnChildFn", () => {
  test("returns a function matching SpawnChildFn signature", () => {
    const registry = createInMemoryRegistry();
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async () => agentId("spawned-id"),
    });
    expect(typeof fn).toBe("function");
  });

  test("delegates to the underlying spawn and sets metadata.childSpecName", async () => {
    const registry = createInMemoryRegistry();
    const spawnedIds: string[] = [];
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async (parentId, childSpec, manifest) => {
        const id = agentId(`spawn-${childSpec.name}`);
        registry.register({
          agentId: id,
          status: {
            phase: "created",
            generation: 0,
            conditions: [],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: Date.now(),
          },
          agentType: "worker" as const,
          metadata: { childSpecName: childSpec.name },
          registeredAt: Date.now(),
          priority: 10,
          parentId,
        });
        spawnedIds.push(id);
        return id;
      },
    });

    const parent = agentId("supervisor-1");
    const childId = await fn(parent, SPEC, CHILD_MANIFEST);

    expect(childId).toBe(agentId("spawn-researcher"));
    expect(spawnedIds).toEqual([agentId("spawn-researcher")]);

    const entry = registry.lookup(childId);
    if (entry === undefined || entry instanceof Promise) {
      throw new Error("expected registered entry");
    }
    expect(entry.metadata.childSpecName).toBe("researcher");
    expect(entry.parentId).toBe(parent);
  });

  test("propagates spawn errors", async () => {
    const registry = createInMemoryRegistry();
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async () => {
        throw new Error("spawn failed");
      },
    });
    const parent = agentId("supervisor-1");
    await expect(fn(parent, SPEC, CHILD_MANIFEST)).rejects.toThrow("spawn failed");
  });

  test("throws when childSpec.isolation is 'subprocess'", async () => {
    const registry = createInMemoryRegistry();
    const subprocessSpec: ChildSpec = {
      name: "crashy",
      restart: "transient",
      isolation: "subprocess",
    };
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async () => agentId("should-not-be-called"),
    });
    const parent = agentId("supervisor-1");
    await expect(fn(parent, subprocessSpec, CHILD_MANIFEST)).rejects.toThrow(
      /in-process adapter cannot spawn/,
    );
  });

  test("warns (not throws) when delegate did not set metadata.childSpecName", async () => {
    const registry = createInMemoryRegistry();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const fn = createInProcessSpawnChildFn({
        registry,
        spawn: async (parentId) => {
          const id = agentId("unnamed-child");
          // Deliberately omit metadata.childSpecName
          registry.register({
            agentId: id,
            status: {
              phase: "created",
              generation: 0,
              conditions: [],
              reason: { kind: "assembly_complete" },
              lastTransitionAt: Date.now(),
            },
            agentType: "worker" as const,
            metadata: {},
            registeredAt: Date.now(),
            priority: 10,
            parentId,
          });
          return id;
        },
      });

      const parent = agentId("supervisor-1");
      const result = await fn(parent, SPEC, CHILD_MANIFEST);

      expect(result).toBe(agentId("unnamed-child"));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("position-based fallback");
    } finally {
      console.warn = originalWarn;
    }
  });
});
