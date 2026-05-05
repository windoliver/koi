import { describe, expect, test } from "bun:test";
import { makeCandidate, makeConfig } from "./__tests__/fixtures.js";
import { createPolicyEvaluator } from "./evaluator.js";

describe("createPolicyEvaluator — same-instance-by-construction", () => {
  test("evaluateAndRecord persists into the bundled log without brand mismatch", () => {
    const { evaluateAndRecord, log } = createPolicyEvaluator();
    const { evaluation, entry } = evaluateAndRecord({
      candidate: makeCandidate(),
      config: makeConfig(),
      evaluatedAt: 1_700_000_000_000,
    });
    expect(evaluation.verdict.decision).toBe("allow");
    expect(log.size()).toBe(1);
    expect(entry.candidateId).toBe(evaluation.candidateId);
    expect(log.entries()[0]?.sequence).toBe(0);
  });

  test("audit options are forwarded to the bundled log", () => {
    const dropped: number[] = [];
    const { evaluateAndRecord, log } = createPolicyEvaluator({
      maxEntries: 2,
      onOverflow: (_entry, totalDropped) => {
        dropped.push(totalDropped);
      },
    });
    for (let i = 0; i < 4; i++) {
      evaluateAndRecord({
        candidate: makeCandidate({ id: `c-${i}` }),
        config: makeConfig(),
        evaluatedAt: 1_700_000_000_000 + i,
      });
    }
    expect(log.size()).toBe(2);
    expect(dropped).toEqual([1, 2]);
  });
});
