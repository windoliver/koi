import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { applyOperations, createDefaultCurator } from "./curator.js";
import { estimateStructuredTokens } from "./playbook.js";
import type {
  CuratorInput,
  CuratorOperation,
  PlaybookBullet,
  PlaybookSection,
  ReflectionResult,
  StructuredPlaybook,
} from "./types.js";

function makeBullet(overrides?: Partial<PlaybookBullet>): PlaybookBullet {
  return {
    id: "[str-00001]",
    content: "Always validate inputs",
    helpful: 3,
    harmful: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeSection(overrides?: Partial<PlaybookSection>): PlaybookSection {
  return {
    name: "Strategy",
    slug: "str",
    bullets: [
      makeBullet({ id: "[str-00001]", content: "Cache reads" }),
      makeBullet({ id: "[str-00002]", content: "Retry errors" }),
    ],
    ...overrides,
  };
}

function makePlaybook(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
  return {
    id: "pb-1",
    title: "Test Playbook",
    sections: [makeSection()],
    tags: ["tool_call"],
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
    ...overrides,
  };
}

function makeReflection(overrides?: Partial<ReflectionResult>): ReflectionResult {
  return {
    rootCause: "Test cause",
    keyInsight: "Test insight",
    bulletTags: [],
    ...overrides,
  };
}

const clock = (): number => 2000;

describe("applyOperations", () => {
  describe("ADD", () => {
    test("appends new bullet to correct section", async () => {
      const pb = makePlaybook();
      const ops: readonly CuratorOperation[] = [
        { kind: "add", section: "str", content: "New strategy bullet" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      const section = result.sections[0];

      expect(section?.bullets).toHaveLength(3);
      const newBullet = section?.bullets[2];
      expect(newBullet?.content).toBe("New strategy bullet");
      expect(newBullet?.helpful).toBe(0);
      expect(newBullet?.harmful).toBe(0);
      expect(newBullet?.id).toMatch(/^\[str-\d{5}\]$/);
    });

    test("generates correct ID based on existing bullets", async () => {
      const pb = makePlaybook({
        sections: [
          makeSection({
            bullets: [makeBullet({ id: "[str-00005]" })],
          }),
        ],
      });
      const ops: readonly CuratorOperation[] = [
        { kind: "add", section: "str", content: "After 5" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets[1]?.id).toBe("[str-00006]");
    });

    test("skips ADD for unknown section", async () => {
      const pb = makePlaybook();
      const ops: readonly CuratorOperation[] = [
        { kind: "add", section: "nonexistent", content: "Should skip" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(2);
    });
  });

  describe("MERGE", () => {
    test("combines two bullets with summed counters", async () => {
      const pb = makePlaybook({
        sections: [
          makeSection({
            bullets: [
              makeBullet({ id: "[str-00001]", helpful: 3, harmful: 1 }),
              makeBullet({ id: "[str-00002]", helpful: 2, harmful: 0 }),
            ],
          }),
        ],
      });
      const ops: readonly CuratorOperation[] = [
        { kind: "merge", bulletIds: ["[str-00001]", "[str-00002]"], content: "Merged content" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      const section = result.sections[0];

      // Two removed, one added
      expect(section?.bullets).toHaveLength(1);
      const merged = section?.bullets[0];
      expect(merged?.content).toBe("Merged content");
      expect(merged?.helpful).toBe(5); // 3 + 2
      expect(merged?.harmful).toBe(1); // 1 + 0
    });

    test("skips MERGE when bullet IDs not found", async () => {
      const pb = makePlaybook();
      const ops: readonly CuratorOperation[] = [
        { kind: "merge", bulletIds: ["[str-99999]", "[str-88888]"], content: "Should skip" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(2);
    });
  });

  describe("PRUNE", () => {
    test("removes bullet by ID", async () => {
      const pb = makePlaybook({
        sections: [
          makeSection({
            bullets: [makeBullet({ id: "[str-00001]" }), makeBullet({ id: "[str-00002]" })],
          }),
        ],
      });
      const ops: readonly CuratorOperation[] = [{ kind: "prune", bulletId: "[str-00001]" }];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(1);
      expect(result.sections[0]?.bullets[0]?.id).toBe("[str-00002]");
    });

    test("keeps minimum 1 bullet per section", async () => {
      const pb = makePlaybook({
        sections: [
          makeSection({
            bullets: [makeBullet({ id: "[str-00001]" })],
          }),
        ],
      });
      const ops: readonly CuratorOperation[] = [{ kind: "prune", bulletId: "[str-00001]" }];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(1);
    });
  });

  describe("anti-collapse", () => {
    test("auto-prunes lowest-value bullets when over budget", async () => {
      const bullets = Array.from({ length: 20 }, (_, i) =>
        makeBullet({
          id: `[str-${String(i).padStart(5, "0")}]`,
          content: "x".repeat(50),
          helpful: i, // Higher index = higher value
          harmful: 0,
        }),
      );
      const pb = makePlaybook({
        sections: [makeSection({ bullets })],
      });

      // Set a very tight budget
      const result = await applyOperations(pb, [], 100, clock);
      const totalTokens = await estimateStructuredTokens(result);

      expect(totalTokens).toBeLessThanOrEqual(100);
      // Should have kept higher-value bullets
      expect(result.sections[0]?.bullets.length).toBeLessThan(20);
      expect(result.sections[0]?.bullets.length).toBeGreaterThanOrEqual(1);
    });

    test("positive-value bullets survive unless budget forces removal", async () => {
      const pb = makePlaybook({
        sections: [
          makeSection({
            bullets: [
              makeBullet({ id: "[str-00001]", content: "short", helpful: 10, harmful: 0 }),
              makeBullet({ id: "[str-00002]", content: "short", helpful: 5, harmful: 0 }),
            ],
          }),
        ],
      });

      // Generous budget — both should survive
      const result = await applyOperations(pb, [], 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(2);
    });
  });

  describe("immutability", () => {
    test("input playbook is not mutated", async () => {
      const pb = makePlaybook();
      const originalBulletCount = pb.sections[0]?.bullets.length;
      const ops: readonly CuratorOperation[] = [{ kind: "add", section: "str", content: "New" }];

      await applyOperations(pb, ops, 10000, clock);

      expect(pb.sections[0]?.bullets.length).toBe(originalBulletCount);
    });
  });

  describe("edge cases", () => {
    test("empty playbook with ADD creates first bullet", async () => {
      const pb = makePlaybook({
        sections: [makeSection({ bullets: [] })],
      });
      const ops: readonly CuratorOperation[] = [
        { kind: "add", section: "str", content: "First bullet" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(1);
      expect(result.sections[0]?.bullets[0]?.id).toBe("[str-00000]");
    });

    test("all harmful bullets: anti-collapse keeps minimum", async () => {
      const pb = makePlaybook({
        sections: [
          makeSection({
            bullets: [
              makeBullet({ id: "[str-00001]", helpful: 0, harmful: 10 }),
              makeBullet({ id: "[str-00002]", helpful: 0, harmful: 5 }),
            ],
          }),
        ],
      });

      // Even with generous budget, bullets aren't removed just for being harmful
      const result = await applyOperations(pb, [], 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(2);
    });

    test("updates updatedAt timestamp", async () => {
      const pb = makePlaybook({ updatedAt: 1000 });
      const result = await applyOperations(pb, [], 10000, clock);
      expect(result.updatedAt).toBe(2000);
    });

    test("handles ADD by section name (not just slug)", async () => {
      const pb = makePlaybook({
        sections: [makeSection({ name: "Strategy", slug: "str", bullets: [] })],
      });
      const ops: readonly CuratorOperation[] = [
        { kind: "add", section: "Strategy", content: "Via name" },
      ];

      const result = await applyOperations(pb, ops, 10000, clock);
      expect(result.sections[0]?.bullets).toHaveLength(1);
    });
  });
});

describe("createDefaultCurator", () => {
  test("parses valid JSON operations from LLM response", async () => {
    const modelCall = async (_msgs: readonly InboundMessage[]): Promise<string> =>
      JSON.stringify([{ kind: "add", section: "str", content: "New insight" }]);

    const curator = createDefaultCurator(modelCall);
    const input: CuratorInput = {
      playbook: makePlaybook(),
      reflection: makeReflection(),
      tokenBudget: 10000,
    };

    const ops = await curator.curate(input);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ kind: "add", section: "str", content: "New insight" });
  });

  test("throws on malformed LLM response", async () => {
    const modelCall = async (): Promise<string> => "not valid json";

    const curator = createDefaultCurator(modelCall);
    const input: CuratorInput = {
      playbook: makePlaybook(),
      reflection: makeReflection(),
      tokenBudget: 10000,
    };

    await expect(curator.curate(input)).rejects.toThrow(
      "ACE curator: failed to parse LLM response",
    );
  });

  test("filters out operations with unknown section names", async () => {
    const modelCall = async (): Promise<string> =>
      JSON.stringify([
        { kind: "add", section: "str", content: "Valid" },
        { kind: "add", section: "nonexistent", content: "Invalid" },
      ]);

    const curator = createDefaultCurator(modelCall);
    const input: CuratorInput = {
      playbook: makePlaybook(),
      reflection: makeReflection(),
      tokenBudget: 10000,
    };

    const ops = await curator.curate(input);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe("add");
  });

  test("filters out merge ops with invalid bullet IDs", async () => {
    const modelCall = async (): Promise<string> =>
      JSON.stringify([
        { kind: "merge", bulletIds: ["[str-00001]", "[str-99999]"], content: "Bad" },
      ]);

    const curator = createDefaultCurator(modelCall);
    const input: CuratorInput = {
      playbook: makePlaybook(),
      reflection: makeReflection(),
      tokenBudget: 10000,
    };

    const ops = await curator.curate(input);
    expect(ops).toHaveLength(0);
  });

  test("propagates error when LLM throws", async () => {
    const modelCall = async (): Promise<string> => {
      throw new Error("Rate limited");
    };

    const curator = createDefaultCurator(modelCall);
    const input: CuratorInput = {
      playbook: makePlaybook(),
      reflection: makeReflection(),
      tokenBudget: 10000,
    };

    await expect(curator.curate(input)).rejects.toThrow("Rate limited");
  });

  test("passes playbook and reflection to model call message", async () => {
    let capturedMessages: readonly InboundMessage[] = [];
    const modelCall = async (msgs: readonly InboundMessage[]): Promise<string> => {
      capturedMessages = msgs;
      return "[]";
    };

    const curator = createDefaultCurator(modelCall);
    await curator.curate({
      playbook: makePlaybook(),
      reflection: makeReflection({ rootCause: "Test root cause" }),
      tokenBudget: 5000,
    });

    expect(capturedMessages).toHaveLength(1);
    const content = capturedMessages[0]?.content[0];
    if (content?.kind === "text") {
      expect(content.text).toContain("Test root cause");
      expect(content.text).toContain("5000");
    }
  });
});
