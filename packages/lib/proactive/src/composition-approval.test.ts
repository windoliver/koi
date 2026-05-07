import { describe, expect, test } from "bun:test";
import type { CompositionTrigger } from "@koi/core";
import { computeCompositionApproval } from "./composition-approval.js";

const trigger: CompositionTrigger = {
  id: "t-1",
  source: "governance",
  confidence: 0.9,
  moment: { kind: "capability_gap", missing: "diagnostics" },
  suggestedCapabilities: [],
  context: {},
  emittedAt: 1,
};

describe("computeCompositionApproval", () => {
  test("requires approval below confidence threshold", () => {
    expect(
      computeCompositionApproval(
        { ...trigger, confidence: 0.2 },
        1,
        {
          confidenceThreshold: 0.5,
          maxEstimatedCost: 10,
          requireApprovalOnNovelty: false,
        },
        { isNovel: false },
      ),
    ).toBe(true);
  });

  test("requires approval above cost budget", () => {
    expect(
      computeCompositionApproval(
        trigger,
        100,
        {
          confidenceThreshold: 0.5,
          maxEstimatedCost: 10,
          requireApprovalOnNovelty: false,
        },
        { isNovel: false },
      ),
    ).toBe(true);
  });

  test("requires approval on novelty when configured", () => {
    expect(
      computeCompositionApproval(
        trigger,
        1,
        {
          confidenceThreshold: 0.5,
          maxEstimatedCost: 10,
          requireApprovalOnNovelty: true,
        },
        { isNovel: true },
      ),
    ).toBe(true);
  });
});
