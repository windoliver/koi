/**
 * Tests for ForgeComponentProvider (Issue #917 Phase 1 — runtime visibility).
 *
 * Covers: scope filtering, zone tags, notifier invalidation, requires checks,
 * brick kind attachment, trust enforcement, delta invalidation, lookupBrickId.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact, SandboxExecutor } from "@koi/core";
import {
  agentId,
  brickId,
  COMPONENT_PRIORITY,
  isAttachResult,
  skillToken,
  toolToken,
} from "@koi/core";
import {
  createTestAgentArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
} from "@koi/test-utils";
import { createMemoryStoreChangeNotifier } from "@koi/validation";
import { createForgeComponentProvider } from "./forge-component-provider.js";
import { createInMemoryForgeStore } from "./memory-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExecutor(): SandboxExecutor {
  return {
    execute: async () => ({ ok: true, value: { output: null, durationMs: 0 } }),
  };
}

/** Seed the in-memory store with the given bricks and return the store. */
async function seedStore(
  bricks: readonly BrickArtifact[],
): Promise<ReturnType<typeof createInMemoryForgeStore>> {
  const store = createInMemoryForgeStore();
  for (const brick of bricks) {
    await store.save(brick);
  }
  return store;
}

/** Dummy agent for attach() calls. */
const MOCK_AGENT = {
  pid: { id: agentId("agent-1"), name: "test", type: "worker" as const, depth: 0 },
  manifest: { name: "test", version: "0.0.1", description: "test", model: { name: "m" } },
  state: "running" as const,
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeComponentProvider", () => {
  describe("basic attachment", () => {
    test("attaches active tool bricks as tool components", async () => {
      const tool = createTestToolArtifact({
        id: brickId("tool-1"),
        name: "my-tool",
        lifecycle: "active",
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("my-tool") as string)).toBe(true);
    });

    test("attaches active skill bricks as skill components", async () => {
      const skill = createTestSkillArtifact({
        id: brickId("skill-1"),
        name: "my-skill",
        lifecycle: "active",
      });
      const store = await seedStore([skill]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(skillToken("my-skill") as string)).toBe(true);
    });

    test("skips draft and deprecated bricks", async () => {
      const draft = createTestToolArtifact({
        id: brickId("draft-1"),
        name: "draft-tool",
        lifecycle: "draft",
      });
      const deprecated = createTestToolArtifact({
        id: brickId("dep-1"),
        name: "dep-tool",
        lifecycle: "deprecated",
      });
      const store = await seedStore([draft, deprecated]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.size).toBe(0);
    });
  });

  describe("scope filtering", () => {
    test("agent scope sees all scopes", async () => {
      const agentTool = createTestToolArtifact({
        id: brickId("a-1"),
        name: "agent-tool",
        scope: "agent",
      });
      const zoneTool = createTestToolArtifact({
        id: brickId("z-1"),
        name: "zone-tool",
        scope: "zone",
        tags: ["zone:z1"],
      });
      const globalTool = createTestToolArtifact({
        id: brickId("g-1"),
        name: "global-tool",
        scope: "global",
      });
      const store = await seedStore([agentTool, zoneTool, globalTool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "agent",
        zoneId: "z1",
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.size).toBe(3);
    });

    test("global scope only sees global bricks", async () => {
      const agentTool = createTestToolArtifact({
        id: brickId("a-2"),
        name: "agent-only",
        scope: "agent",
      });
      const globalTool = createTestToolArtifact({
        id: brickId("g-2"),
        name: "global-only",
        scope: "global",
      });
      const store = await seedStore([agentTool, globalTool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "global",
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("global-only") as string)).toBe(true);
      expect(components.has(toolToken("agent-only") as string)).toBe(false);
    });

    test("zone scope sees zone and global, not agent", async () => {
      const agentTool = createTestToolArtifact({
        id: brickId("a-3"),
        name: "agent-t",
        scope: "agent",
      });
      const zoneTool = createTestToolArtifact({
        id: brickId("z-3"),
        name: "zone-t",
        scope: "zone",
        tags: ["zone:z1"],
      });
      const globalTool = createTestToolArtifact({
        id: brickId("g-3"),
        name: "global-t",
        scope: "global",
      });
      const store = await seedStore([agentTool, zoneTool, globalTool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "zone",
        zoneId: "z1",
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("agent-t") as string)).toBe(false);
      expect(components.has(toolToken("zone-t") as string)).toBe(true);
      expect(components.has(toolToken("global-t") as string)).toBe(true);
    });
  });

  describe("zone tag filtering", () => {
    test("zone-scoped bricks require matching zone tag", async () => {
      const matchingZone = createTestToolArtifact({
        id: brickId("zm-1"),
        name: "matching",
        scope: "zone",
        tags: ["zone:alpha"],
      });
      const mismatchZone = createTestToolArtifact({
        id: brickId("zm-2"),
        name: "mismatching",
        scope: "zone",
        tags: ["zone:beta"],
      });
      const store = await seedStore([matchingZone, mismatchZone]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "agent",
        zoneId: "alpha",
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("matching") as string)).toBe(true);
      expect(components.has(toolToken("mismatching") as string)).toBe(false);
    });
  });

  describe("caching", () => {
    test("second attach returns cached results", async () => {
      const tool = createTestToolArtifact({ id: brickId("c-1"), name: "cached" });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result1 = await provider.attach(MOCK_AGENT);
      const result2 = await provider.attach(MOCK_AGENT);
      const c1 = isAttachResult(result1) ? result1.components : result1;
      const c2 = isAttachResult(result2) ? result2.components : result2;
      // Same reference (cached)
      expect(c1).toBe(c2);
    });

    test("invalidate clears cache and re-queries store", async () => {
      const tool = createTestToolArtifact({ id: brickId("inv-1"), name: "before" });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result1 = await provider.attach(MOCK_AGENT);
      const c1 = isAttachResult(result1) ? result1.components : result1;
      expect(c1.has(toolToken("before") as string)).toBe(true);

      // Add a new brick, then invalidate
      const newTool = createTestToolArtifact({ id: brickId("inv-2"), name: "after" });
      await store.save(newTool);
      provider.invalidate();

      const result2 = await provider.attach(MOCK_AGENT);
      const c2 = isAttachResult(result2) ? result2.components : result2;
      expect(c2.has(toolToken("after") as string)).toBe(true);
    });
  });

  describe("delta invalidation", () => {
    test("invalidateByScope clears cache when scope matches", async () => {
      const tool = createTestToolArtifact({
        id: brickId("ds-1"),
        name: "delta-tool",
        scope: "agent",
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      await provider.attach(MOCK_AGENT);
      provider.invalidateByScope("agent");

      // After invalidation, next attach re-queries (new reference)
      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("delta-tool") as string)).toBe(true);
    });

    test("invalidateByScope is no-op when scope does not match", async () => {
      const tool = createTestToolArtifact({
        id: brickId("ds-2"),
        name: "scope-tool",
        scope: "agent",
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result1 = await provider.attach(MOCK_AGENT);
      provider.invalidateByScope("global");
      const result2 = await provider.attach(MOCK_AGENT);
      // Still cached (no invalidation)
      const c1 = isAttachResult(result1) ? result1.components : result1;
      const c2 = isAttachResult(result2) ? result2.components : result2;
      expect(c1).toBe(c2);
    });

    test("invalidateByBrickId clears when brick ID is cached", async () => {
      const tool = createTestToolArtifact({
        id: brickId("db-1"),
        name: "brick-tool",
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result1 = await provider.attach(MOCK_AGENT);
      provider.invalidateByBrickId(brickId("db-1"));
      const result2 = await provider.attach(MOCK_AGENT);
      const c1 = isAttachResult(result1) ? result1.components : result1;
      const c2 = isAttachResult(result2) ? result2.components : result2;
      // Different reference after invalidation
      expect(c1).not.toBe(c2);
    });
  });

  describe("notifier integration", () => {
    test("subscribes to notifier and invalidates on saved event", async () => {
      const tool = createTestToolArtifact({ id: brickId("n-1"), name: "notify-tool" });
      const store = await seedStore([tool]);
      const notifier = createMemoryStoreChangeNotifier();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        notifier,
      });

      const result1 = await provider.attach(MOCK_AGENT);
      // Notify saved event → invalidates cache
      notifier.notify({ kind: "saved", brickId: brickId("n-2") });
      const result2 = await provider.attach(MOCK_AGENT);

      const c1 = isAttachResult(result1) ? result1.components : result1;
      const c2 = isAttachResult(result2) ? result2.components : result2;
      expect(c1).not.toBe(c2);
    });

    test("subscribes to notifier and invalidates on removed event", async () => {
      const tool = createTestToolArtifact({ id: brickId("nr-1"), name: "remove-tool" });
      const store = await seedStore([tool]);
      const notifier = createMemoryStoreChangeNotifier();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        notifier,
      });

      const result1 = await provider.attach(MOCK_AGENT);
      notifier.notify({ kind: "removed", brickId: brickId("nr-1") });
      const result2 = await provider.attach(MOCK_AGENT);

      const c1 = isAttachResult(result1) ? result1.components : result1;
      const c2 = isAttachResult(result2) ? result2.components : result2;
      expect(c1).not.toBe(c2);
    });

    test("newly saved brick appears in next attach after notify", async () => {
      const store = createInMemoryForgeStore();
      const notifier = createMemoryStoreChangeNotifier();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        notifier,
      });

      // First attach — empty store, no tool components
      const result1 = await provider.attach(MOCK_AGENT);
      const c1 = isAttachResult(result1) ? result1.components : result1;
      expect(c1.size).toBe(0);

      // Save a tool brick to store, then notify
      const tool = createTestToolArtifact({ id: brickId("chain-1"), name: "chain-tool" });
      await store.save(tool);
      notifier.notify({ kind: "saved", brickId: brickId("chain-1") });

      // Second attach — should include the new tool
      const result2 = await provider.attach(MOCK_AGENT);
      const c2 = isAttachResult(result2) ? result2.components : result2;
      expect(c2.has(toolToken("chain-tool") as string)).toBe(true);
    });

    test("dispose unsubscribes from notifier", async () => {
      const tool = createTestToolArtifact({ id: brickId("nd-1"), name: "dispose-tool" });
      const store = await seedStore([tool]);
      const notifier = createMemoryStoreChangeNotifier();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        notifier,
      });

      const result1 = await provider.attach(MOCK_AGENT);
      provider.dispose();
      // After dispose, notifier events should not invalidate
      notifier.notify({ kind: "saved", brickId: brickId("nd-2") });
      const result2 = await provider.attach(MOCK_AGENT);

      const c1 = isAttachResult(result1) ? result1.components : result1;
      const c2 = isAttachResult(result2) ? result2.components : result2;
      expect(c1).toBe(c2);
    });
  });

  describe("lookupBrickId", () => {
    test("returns brick ID after attach", async () => {
      const tool = createTestToolArtifact({
        id: brickId("lu-1"),
        name: "lookup-tool",
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      await provider.attach(MOCK_AGENT);
      expect(provider.lookupBrickId("lookup-tool")).toBe("lu-1");
    });

    test("returns undefined before attach", () => {
      const store = createInMemoryForgeStore();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });
      expect(provider.lookupBrickId("anything")).toBeUndefined();
    });
  });

  describe("priority", () => {
    test("agent scope uses AGENT_FORGED priority", () => {
      const store = createInMemoryForgeStore();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "agent",
      });
      expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
    });

    test("zone scope uses ZONE_FORGED priority", () => {
      const store = createInMemoryForgeStore();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "zone",
      });
      expect(provider.priority).toBe(COMPONENT_PRIORITY.ZONE_FORGED);
    });

    test("global scope uses GLOBAL_FORGED priority", () => {
      const store = createInMemoryForgeStore();
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
        scope: "global",
      });
      expect(provider.priority).toBe(COMPONENT_PRIORITY.GLOBAL_FORGED);
    });
  });

  describe("trust enforcement", () => {
    test("skips sandbox-required bricks without sandbox policy", async () => {
      const tool = createTestToolArtifact({
        id: brickId("te-1"),
        name: "no-sandbox",
        policy: { sandbox: false, capabilities: {} },
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result = await provider.attach(MOCK_AGENT);
      // AttachResult with skipped components
      if (isAttachResult(result)) {
        const skipped = result.skipped ?? [];
        expect(skipped.some((s) => s.name === "no-sandbox")).toBe(true);
      }
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("no-sandbox") as string)).toBe(false);
    });
  });

  describe("requires enforcement", () => {
    test("skips bricks with unsatisfied tool requirements", async () => {
      const tool = createTestToolArtifact({
        id: brickId("req-1"),
        name: "needs-tool",
        requires: { tools: ["nonexistent-tool"] },
      });
      const store = await seedStore([tool]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      expect(components.has(toolToken("needs-tool") as string)).toBe(false);
    });
  });

  describe("agent bricks", () => {
    test("attaches agent bricks with AgentDescriptor value", async () => {
      const agent = createTestAgentArtifact({
        id: brickId("ag-1"),
        name: "test-agent",
        description: "Agent for testing",
        manifestYaml: "name: test-agent\nversion: 0.1",
      });
      const store = await seedStore([agent]);
      const provider = createForgeComponentProvider({
        store,
        executor: createMockExecutor(),
      });

      const result = await provider.attach(MOCK_AGENT);
      const components = isAttachResult(result) ? result.components : result;
      const token = "agent:test-agent";
      expect(components.has(token)).toBe(true);
      const descriptor = components.get(token) as {
        readonly name: string;
        readonly description: string;
      };
      expect(descriptor.name).toBe("test-agent");
      expect(descriptor.description).toBe("Agent for testing");
    });
  });
});
