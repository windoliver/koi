/**
 * Generate a TypeScript implementation for a crystallized composite tool.
 *
 * Uses the shared pipeline executor for reliable step-by-step execution
 * with error handling and partial results.
 */

import { generatePipelineExecutorCode } from "./pipeline-executor.js";
import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Implementation generation
// ---------------------------------------------------------------------------

/**
 * Generate a composite tool implementation string.
 * Delegates to the shared pipeline executor for execution.
 */
export function generateCompositeImplementation(candidate: CrystallizationCandidate): string {
  return generatePipelineExecutorCode(candidate.ngram.steps, candidate.occurrences);
}
