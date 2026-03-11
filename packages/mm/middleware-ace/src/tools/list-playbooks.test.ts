import { describe, expect, test } from "bun:test";
import { createInMemoryPlaybookStore, createInMemoryStructuredPlaybookStore } from "../stores.js";
import type { Playbook, StructuredPlaybook } from "../types.js";
import { createListPlaybooksTool } from "./list-playbooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlaybook(overrides?: Partial<Playbook>): Playbook {
  return {
    id: "pb-1",
    title: "Test Playbook",
    strategy: "Do the thing",
    tags: ["test"],
    confidence: 0.8,
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 3,
    ...overrides,
  };
}

function makeStructuredPlaybook(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
  return {
    id: "sp-1",
    title: "Structured Playbook",
    sections: [
      {
        name: "Section A",
        slug: "section-a",
        bullets: [
          {
            id: "b-1",
            content: "Always validate input",
            helpful: 5,
            harmful: 0,
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
      },
    ],
    tags: ["structured"],
    source: "curated",
    createdAt: 1000,
    updatedAt: 2000,
    sessionCount: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: stat-based playbooks
// ---------------------------------------------------------------------------

describe("createListPlaybooksTool (stat-based)", () => {
  test("returns empty result from empty store", async () => {
    const store = createInMemoryPlaybookStore();
    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({})) as { kind: string; count: number };
    expect(result.kind).toBe("stat");
    expect(result.count).toBe(0);
  });

  test("returns all playbooks sorted by confidence descending", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "low", confidence: 0.3 }));
    await store.save(makePlaybook({ id: "high", confidence: 0.9 }));
    await store.save(makePlaybook({ id: "mid", confidence: 0.6 }));

    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({})) as {
      kind: string;
      count: number;
      playbooks: readonly { id: string; confidence: number }[];
    };

    expect(result.count).toBe(3);
    expect(result.playbooks[0]?.id).toBe("high");
    expect(result.playbooks[1]?.id).toBe("mid");
    expect(result.playbooks[2]?.id).toBe("low");
  });

  test("filters by minConfidence", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "high", confidence: 0.9 }));
    await store.save(makePlaybook({ id: "low", confidence: 0.2 }));

    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({ minConfidence: 0.5 })) as {
      count: number;
      playbooks: readonly { id: string }[];
    };

    expect(result.count).toBe(1);
    expect(result.playbooks[0]?.id).toBe("high");
  });

  test("filters by tags", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "perf", tags: ["perf"] }));
    await store.save(makePlaybook({ id: "safety", tags: ["safety"] }));

    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({ tags: ["perf"] })) as {
      count: number;
      playbooks: readonly { id: string }[];
    };

    expect(result.count).toBe(1);
    expect(result.playbooks[0]?.id).toBe("perf");
  });

  test("respects limit parameter", async () => {
    const store = createInMemoryPlaybookStore();
    for (let i = 0; i < 30; i++) {
      await store.save(makePlaybook({ id: `pb-${String(i)}`, confidence: i / 30 }));
    }

    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({ limit: 5 })) as {
      count: number;
      playbooks: readonly { confidence: number }[];
    };

    expect(result.count).toBe(5);
    // Should be top-5 by confidence (descending)
    expect(result.playbooks[0]?.confidence).toBeGreaterThan(result.playbooks[4]?.confidence ?? 0);
  });

  test("uses default limit of 20", async () => {
    const store = createInMemoryPlaybookStore();
    for (let i = 0; i < 25; i++) {
      await store.save(makePlaybook({ id: `pb-${String(i)}` }));
    }

    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({})) as { count: number };

    expect(result.count).toBe(20);
  });

  test("clamps minConfidence to 0-1 range", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "any", confidence: 0.5 }));

    const tool = createListPlaybooksTool({ playbookStore: store });

    // minConfidence > 1 clamped to 1 — nothing matches
    const resultHigh = (await tool.execute({ minConfidence: 5 })) as { count: number };
    expect(resultHigh.count).toBe(0);

    // minConfidence < 0 clamped to 0 — everything matches
    const resultLow = (await tool.execute({ minConfidence: -1 })) as { count: number };
    expect(resultLow.count).toBe(1);
  });

  test("ignores invalid tags gracefully", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(makePlaybook({ id: "pb-1" }));

    const tool = createListPlaybooksTool({ playbookStore: store });

    // Non-array tags ignored — returns all
    const result = (await tool.execute({ tags: "not-an-array" })) as { count: number };
    expect(result.count).toBe(1);
  });

  test("returns full playbook metadata", async () => {
    const store = createInMemoryPlaybookStore();
    await store.save(
      makePlaybook({
        id: "pb-1",
        title: "Performance Strategy",
        strategy: "Cache everything",
        confidence: 0.85,
        tags: ["perf", "cache"],
        sessionCount: 7,
        source: "curated",
      }),
    );

    const tool = createListPlaybooksTool({ playbookStore: store });
    const result = (await tool.execute({})) as {
      playbooks: readonly {
        id: string;
        title: string;
        strategy: string;
        confidence: number;
        tags: readonly string[];
        sessionCount: number;
        source: string;
      }[];
    };

    const pb = result.playbooks[0];
    expect(pb?.id).toBe("pb-1");
    expect(pb?.title).toBe("Performance Strategy");
    expect(pb?.strategy).toBe("Cache everything");
    expect(pb?.confidence).toBe(0.85);
    expect(pb?.tags).toEqual(["perf", "cache"]);
    expect(pb?.sessionCount).toBe(7);
    expect(pb?.source).toBe("curated");
  });
});

