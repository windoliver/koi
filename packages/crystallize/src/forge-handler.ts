/**
 * Crystallize -> Forge bridge handler.
 *
 * Evaluates crystallization candidates and produces tool descriptors
 * for high-confidence patterns. Does not create full ToolArtifacts --
 * that is the forge pipeline's job. This bridge surfaces forge-ready
 * descriptions with implementation templates.
 */

import type { ForgeScope, TrustTier } from "@koi/core";
import { computeCrystallizeScore } from "./compute-score.js";
import { generateCompositeImplementation } from "./generate-composite.js";
import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A crystallized tool descriptor ready for the forge pipeline. */
export interface CrystallizedToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly implementation: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly scope: ForgeScope;
  readonly trustTier: TrustTier;
  readonly provenance: {
    readonly source: "crystallize";
    readonly ngramKey: string;
    readonly occurrences: number;
    readonly score: number;
  };
}

export interface CrystallizeForgeConfig {
  /** Minimum confidence (0-1) to auto-forge. Default: 0.9. */
  readonly confidenceThreshold?: number;
  /** Visibility scope for forged tools. */
  readonly scope: ForgeScope;
  /** Trust tier for forged tools. Default: "sandbox". */
  readonly trustTier?: TrustTier;
  /** Max tools forged per session. Default: 3. */
  readonly maxForgedPerSession?: number;
  /** Called when a candidate is forged into a tool descriptor. */
  readonly onForged?: (descriptor: CrystallizedToolDescriptor) => void;
  /** Called when a candidate is suggested but below confidence threshold. */
  readonly onSuggested?: (candidate: CrystallizationCandidate) => void;
}

export interface CrystallizeForgeHandler {
  readonly handleCandidates: (
    candidates: readonly CrystallizationCandidate[],
    now: number,
  ) => readonly CrystallizedToolDescriptor[];
  readonly getForgedCount: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;
const DEFAULT_MAX_FORGED_PER_SESSION = 3;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a forge handler that evaluates crystallization candidates
 * and produces tool descriptors for high-confidence patterns.
 */
export function createCrystallizeForgeHandler(
  config: CrystallizeForgeConfig,
): CrystallizeForgeHandler {
  const threshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxForged = config.maxForgedPerSession ?? DEFAULT_MAX_FORGED_PER_SESSION;
  const trustTier = config.trustTier ?? "sandbox";

  // Mutable state -- tracks forged descriptors to prevent duplicates
  // justified: encapsulated within factory closure
  const forgedNames = new Set<string>();
  let forgedCount = 0; // justified: encapsulated mutable counter

  const handleCandidates = (
    candidates: readonly CrystallizationCandidate[],
    now: number,
  ): readonly CrystallizedToolDescriptor[] => {
    if (forgedCount >= maxForged) return [];

    const results: CrystallizedToolDescriptor[] = [];

    for (const candidate of candidates) {
      if (forgedCount >= maxForged) break;

      // Skip already-forged names
      if (forgedNames.has(candidate.suggestedName)) continue;

      const score = candidate.score ?? computeCrystallizeScore(candidate, now);

      // Confidence: score normalized against theoretical max (recency = 1.0)
      const stepsReduction = Math.max(1, candidate.ngram.steps.length - 1);
      const maxScore = candidate.occurrences * stepsReduction;
      const confidence = maxScore > 0 ? score / maxScore : 0;

      if (confidence >= threshold) {
        const descriptor = createDescriptor(candidate, score, config.scope, trustTier);

        forgedNames.add(candidate.suggestedName);
        forgedCount += 1;
        // justified: mutable local array being constructed, not shared state
        results.push(descriptor);
        config.onForged?.(descriptor);
      } else {
        config.onSuggested?.(candidate);
      }
    }

    return results;
  };

  return {
    handleCandidates,
    getForgedCount: () => forgedCount,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDescriptor(
  candidate: CrystallizationCandidate,
  score: number,
  scope: ForgeScope,
  trustTier: TrustTier,
): CrystallizedToolDescriptor {
  return {
    name: candidate.suggestedName,
    description: `Auto-crystallized composite: ${candidate.ngram.steps.map((s) => s.toolId).join(" \u2192 ")}`,
    implementation: generateCompositeImplementation(candidate),
    inputSchema: {},
    scope,
    trustTier,
    provenance: {
      source: "crystallize",
      ngramKey: candidate.ngram.key,
      occurrences: candidate.occurrences,
      score,
    },
  };
}
