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

  test("confidence equal to threshold does NOT require approval (boundary: < not <=)", () => {
    expect(
      computeCompositionApproval(
        { ...trigger, confidence: 0.5 },
        1,
        {
          confidenceThreshold: 0.5,
          maxEstimatedCost: 10,
          requireApprovalOnNovelty: false,
        },
        { isNovel: false },
      ),
    ).toBe(false);
  });

  test("estimated cost equal to budget does NOT require approval (boundary: > not >=)", () => {
    expect(
      computeCompositionApproval(
        trigger,
        10,
        {
          confidenceThreshold: 0.5,
          maxEstimatedCost: 10,
          requireApprovalOnNovelty: false,
        },
        { isNovel: false },
      ),
    ).toBe(false);
  });

  test("novelty gate is suppressed when requireApprovalOnNovelty is false", () => {
    expect(
      computeCompositionApproval(
        trigger,
        1,
        {
          confidenceThreshold: 0.5,
          maxEstimatedCost: 10,
          requireApprovalOnNovelty: false,
        },
        { isNovel: true },
      ),
    ).toBe(false);
  });
});
