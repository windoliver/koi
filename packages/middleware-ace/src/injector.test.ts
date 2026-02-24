import { describe, expect, test } from "bun:test";
import { estimateTokens, selectPlaybooks } from "./injector.js";
import type { Playbook } from "./types.js";

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

describe("estimateTokens", () => {
  test("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  test("rounds up", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

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
