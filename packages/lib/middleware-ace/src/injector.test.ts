import { describe, expect, test } from "bun:test";

import type { Playbook } from "@koi/ace-types";

import { formatActivePlaybooksMessage, selectPlaybooks } from "./injector.js";

function playbook(p: Partial<Playbook>): Playbook {
  return {
    id: "id",
    title: "t",
    strategy: "default strategy",
    tags: [],
    confidence: 0.5,
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    version: 1,
    ...p,
  };
}

describe("selectPlaybooks", () => {
  test("returns empty when no playbooks", () => {
    expect(selectPlaybooks([], { maxTokens: 100 })).toEqual([]);
  });

  test("returns empty when budget is non-positive", () => {
    expect(selectPlaybooks([playbook({ id: "a", strategy: "x" })], { maxTokens: 0 })).toEqual([]);
  });

  test("orders by confidence descending", () => {
    const out = selectPlaybooks(
      [
        playbook({ id: "low", confidence: 0.1, strategy: "a" }),
        playbook({ id: "hi", confidence: 0.9, strategy: "b" }),
      ],
      { maxTokens: 1000 },
    );
    expect(out.map((p) => p.id)).toEqual(["hi", "low"]);
  });

  test("skips entries that exceed remaining budget without stopping", () => {
    // Heuristic ≈ 4 chars/token. 200 chars ≈ 50 tokens, "x" ≈ 1 token.
    const big = playbook({ id: "big", confidence: 0.99, strategy: "x".repeat(200) });
    const tiny = playbook({ id: "tiny", confidence: 0.5, strategy: "x" });
    const out = selectPlaybooks([big, tiny], { maxTokens: 5 });
    expect(out.map((p) => p.id)).toEqual(["tiny"]);
  });
});

describe("formatActivePlaybooksMessage", () => {
  test("returns empty string for empty selection", () => {
    expect(formatActivePlaybooksMessage([])).toBe("");
  });

  test("renders bulleted strategies under header", () => {
    const out = formatActivePlaybooksMessage([
      playbook({ id: "a", strategy: "first" }),
      playbook({ id: "b", strategy: "second" }),
    ]);
    expect(out).toBe("[Active Playbooks]\n- first\n- second");
  });
});