// ---------------------------------------------------------------------------
// Tests: structured playbooks (preferred when available)
// ---------------------------------------------------------------------------

describe("createListPlaybooksTool (structured)", () => {
  test("prefers structured store when available", async () => {
    const statStore = createInMemoryPlaybookStore();
    await statStore.save(makePlaybook({ id: "stat-1" }));

    const structuredStore = createInMemoryStructuredPlaybookStore();
    await structuredStore.save(makeStructuredPlaybook({ id: "struct-1" }));

    const tool = createListPlaybooksTool({
      playbookStore: statStore,
      structuredPlaybookStore: structuredStore,
    });

    const result = (await tool.execute({})) as {
      kind: string;
      count: number;
      playbooks: readonly { id: string }[];
    };

    expect(result.kind).toBe("structured");
    expect(result.count).toBe(1);
    expect(result.playbooks[0]?.id).toBe("struct-1");
  });

  test("returns bullet-level detail for structured playbooks", async () => {
    const structuredStore = createInMemoryStructuredPlaybookStore();
    await structuredStore.save(makeStructuredPlaybook());

    const tool = createListPlaybooksTool({
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore: structuredStore,
    });

    const result = (await tool.execute({})) as {
      kind: string;
      playbooks: readonly {
        sections: readonly {
          name: string;
          bulletCount: number;
          bullets: readonly { id: string; content: string; helpful: number; harmful: number }[];
        }[];
      }[];
    };

    const section = result.playbooks[0]?.sections[0];
    expect(section?.name).toBe("Section A");
    expect(section?.bulletCount).toBe(1);
    expect(section?.bullets[0]?.content).toBe("Always validate input");
    expect(section?.bullets[0]?.helpful).toBe(5);
    expect(section?.bullets[0]?.harmful).toBe(0);
  });

  test("sorts structured playbooks by sessionCount descending", async () => {
    const structuredStore = createInMemoryStructuredPlaybookStore();
    await structuredStore.save(makeStructuredPlaybook({ id: "low", sessionCount: 1 }));
    await structuredStore.save(makeStructuredPlaybook({ id: "high", sessionCount: 10 }));

    const tool = createListPlaybooksTool({
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore: structuredStore,
    });

    const result = (await tool.execute({})) as {
      playbooks: readonly { id: string; sessionCount: number }[];
    };

    expect(result.playbooks[0]?.id).toBe("high");
    expect(result.playbooks[1]?.id).toBe("low");
  });

  test("filters structured playbooks by tags", async () => {
    const structuredStore = createInMemoryStructuredPlaybookStore();
    await structuredStore.save(makeStructuredPlaybook({ id: "perf", tags: ["perf"] }));
    await structuredStore.save(makeStructuredPlaybook({ id: "safety", tags: ["safety"] }));

    const tool = createListPlaybooksTool({
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore: structuredStore,
    });

    const result = (await tool.execute({ tags: ["perf"] })) as {
      count: number;
      playbooks: readonly { id: string }[];
    };

    expect(result.count).toBe(1);
    expect(result.playbooks[0]?.id).toBe("perf");
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe("createListPlaybooksTool (error handling)", () => {
  test("returns error when stat store throws", async () => {
    const failingStore = createInMemoryPlaybookStore();
    failingStore.list = () => {
      throw new Error("connection lost");
    };

    const tool = createListPlaybooksTool({ playbookStore: failingStore });
    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.error).toBe("connection lost");
    expect(result.code).toBe("INTERNAL");
  });

  test("returns error when structured store throws", async () => {
    const failingStructuredStore = createInMemoryStructuredPlaybookStore();
    failingStructuredStore.list = () => {
      throw new Error("structured store unavailable");
    };

    const tool = createListPlaybooksTool({
      playbookStore: createInMemoryPlaybookStore(),
      structuredPlaybookStore: failingStructuredStore,
    });
    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.error).toBe("structured store unavailable");
    expect(result.code).toBe("INTERNAL");
  });

  test("returns stringified error for non-Error throws", async () => {
    const failingStore = createInMemoryPlaybookStore();
    failingStore.list = () => {
      throw "raw string error";
    };

    const tool = createListPlaybooksTool({ playbookStore: failingStore });
    const result = (await tool.execute({})) as { error: string; code: string };

    expect(result.error).toBe("raw string error");
    expect(result.code).toBe("INTERNAL");
  });
});

// ---------------------------------------------------------------------------
// Tests: tool descriptor
// ---------------------------------------------------------------------------

describe("list_playbooks tool descriptor", () => {
  test("has correct name and description", () => {
    const tool = createListPlaybooksTool({
      playbookStore: createInMemoryPlaybookStore(),
    });

    expect(tool.descriptor.name).toBe("list_playbooks");
    expect(tool.descriptor.description).toContain("learned playbooks");
    expect(tool.origin).toBe("primordial");
  });

  test("has correct input schema properties", () => {
    const tool = createListPlaybooksTool({
      playbookStore: createInMemoryPlaybookStore(),
    });

    const schema = tool.descriptor.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty("tags");
    expect(schema.properties).toHaveProperty("minConfidence");
    expect(schema.properties).toHaveProperty("limit");
  });
});
