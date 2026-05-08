import { describe, expect, test } from "bun:test";

import type {
  PlaybookEvaluation,
  PlaybookProposal,
  StructuredPlaybook,
  PromotionThresholds,
} from "@koi/ace-types";

import { applyProposalOperations, evaluatePromotion } from "./promotion-gate.js";

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

const structuredPlaybook: StructuredPlaybook = {
  id: "playbook-1",
  title: "Playbook",
  sections: [
    {
      name: "Existing",
      slug: "existing",
      bullets: [
        {
          id: "str-00001",
          content: "first bullet",
          helpful: 2,
          harmful: 1,
          createdAt: 10,
          updatedAt: 10,
        },
        {
          id: "str-00002",
          content: "second bullet",
          helpful: 3,
          harmful: 4,
          createdAt: 11,
          updatedAt: 11,
        },
      ],
    },
    {
      name: "Empty",
      slug: "empty",
      bullets: [],
    },
  ],
  tags: [],
  source: "curated",
  createdAt: 0,
  updatedAt: 0,
  sessionCount: 0,
  version: 1,
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

describe("applyProposalOperations", () => {
  test("applies add operations into an existing section without mutating the input", () => {
    const proposalWithAdd: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "add", section: "Existing", content: "new insight" }],
    };

    const result = applyProposalOperations(structuredPlaybook, proposalWithAdd, 99);

    expect(result).not.toBe(structuredPlaybook);
    expect(structuredPlaybook.sections[0]?.bullets).toHaveLength(2);
    expect(result.sections[0]?.bullets).toHaveLength(3);

    const addedBullet = result.sections[0]?.bullets[2];
    expect(addedBullet?.id).toMatch(/^str-\d{5}$/);
    expect(addedBullet?.content).toBe("new insight");
    expect(addedBullet?.helpful).toBe(0);
    expect(addedBullet?.harmful).toBe(0);
    expect(addedBullet?.createdAt).toBe(99);
    expect(addedBullet?.updatedAt).toBe(99);
  });

  test("reuses an existing section when the add operation section is normalized differently", () => {
    const proposalWithAdd: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "add", section: " Existing ", content: "trimmed insight" }],
    };

    const result = applyProposalOperations(structuredPlaybook, proposalWithAdd, 99);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]?.name).toBe("Existing");
    expect(result.sections[0]?.bullets).toHaveLength(3);
    expect(result.sections[0]?.bullets[2]?.content).toBe("trimmed insight");
  });

  test("creates a brand-new section when add targets a missing section", () => {
    const proposalWithAdd: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "add", section: "New Section", content: "brand new" }],
    };

    const result = applyProposalOperations(structuredPlaybook, proposalWithAdd, 99);

    expect(result.sections).toHaveLength(3);
    expect(result.sections[2]?.name).toBe("New Section");
    expect(result.sections[2]?.slug).toBe("new-section");
    expect(result.sections[2]?.bullets).toHaveLength(1);
    expect(result.sections[2]?.bullets[0]?.content).toBe("brand new");
  });

  test("applies merge operations by combining counters and removing the second bullet", () => {
    const proposalWithMerge: PlaybookProposal = {
      ...proposal,
      operations: [
        {
          kind: "merge",
          bulletIds: ["str-00001", "str-00002"],
          content: "merged bullet",
        },
      ],
    };

    const result = applyProposalOperations(structuredPlaybook, proposalWithMerge, 99);

    expect(result.sections[0]?.bullets).toHaveLength(1);
    expect(result.sections[0]?.bullets[0]?.id).toBe("str-00001");
    expect(result.sections[0]?.bullets[0]?.content).toBe("merged bullet");
    expect(result.sections[0]?.bullets[0]?.helpful).toBe(5);
    expect(result.sections[0]?.bullets[0]?.harmful).toBe(5);
  });

  test("applies prune operations and preserves empty sections", () => {
    const proposalWithPrune: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "prune", bulletId: "str-00002" }],
    };

    const result = applyProposalOperations(structuredPlaybook, proposalWithPrune, 99);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]?.bullets.map((bullet) => bullet.id)).toEqual(["str-00001"]);
    expect(result.sections[1]?.name).toBe("Empty");
    expect(result.sections[1]?.bullets).toEqual([]);
  });

  test("prune keeps a section that becomes empty after removing its last bullet", () => {
    const oneBulletPlaybook: StructuredPlaybook = {
      ...structuredPlaybook,
      sections: [
        {
          ...structuredPlaybook.sections[0]!,
          bullets: [structuredPlaybook.sections[0]!.bullets[0]!],
        },
        structuredPlaybook.sections[1]!,
      ],
    };
    const proposalWithPrune: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "prune", bulletId: "str-00001" }],
    };

    const result = applyProposalOperations(oneBulletPlaybook, proposalWithPrune, 99);

    expect(result.sections[0]?.name).toBe("Existing");
    expect(result.sections[0]?.bullets).toEqual([]);
    expect(result.sections).toHaveLength(2);
  });

  test("applies operations in order against the cloned snapshot", () => {
    const proposalWithOps: PlaybookProposal = {
      ...proposal,
      operations: [
        { kind: "add", section: "Existing", content: "new insight" },
        { kind: "prune", bulletId: "str-00001" },
      ],
    };

    const result = applyProposalOperations(structuredPlaybook, proposalWithOps, 99);

    expect(result.sections[0]?.bullets.map((bullet) => bullet.content)).toEqual([
      "second bullet",
      "new insight",
    ]);
  });

  test("throws when merge references a missing bullet", () => {
    const proposalWithMerge: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "merge", bulletIds: ["str-00001", "missing"], content: "merged" }],
    };

    expect(() => applyProposalOperations(structuredPlaybook, proposalWithMerge, 99)).toThrow(
      /missing bullet/i,
    );
  });

  test("throws when merge references the same bullet twice", () => {
    const proposalWithMerge: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "merge", bulletIds: ["str-00001", "str-00001"], content: "merged" }],
    };

    expect(() => applyProposalOperations(structuredPlaybook, proposalWithMerge, 99)).toThrow(
      /same bullet twice/i,
    );
  });

  test("throws when prune references a missing bullet", () => {
    const proposalWithPrune: PlaybookProposal = {
      ...proposal,
      operations: [{ kind: "prune", bulletId: "missing" }],
    };

    expect(() => applyProposalOperations(structuredPlaybook, proposalWithPrune, 99)).toThrow(
      /missing bullet/i,
    );
  });
});
