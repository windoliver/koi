/**
 * Confidence evaluator factory functions for cascade routing.
 *
 * Three built-in evaluators + a compositor:
 * - Length heuristic: scores based on response content length
 * - Keyword: penalizes uncertainty/refusal markers
 * - Verbalized: asks an LLM to self-rate confidence
 * - Compose: aggregates multiple evaluators
 */

import type { ModelRequest, ModelResponse } from "@koi/core";
import type { ProviderAdapter } from "../provider-adapter.js";
import type { CascadeEvaluationResult, CascadeEvaluator } from "./cascade-types.js";

// ---------------------------------------------------------------------------
// Length heuristic evaluator
// ---------------------------------------------------------------------------

export interface LengthHeuristicOptions {
  readonly minLength?: number;
  readonly targetLength?: number;
}

const LENGTH_DEFAULTS = {
  minLength: 10,
  targetLength: 200,
} as const;

export function createLengthHeuristicEvaluator(options?: LengthHeuristicOptions): CascadeEvaluator {
  const minLength = options?.minLength ?? LENGTH_DEFAULTS.minLength;
  const targetLength = options?.targetLength ?? LENGTH_DEFAULTS.targetLength;

  return (_request: ModelRequest, response: ModelResponse): CascadeEvaluationResult => {
    const length = response.content.trim().length;

    if (length < minLength) {
      return { confidence: 0, reason: `Response too short (${length} < ${minLength})` };
    }

    if (length >= targetLength) {
      return { confidence: 1, reason: "Response meets target length" };
    }

    // Linear interpolation between minLength and targetLength
    const confidence = (length - minLength) / (targetLength - minLength);
    return {
      confidence,
      reason: `Length ${length} between min ${minLength} and target ${targetLength}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Keyword evaluator
// ---------------------------------------------------------------------------

export interface KeywordEvaluatorOptions {
  readonly uncertaintyMarkers?: readonly string[];
  readonly penaltyPerMarker?: number;
}

const DEFAULT_UNCERTAINTY_MARKERS: readonly string[] = [
  "i'm not sure",
  "i don't know",
  "it depends",
  "i cannot",
  "i can't",
  "as an ai",
  "i apologize",
  "i'm unable",
  "i am not sure",
  "i am unable",
] as const;

const KEYWORD_DEFAULTS = {
  penaltyPerMarker: 0.2,
} as const;

export function createKeywordEvaluator(options?: KeywordEvaluatorOptions): CascadeEvaluator {
  const markers = options?.uncertaintyMarkers ?? DEFAULT_UNCERTAINTY_MARKERS;
  const penalty = options?.penaltyPerMarker ?? KEYWORD_DEFAULTS.penaltyPerMarker;

  return (_request: ModelRequest, response: ModelResponse): CascadeEvaluationResult => {
    const lower = response.content.toLowerCase();
    let matchCount = 0;
    const matched: string[] = [];

    for (const marker of markers) {
      if (lower.includes(marker.toLowerCase())) {
        matchCount++;
        matched.push(marker);
      }
    }

    const confidence = Math.max(0, Math.min(1, 1 - matchCount * penalty));
    return {
      confidence,
      reason:
        matchCount > 0 ? `Matched markers: ${matched.join(", ")}` : "No uncertainty markers found",
      metadata: { matchCount, matched },
    };
  };
}

// ---------------------------------------------------------------------------
// Verbalized evaluator
// ---------------------------------------------------------------------------

export interface VerbalizedEvaluatorOptions {
  readonly timeoutMs?: number;
  readonly model?: string;
}

const CONFIDENCE_PROMPT =
  "Rate your confidence in the above answer from 0.0 to 1.0. " +
  "Reply with ONLY a decimal number, nothing else.";

export function createVerbalizedEvaluator(
  adapter: ProviderAdapter,
  options?: VerbalizedEvaluatorOptions,
): CascadeEvaluator {
  return async (
    request: ModelRequest,
    response: ModelResponse,
  ): Promise<CascadeEvaluationResult> => {
    const evalRequest: ModelRequest = {
      messages: [
        ...request.messages,
        {
          content: [{ kind: "text" as const, text: response.content }],
          senderId: "assistant",
          timestamp: Date.now(),
        },
        {
          content: [{ kind: "text" as const, text: CONFIDENCE_PROMPT }],
          senderId: "system",
          timestamp: Date.now(),
        },
      ],
      ...(options?.model !== undefined ? { model: options.model } : {}),
      ...(options?.timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    };

    const evalResponse = await adapter.complete(evalRequest);
    const parsed = Number.parseFloat(evalResponse.content.trim());

    if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
      return {
        confidence: 0.5,
        reason: `Non-numeric or out-of-range response: "${evalResponse.content.trim()}"`,
      };
    }

    return { confidence: parsed, reason: "Verbalized confidence" };
  };
}

// ---------------------------------------------------------------------------
// Evaluator composition
// ---------------------------------------------------------------------------

export type CompositionStrategy = "min" | "average" | "weighted";

export interface WeightedEvaluator {
  readonly evaluator: CascadeEvaluator;
  readonly weight: number;
}

export function composeEvaluators(
  evaluators: readonly (CascadeEvaluator | WeightedEvaluator)[],
  strategy: CompositionStrategy = "min",
): CascadeEvaluator {
  return async (
    request: ModelRequest,
    response: ModelResponse,
  ): Promise<CascadeEvaluationResult> => {
    const results: { readonly confidence: number; readonly weight: number }[] = [];
    const skipped: string[] = [];

    for (const entry of evaluators) {
      const evaluator = typeof entry === "function" ? entry : entry.evaluator;
      const weight = typeof entry === "function" ? 1 : entry.weight;

      try {
        const result = await evaluator(request, response);
        results.push({ confidence: result.confidence, weight });
      } catch (error: unknown) {
        // Skip failing evaluators — degrade gracefully, record for diagnostics
        skipped.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (results.length === 0) {
      return {
        confidence: 0,
        reason: `All evaluators failed: ${skipped.join("; ")}`,
      };
    }

    let confidence: number;
    switch (strategy) {
      case "min":
        confidence = Math.min(...results.map((r) => r.confidence));
        break;
      case "average":
        confidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
        break;
      case "weighted": {
        const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
        confidence =
          totalWeight > 0
            ? results.reduce((sum, r) => sum + r.confidence * r.weight, 0) / totalWeight
            : 0;
        break;
      }
    }

    const skipNote =
      skipped.length > 0 ? ` (${skipped.length} skipped: ${skipped.join("; ")})` : "";
    return {
      confidence,
      reason: `Composed (${strategy}): ${results.map((r) => r.confidence.toFixed(2)).join(", ")}${skipNote}`,
    };
  };
}
