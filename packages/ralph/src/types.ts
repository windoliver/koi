/**
 * @koi/ralph — Type definitions for the Ralph Loop orchestrator.
 *
 * Ralph shifts control from LLM self-assessment to external objective
 * verification (tests pass, files match, custom checks). Each iteration
 * gets a clean context window; the filesystem is long-term memory.
 */

import type { EngineEvent, EngineInput, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Core callback types
// ---------------------------------------------------------------------------

/** Injected by consumer — runs one agent iteration and yields engine events. */
export type RunIterationFn = (input: EngineInput) => AsyncIterable<EngineEvent>;

/** External verification gate — returns pass/fail after each iteration. */
export type VerificationFn = (ctx: GateContext) => Promise<VerificationResult>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RalphConfig {
  /** Injected iteration runner (consumer wires createKoi + adapter). */
  readonly runIteration: RunIterationFn;
  /** Path to PRD JSON file. */
  readonly prdPath: string;
  /** Path to learnings JSON file. Default: sibling `learnings.json` of prdPath. */
  readonly learningsPath?: string | undefined;
  /** External verification gate. */
  readonly verify: VerificationFn;
  /** Safety limit. Default: 100. */
  readonly maxIterations?: number | undefined;
  /** Build the prompt for each iteration. Required. */
  readonly iterationPrompt: (ctx: IterationContext) => string;
  /** Working directory for test gates. Default: process.cwd(). */
  readonly workingDir?: string | undefined;
  /** Gate timeout in ms. Default: 120_000 (2 min). */
  readonly gateTimeoutMs?: number | undefined;
  /** Max learnings entries to retain. Default: 50. */
  readonly maxLearningEntries?: number | undefined;
  /** External AbortSignal — aborts the loop and current iteration. */
  readonly signal?: AbortSignal | undefined;
  /** Per-iteration timeout in ms. Default: 600_000 (10 min). */
  readonly iterationTimeoutMs?: number | undefined;
  /** Called after each iteration completes. Observe progress in real-time. */
  readonly onIteration?: ((record: IterationRecord) => void) | undefined;
  /** Max consecutive gate failures on the same item before skipping it. Default: 3. */
  readonly maxConsecutiveFailures?: number | undefined;
}

// ---------------------------------------------------------------------------
// PRD types
// ---------------------------------------------------------------------------

export interface PRDFile {
  readonly items: readonly PRDItem[];
}

export interface PRDItem {
  readonly id: string;
  readonly description: string;
  readonly done: boolean;
  readonly verifiedAt?: string | undefined;
  readonly iterationCount?: number | undefined;
  /** Lower number = higher priority. Default: 0. */
  readonly priority?: number | undefined;
  /** If true, this item was skipped due to repeated failures. */
  readonly skipped?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Verification types
// ---------------------------------------------------------------------------

export interface VerificationResult {
  readonly passed: boolean;
  readonly details?: string | undefined;
  readonly itemsCompleted?: readonly string[] | undefined;
}

export interface GateContext {
  readonly iteration: number;
  readonly currentItem: PRDItem | undefined;
  readonly workingDir: string;
  /** All iteration records so far (enables history-aware gate decisions). */
  readonly iterationRecords: readonly IterationRecord[];
  /** Current learnings from the learnings file. */
  readonly learnings: readonly LearningsEntry[];
  /** Items not yet completed or skipped. */
  readonly remainingItems: readonly PRDItem[];
  /** Items already completed. */
  readonly completedItems: readonly PRDItem[];
}

// ---------------------------------------------------------------------------
// Learnings types
// ---------------------------------------------------------------------------

export interface LearningsFile {
  readonly entries: readonly LearningsEntry[];
}

export interface LearningsEntry {
  readonly iteration: number;
  readonly timestamp: string;
  readonly itemId: string | undefined;
  readonly discovered: readonly string[];
  readonly failed: readonly string[];
  readonly context: string;
}

// ---------------------------------------------------------------------------
// Iteration context (passed to iterationPrompt builder)
// ---------------------------------------------------------------------------

export interface IterationContext {
  readonly iteration: number;
  readonly currentItem: PRDItem | undefined;
  readonly remainingItems: readonly PRDItem[];
  readonly completedItems: readonly PRDItem[];
  readonly learnings: readonly LearningsEntry[];
  readonly totalIterations: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface IterationRecord {
  readonly iteration: number;
  readonly itemId: string | undefined;
  readonly durationMs: number;
  readonly gateResult: VerificationResult;
  readonly error?: string | undefined;
}

export interface RalphResult {
  readonly iterations: number;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  /** Items skipped due to repeated consecutive gate failures. */
  readonly skipped: readonly string[];
  readonly learnings: readonly LearningsEntry[];
  readonly durationMs: number;
  readonly iterationRecords: readonly IterationRecord[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RalphLoop {
  readonly run: () => Promise<RalphResult>;
  readonly stop: () => void;
}

// Re-export types used in signatures for consumer convenience
export type { EngineEvent, EngineInput, KoiError, Result };
