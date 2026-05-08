import { describe, expect, test } from "bun:test";

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PromotionThresholds,
} from "@koi/ace-types";

import { evaluatePromotion } from "./promotion-gate.js";

const proposal: PlaybookProposal = {
  id: "proposal-1",
  playbookId: "playbook-1",
  baseVersion: 3,
  operations: [],
  sourceTrajectoryRange: {
    sessionId: "session-1",
    fromStepIndex: 0,
    toStepIndex: 2,
  },
  reflection: {
    rootCause: "cause",
    keyInsight: "insight",
    bulletTags: [],
  },
  createdAt: 1,
};

const thresholds: PromotionThresholds = {
  minHelpfulRate: 0.6,
  maxHarmfulRate: 0.2,
  minTrials: 5,
};

function evaluation(
  overrides: Partial<PlaybookEvaluation> & { readonly metrics?: Record<string, number> } = {},
): PlaybookEvaluation {
  return {
    id: "evaluation-1",
    proposalId: "proposal-1",
    verdict: "promote",
    metrics: {
      helpfulRate: 0.7,
      harmfulRate: 0.1,
      trials: 5,
      tokenDelta: 10,
    },
    evaluatedAt: 2,
    ...overrides,
    metrics: {
      helpfulRate: 0.7,
      harmfulRate: 0.1,
      trials: 5,
      tokenDelta: 10,
      ...(overrides.metrics ?? {}),
    },
  };
}

describe("evaluatePromotion", () => {
  test("throws when proposal id is empty", async () => {
    await expect(
      evaluatePromotion({ ...proposal, id: "" }, evaluation(), thresholds),
    ).rejects.toThrow(/proposal\.id/i);
  });

  test("throws when evaluation id is empty", async () => {
    await expect(
      evaluatePromotion(proposal, evaluation({ id: "" }), thresholds),
    ).rejects.toThrow(/evaluation\.id/i);
  });

  test("throws when evaluation proposal id mismatches", async () => {
    await expect(
      evaluatePromotion(proposal, evaluation({ proposalId: "other-proposal" }), thresholds),
    ).rejects.toThrow(/proposalId/i);
  });

  test("returns reject for a reject verdict", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ verdict: "reject" }),
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns rollback for a rollback verdict", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ verdict: "rollback" }),
        thresholds,
      ),
    ).resolves.toBe("rollback");
  });

  test("returns reject for an unknown verdict", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        {
          ...evaluation(),
          verdict: "promote-now" as unknown as PlaybookEvaluation["verdict"],
        },
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when promote verdict is missing a required metric", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ metrics: { helpfulRate: undefined as unknown as number, harmfulRate: 0.1, trials: 5 } }),
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when helpfulRate is below minHelpfulRate", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ metrics: { helpfulRate: 0.59, harmfulRate: 0.1, trials: 5 } }),
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when trials is below minTrials", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ metrics: { helpfulRate: 0.7, harmfulRate: 0.1, trials: 4 } }),
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when promote verdict has undefined metrics", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        {
          ...evaluation(),
          metrics: undefined as unknown as PlaybookEvaluation["metrics"],
        },
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when promote verdict has null metrics", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        {
          ...evaluation(),
          metrics: null as unknown as PlaybookEvaluation["metrics"],
        },
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when thresholds are non-finite", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation(),
        { minHelpfulRate: Number.NaN, maxHarmfulRate: 0.2, minTrials: 5 },
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when promote verdict violates thresholds", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ metrics: { helpfulRate: 0.7, harmfulRate: 0.3, trials: 5 } }),
        thresholds,
      ),
    ).resolves.toBe("reject");
  });

  test("returns promote when promote verdict meets thresholds", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation(),
        thresholds,
      ),
    ).resolves.toBe("promote");
  });

  test("returns promote at exact threshold boundaries", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({
          metrics: { helpfulRate: 0.6, harmfulRate: 0.2, trials: 5, tokenDelta: 10 },
        }),
        { ...thresholds, maxTokenDelta: 10 },
      ),
    ).resolves.toBe("promote");
  });

  test("returns reject when token delta exceeds the configured maximum", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ metrics: { tokenDelta: 11 } }),
        { ...thresholds, maxTokenDelta: 10 },
      ),
    ).resolves.toBe("reject");
  });

  test("returns reject when token delta is missing and the maximum is configured", async () => {
    await expect(
      evaluatePromotion(
        proposal,
        evaluation({ metrics: { tokenDelta: undefined as unknown as number } }),
        { ...thresholds, maxTokenDelta: 10 },
      ),
    ).resolves.toBe("reject");
  });
});
