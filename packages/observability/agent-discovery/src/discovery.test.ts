import { describe, expect, it } from "bun:test";
import type { ExternalAgentDescriptor } from "@koi/core";
import { createDiscovery } from "./discovery.js";
import type { DiscoverySource } from "./types.js";

function createMockSource(
  name: string,
  descriptors: readonly ExternalAgentDescriptor[],
): DiscoverySource {
  return {
    name,
    discover: async () => descriptors,
  };
}

function createFailingSource(name: string): DiscoverySource {
  return {
    name,
    discover: async () => {
      throw new Error(`Source ${name} failed`);
    },
  };
}

const agentA: ExternalAgentDescriptor = {
  name: "agent-a",
  transport: "cli",
  capabilities: ["code-generation"],
  healthy: true,
  source: "path",
};

const agentB: ExternalAgentDescriptor = {
  name: "agent-b",
  transport: "mcp",
  capabilities: ["code-review"],
  healthy: true,
  source: "mcp",
};

const agentC: ExternalAgentDescriptor = {
  name: "agent-c",
  transport: "a2a",
  capabilities: ["debugging", "code-generation"],
  source: "filesystem",
};

describe("createDiscovery", () => {
  describe("aggregation", () => {
    it("aggregates results from multiple sources", async () => {
      const s1 = createMockSource("s1", [agentA]);
      const s2 = createMockSource("s2", [agentB]);
      const handle = createDiscovery([s1, s2], 0);

      const results = await handle.discover();

      expect(results).toHaveLength(2);
    });

    it("returns empty array when no sources", async () => {
      const handle = createDiscovery([], 0);
      const results = await handle.discover();

      expect(results).toHaveLength(0);
    });

    it("handles partial failure via allSettled", async () => {
      const good = createMockSource("good", [agentA]);
      const bad = createFailingSource("bad");
      const handle = createDiscovery([good, bad], 0);

      const results = await handle.discover();

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("agent-a");
    });
  });

  describe("deduplication", () => {
    it("deduplicates by name keeping higher-priority source", async () => {
      const pathAgent: ExternalAgentDescriptor = { ...agentA, name: "shared", source: "path" };
      const mcpAgent: ExternalAgentDescriptor = { ...agentB, name: "shared", source: "mcp" };

      const s1 = createMockSource("path", [pathAgent]);
      const s2 = createMockSource("mcp", [mcpAgent]);
      const handle = createDiscovery([s1, s2], 0);

      const results = await handle.discover();

      expect(results).toHaveLength(1);
      expect(results[0]?.source).toBe("mcp"); // MCP has higher priority
    });

    it("keeps filesystem over path", async () => {
      const pathAgent: ExternalAgentDescriptor = { ...agentA, name: "shared", source: "path" };
      const fsAgent: ExternalAgentDescriptor = { ...agentC, name: "shared", source: "filesystem" };

      const s1 = createMockSource("path", [pathAgent]);
      const s2 = createMockSource("fs", [fsAgent]);
      const handle = createDiscovery([s1, s2], 0);

      const results = await handle.discover();

      expect(results).toHaveLength(1);
      expect(results[0]?.source).toBe("filesystem");
    });

    it("keeps first when same priority", async () => {
      const first: ExternalAgentDescriptor = { ...agentA, name: "dup", command: "first" };
      const second: ExternalAgentDescriptor = { ...agentA, name: "dup", command: "second" };

      const s1 = createMockSource("s1", [first]);
      const s2 = createMockSource("s2", [second]);
      const handle = createDiscovery([s1, s2], 0);

      const results = await handle.discover();

      expect(results).toHaveLength(1);
      expect(results[0]?.command).toBe("first");
    });
  });

  describe("filtering", () => {
    it("filters by capability", async () => {
      const s = createMockSource("s", [agentA, agentB, agentC]);
      const handle = createDiscovery([s], 0);

      const results = await handle.discover({
        filter: { capability: "code-generation" },
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name).sort()).toEqual(["agent-a", "agent-c"]);
    });

    it("filters by transport", async () => {
      const s = createMockSource("s", [agentA, agentB, agentC]);
      const handle = createDiscovery([s], 0);

      const results = await handle.discover({
        filter: { transport: "mcp" },
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("agent-b");
    });

    it("filters by source", async () => {
      const s = createMockSource("s", [agentA, agentB, agentC]);
      const handle = createDiscovery([s], 0);

      const results = await handle.discover({
        filter: { source: "filesystem" },
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("agent-c");
    });

    it("applies combined filters", async () => {
      const s = createMockSource("s", [agentA, agentB, agentC]);
      const handle = createDiscovery([s], 0);

      const results = await handle.discover({
        filter: { capability: "code-generation", transport: "cli" },
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("agent-a");
    });

    it("returns empty when no agents match filter", async () => {
      const s = createMockSource("s", [agentA]);
      const handle = createDiscovery([s], 0);

      const results = await handle.discover({
        filter: { capability: "nonexistent" },
      });

      expect(results).toHaveLength(0);
    });

    it("returns all agents when no filter provided", async () => {
      const s = createMockSource("s", [agentA, agentB, agentC]);
      const handle = createDiscovery([s], 0);

      const results = await handle.discover();

      expect(results).toHaveLength(3);
    });
  });

  describe("caching", () => {
    it("returns cached results within TTL", async () => {
      // let justified: mutable call counter for verification
      let callCount = 0;
      const countingSource: DiscoverySource = {
        name: "counter",
        discover: async () => {
          callCount++;
          return [agentA];
        },
      };
      const handle = createDiscovery([countingSource], 60_000);

      await handle.discover();
      await handle.discover();
      await handle.discover();

      expect(callCount).toBe(1);
    });

    it("refreshes after TTL expires", async () => {
      // let justified: mutable call counter for verification
      let callCount = 0;
      const countingSource: DiscoverySource = {
        name: "counter",
        discover: async () => {
          callCount++;
          return [agentA];
        },
      };
      // TTL of 0 means always expired
      const handle = createDiscovery([countingSource], 0);

      await handle.discover();
      await handle.discover();

      expect(callCount).toBe(2);
    });

    it("invalidate() clears cache", async () => {
      // let justified: mutable call counter for verification
      let callCount = 0;
      const countingSource: DiscoverySource = {
        name: "counter",
        discover: async () => {
          callCount++;
          return [agentA];
        },
      };
      const handle = createDiscovery([countingSource], 60_000);

      await handle.discover();
      expect(callCount).toBe(1);

      handle.invalidate();
      await handle.discover();
      expect(callCount).toBe(2);
    });
  });
});
