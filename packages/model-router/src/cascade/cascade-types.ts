/**
 * Types for the cascade routing strategy.
 *
 * Cascade tries the cheapest model first, evaluates response quality
 * via a pluggable confidence evaluator, and escalates to progressively
 * more expensive models only when confidence is insufficient.
 */

import type { JsonObject, ModelRequest, ModelResponse } from "@koi/core";

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a model response for confidence.
 * Confidence is a number between 0.0 (no confidence) and 1.0 (full confidence).
 */
export interface CascadeEvaluationResult {
  readonly confidence: number;
  readonly reason?: string;
  readonly metadata?: JsonObject;
}

/**
 * Evaluates a model response and returns a confidence score.
 * May be sync (keyword matching) or async (LLM-based evaluation).
 */
export type CascadeEvaluator = (
  request: ModelRequest,
  response: ModelResponse,
) => CascadeEvaluationResult | Promise<CascadeEvaluationResult>;

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

export interface CascadeTierConfig {
  readonly targetId: string;
  readonly costPerInputToken?: number;
  readonly costPerOutputToken?: number;
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Cascade configuration (user-facing + resolved)
// ---------------------------------------------------------------------------

export interface CascadeConfig {
  readonly tiers: readonly CascadeTierConfig[];
  readonly confidenceThreshold: number;
  readonly maxEscalations?: number;
  readonly budgetLimitTokens?: number;
  readonly evaluatorTimeoutMs?: number;
}

export interface ResolvedCascadeConfig {
  readonly tiers: readonly CascadeTierConfig[];
  readonly confidenceThreshold: number;
  readonly maxEscalations: number;
  readonly budgetLimitTokens: number;
  readonly evaluatorTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Cascade execution results
// ---------------------------------------------------------------------------

export interface CascadeAttempt {
  readonly tierId: string;
  readonly success: boolean;
  readonly confidence?: number;
  readonly escalated: boolean;
  readonly error?: string;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CascadeResult {
  readonly response: ModelResponse;
  readonly tierId: string;
  readonly tierIndex: number;
  readonly confidence: number;
  readonly attempts: readonly CascadeAttempt[];
  readonly totalEscalations: number;
}

// ---------------------------------------------------------------------------
// Cost metrics
// ---------------------------------------------------------------------------

export interface TierCostMetrics {
  readonly tierId: string;
  readonly requests: number;
  readonly escalations: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly estimatedCost: number;
}

export interface CascadeCostMetrics {
  readonly tiers: readonly TierCostMetrics[];
  readonly totalRequests: number;
  readonly totalEscalations: number;
  readonly totalEstimatedCost: number;
}

// ---------------------------------------------------------------------------
// Pre-request complexity classification
// ---------------------------------------------------------------------------

export type ComplexityTier = "LIGHT" | "MEDIUM" | "HEAVY";

export interface ClassificationResult {
  readonly score: number;
  /** Sigmoid-mapped confidence in the tier assignment (0.0–1.0). Low values indicate the score is near a tier boundary. */
  readonly confidence: number;
  readonly tier: ComplexityTier;
  readonly recommendedTierIndex: number;
  readonly reason: string;
  readonly dimensions?: JsonObject;
}

/**
 * Synchronous pre-request classifier that scores request complexity.
 * Must complete in <1ms — pure heuristics, zero LLM calls.
 * Receives `tierCount` so it can compute `recommendedTierIndex` without knowing config internals.
 */
export type CascadeClassifier = (request: ModelRequest, tierCount: number) => ClassificationResult;
