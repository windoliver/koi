/**
 * Memory recall orchestration — scan, score, budget-select, and format
 * persisted memories for system prompt injection.
 *
 * Side effect: filesystem reads via scan module.
 */

import type { FileSystemBackend } from "@koi/core";
import { estimateTokens } from "@koi/token-estimator";
import type { FormatOptions } from "./format.js";
import { formatMemorySection, formatSingleMemory } from "./format.js";
import type { SalienceConfig, ScoredMemory } from "./salience.js";
import { scoreMemories } from "./salience.js";
import { scanMemoryDirectory } from "./scan.js";

// ---------------------------------------------------------------------------
// Configuration & result types
// ---------------------------------------------------------------------------

/** Configuration for the recall pipeline. */
export interface RecallConfig {
  /** Absolute path to the memory directory. */
  readonly memoryDir: string;
  /** Maximum tokens for selected memories. Default: 8000. */
  readonly tokenBudget?: number | undefined;
  /** Maximum files to scan. Default: 200. */
  readonly maxFiles?: number | undefined;
  /** Salience scoring configuration. */
  readonly salience?: SalienceConfig | undefined;
  /** Formatting options for the output section. */
  readonly format?: FormatOptions | undefined;
  /** Injectable clock for deterministic tests (ms since epoch). */
  readonly now?: number | undefined;
}

/** Result of the recall pipeline. */
export interface RecallResult {
  readonly selected: readonly ScoredMemory[];
  readonly formatted: string;
  readonly totalTokens: number;
  readonly totalScanned: number;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 8000;

// ---------------------------------------------------------------------------
// Budget selection (pure)
// ---------------------------------------------------------------------------

/**
 * Selects memories that fit within a token budget.
 *
 * Iterates scored memories (assumed sorted by salience descending).
 * Each memory is either fully included or skipped — no mid-content truncation.
 * Uses heuristic token estimation (~4 chars/token).
 */
export function selectWithinBudget(
  memories: readonly ScoredMemory[],
  budget: number,
): {
  readonly selected: readonly ScoredMemory[];
  readonly totalTokens: number;
  readonly truncated: boolean;
} {
  const selected: ScoredMemory[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const memory of memories) {
    const formatted = formatSingleMemory(memory);
    const tokens = estimateTokens(formatted);

    if (totalTokens + tokens <= budget) {
      selected.push(memory);
      totalTokens += tokens;
    } else {
      truncated = true;
    }
  }

  return { selected, totalTokens, truncated };
}

// ---------------------------------------------------------------------------
// Main recall pipeline
// ---------------------------------------------------------------------------

/**
 * Recalls persisted memories for session-start context injection.
 *
 * Pipeline: scan directory → score by salience → select within token budget → format.
 *
 * Side effect: reads files via the provided FileSystemBackend.
 */
export async function recallMemories(
  fs: FileSystemBackend,
  config: RecallConfig,
): Promise<RecallResult> {
  const now = config.now ?? Date.now();
  const budget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  // Step 1: Scan memory directory
  const scanResult = await scanMemoryDirectory(fs, {
    memoryDir: config.memoryDir,
    maxFiles: config.maxFiles,
  });

  if (scanResult.memories.length === 0) {
    return { selected: [], formatted: "", totalTokens: 0, totalScanned: 0, truncated: false };
  }

  // Step 2: Score by salience
  const scored = scoreMemories(scanResult.memories, config.salience, now);

  // Step 3: Select within token budget
  const { selected, totalTokens, truncated } = selectWithinBudget(scored, budget);

  // Step 4: Format for injection
  const formatted = formatMemorySection(selected, config.format);

  return {
    selected,
    formatted,
    totalTokens,
    totalScanned: scanResult.memories.length,
    truncated,
  };
}
