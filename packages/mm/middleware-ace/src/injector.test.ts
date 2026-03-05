import { describe, expect, test } from "bun:test";
import { selectPlaybooks, selectStructuredPlaybooks } from "./injector.js";
import type { Playbook, StructuredPlaybook } from "./types.js";

// estimateTokens canonical tests live in @koi/token-estimator.

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
    sessionCount: 1,
    ...overrides,
  };
}

describe("selectPlaybooks", () => {
  const clock = (): number => 1000;

  test("returns empty for no available playbooks", () => {
    const result = selectPlaybooks([], { maxTokens: 500, clock });
    expect(result).toHaveLength(0);
  });

  test("selects playbooks within token budget", () => {
    const playbooks = [
      makePlaybook({ id: "pb-1", strategy: "a".repeat(100), confidence: 0.9 }),
      makePlaybook({ id: "pb-2", strategy: "b".repeat(100), confidence: 0.8 }),
    ];
    const result = selectPlaybooks(playbooks, { maxTokens: 500, clock });
    expect(result).toHaveLength(2);
  });

  test("respects token budget limit", () => {
    const playbooks = [
      makePlaybook({ id: "pb-1", strategy: "a".repeat(400), confidence: 0.9 }),
      makePlaybook({ id: "pb-2", strategy: "b".repeat(400), confidence: 0.8 }),
    ];
    // 400 chars = 100 tokens each; budget is 120 → only 1 fits
    const result = selectPlaybooks(playbooks, { maxTokens: 120, clock });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("pb-1");
  });

  test("prioritizes by confidence descending", () => {
    const playbooks = [
      makePlaybook({ id: "low", strategy: "x".repeat(40), confidence: 0.3 }),
      makePlaybook({ id: "high", strategy: "x".repeat(40), confidence: 0.9 }),
      makePlaybook({ id: "mid", strategy: "x".repeat(40), confidence: 0.6 }),
    ];
    const result = selectPlaybooks(playbooks, { maxTokens: 500, clock });
    expect(result[0]?.id).toBe("high");
    expect(result[1]?.id).toBe("mid");
    expect(result[2]?.id).toBe("low");
  });

  test("skips large playbooks that exceed remaining budget", () => {
    const playbooks = [
      makePlaybook({ id: "big", strategy: "a".repeat(800), confidence: 0.9 }),
      makePlaybook({ id: "small", strategy: "b".repeat(40), confidence: 0.5 }),
    ];
    // 800 chars = 200 tokens (exceeds 100); 40 chars = 10 tokens (fits)
    const result = selectPlaybooks(playbooks, { maxTokens: 100, clock });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("small");
  });

  test("returns nothing when budget is 0", () => {
    const playbooks = [makePlaybook()];
    const result = selectPlaybooks(playbooks, { maxTokens: 0, clock });
    expect(result).toHaveLength(0);
  });

  test("handles playbook with empty strategy", () => {
    const playbooks = [makePlaybook({ strategy: "" })];
    const result = selectPlaybooks(playbooks, { maxTokens: 500, clock });
    expect(result).toHaveLength(1);
  });

  test("does not mutate input array", () => {
    const playbooks = [
      makePlaybook({ id: "a", confidence: 0.3 }),
      makePlaybook({ id: "b", confidence: 0.9 }),
    ];
    const original = [...playbooks];
    selectPlaybooks(playbooks, { maxTokens: 500, clock });
    expect(playbooks).toEqual(original);
  });
});

function makeStructuredPlaybook(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
  return {
    id: "sp-1",
    title: "Test Structured",
    sections: [
      {
        name: "Strategies",
        slug: "strategies",
        bullets: [
          {
            id: "[strategies-00001]",
            content: "a".repeat(100),
            helpful: 1,
            harmful: 0,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      },
    ],
    tags: [],
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
    ...overrides,
  };
}

describe("selectStructuredPlaybooks", () => {
  test("returns empty for no available playbooks", () => {
    const result = selectStructuredPlaybooks([], 500);
    expect(result).toHaveLength(0);
  });

  test("returns empty when remaining budget is 0", () => {
    const result = selectStructuredPlaybooks([makeStructuredPlaybook()], 0);
    expect(result).toHaveLength(0);
  });

  test("selects playbooks within remaining budget", () => {
    const small = makeStructuredPlaybook({
      id: "sp-small",
      sections: [
        {
          name: "Tips",
          slug: "tips",
          bullets: [
            {
              id: "[tips-00001]",
              content: "short",
              helpful: 1,
              harmful: 0,
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
        },
      ],
    });
    const result = selectStructuredPlaybooks([small], 500);
    expect(result).toHaveLength(1);
  });

  test("skips playbooks that exceed remaining budget", () => {
    const large = makeStructuredPlaybook({
      id: "sp-large",
      sections: [
        {
          name: "Big",
          slug: "big",
          bullets: [
            {
              id: "[big-00001]",
              content: "x".repeat(2000),
              helpful: 1,
              harmful: 0,
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
        },
      ],
    });
    const small = makeStructuredPlaybook({
      id: "sp-small",
      sections: [
        {
          name: "Small",
          slug: "small",
          bullets: [
            {
              id: "[small-00001]",
              content: "tiny",
              helpful: 1,
              harmful: 0,
              createdAt: 1000,
              updatedAt: 1000,
            },
          ],
        },
      ],
    });
    // Budget only allows the small one (2000 chars = 500 tokens for large, 4 chars = 1 token for small)
    const result = selectStructuredPlaybooks([large, small], 50);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("sp-small");
  });
});
