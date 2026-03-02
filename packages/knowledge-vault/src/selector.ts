/**
 * Token-budget-aware document selector.
 *
 * Greedy selection with diversity guarantee: each source gets at least
 * 1 document (highest-scored), then remaining budget fills by global
 * relevance score.
 */

import type { TokenEstimator } from "@koi/core";

import type { KnowledgeDocument, KnowledgeSourceInfo } from "./types.js";

/** Result of budget-aware selection. */
export interface SelectionResult {
  readonly selected: readonly KnowledgeDocument[];
  readonly totalTokens: number;
  readonly dropped: readonly string[];
}

/** Input document with source attribution for diversity guarantee. */
export interface ScoredDocument {
  readonly document: KnowledgeDocument;
  readonly sourceIndex: number;
}

/**
 * Select documents within a token budget.
 *
 * Algorithm:
 * 1. First pass: guarantee 1 doc from each source (highest-scored per source).
 * 2. Second pass: fill remaining budget by global relevance (greedy, skip-and-continue).
 * 3. Return selected docs ordered by relevance score (descending).
 */
export function selectWithinBudget(
  documents: readonly ScoredDocument[],
  sources: readonly KnowledgeSourceInfo[],
  budget: number,
  estimator: TokenEstimator,
): SelectionResult {
  if (budget <= 0 || documents.length === 0) {
    return { selected: [], totalTokens: 0, dropped: documents.map((d) => d.document.path) };
  }

  // Sort all documents by relevance descending
  const sorted = [...documents].sort(
    (a, b) => b.document.relevanceScore - a.document.relevanceScore,
  );

  const selectedSet = new Set<string>();
  const selectedDocs: KnowledgeDocument[] = [];
  // let is required — tracking running token total
  let usedTokens = 0;

  // Pass 1: diversity guarantee — best doc from each source
  for (
    // let is required — loop counter for source index
    let sourceIdx = 0;
    sourceIdx < sources.length;
    sourceIdx++
  ) {
    const best = sorted.find(
      (d) => d.sourceIndex === sourceIdx && !selectedSet.has(d.document.path),
    );
    if (best === undefined) continue;

    const tokens = estimateDocTokens(best.document, estimator);
    if (usedTokens + tokens <= budget) {
      selectedSet.add(best.document.path);
      selectedDocs.push(best.document);
      usedTokens += tokens;
    } else if (selectedDocs.length === 0) {
      // Budget can't fit even the first doc — truncate concept:
      // include it anyway so we always return at least something
      selectedSet.add(best.document.path);
      selectedDocs.push(best.document);
      usedTokens += tokens;
      break;
    }
  }

  // Pass 2: fill remaining budget by global relevance (greedy)
  for (const entry of sorted) {
    if (selectedSet.has(entry.document.path)) continue;

    const tokens = estimateDocTokens(entry.document, estimator);
    if (usedTokens + tokens <= budget) {
      selectedSet.add(entry.document.path);
      selectedDocs.push(entry.document);
      usedTokens += tokens;
    }
    // Skip-and-continue: try next doc even if this one didn't fit
  }

  // Sort final output by relevance descending
  const selected = [...selectedDocs].sort((a, b) => b.relevanceScore - a.relevanceScore);

  const dropped = sorted
    .filter((d) => !selectedSet.has(d.document.path))
    .map((d) => d.document.path);

  return { selected, totalTokens: usedTokens, dropped };
}

function estimateDocTokens(doc: KnowledgeDocument, estimator: TokenEstimator): number {
  // estimateText may return number | Promise<number>, but heuristic is sync
  const result = estimator.estimateText(doc.content);
  return typeof result === "number" ? result : 0;
}
