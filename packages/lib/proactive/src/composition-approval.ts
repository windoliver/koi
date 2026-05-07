import type {
  CompositionApprovalContext,
  CompositionApprovalPolicy,
  CompositionTrigger,
} from "@koi/core";

export const DEFAULT_COMPOSITION_APPROVAL_POLICY: CompositionApprovalPolicy = {
  confidenceThreshold: 0.5,
  maxEstimatedCost: 10,
  requireApprovalOnNovelty: true,
};

export function computeCompositionApproval(
  trigger: CompositionTrigger,
  estimatedCost: number,
  policy: CompositionApprovalPolicy,
  context: CompositionApprovalContext,
): boolean {
  if (trigger.confidence < policy.confidenceThreshold) return true;
  if (estimatedCost > policy.maxEstimatedCost) return true;
  if (policy.requireApprovalOnNovelty && context.isNovel) return true;
  return false;
}
