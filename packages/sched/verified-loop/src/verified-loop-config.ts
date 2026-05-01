/**
 * Resolve and validate VerifiedLoopConfig defaults / required fields.
 *
 * Extracted so the orchestrator's createVerifiedLoop shell stays readable
 * and the numeric guards live next to the constants they bound.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import type { VerifiedLoopConfig } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_MAX_LEARNING_ENTRIES = 50;
const DEFAULT_ITERATION_TIMEOUT_MS = 600_000;
const DEFAULT_GATE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface ResolvedConfig {
  readonly prdPath: string;
  readonly learningsPath: string;
  readonly workingDir: string;
  readonly maxIterations: number;
  readonly maxLearningEntries: number;
  readonly iterationTimeoutMs: number;
  readonly gateTimeoutMs: number;
  readonly maxConsecutiveFailures: number;
}

export function resolveConfig(config: VerifiedLoopConfig): ResolvedConfig {
  if (!config.prdPath) {
    throw new Error("VerifiedLoopConfig.prdPath is required");
  }
  if (!config.runIteration) {
    throw new Error("VerifiedLoopConfig.runIteration is required");
  }
  if (!config.verify) {
    throw new Error("VerifiedLoopConfig.verify is required");
  }
  if (!config.iterationPrompt) {
    throw new Error("VerifiedLoopConfig.iterationPrompt is required");
  }

  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxLearningEntries = config.maxLearningEntries ?? DEFAULT_MAX_LEARNING_ENTRIES;
  const workingDir = config.workingDir ?? process.cwd();
  // Resolve PRD and learnings paths against workingDir at construction so
  // every store call is process-cwd-independent. A loop launched from a
  // different cwd than its workspace must not silently read or overwrite
  // an unrelated PRD file. Absolute paths pass through unchanged.
  const prdPath = isAbsolute(config.prdPath) ? config.prdPath : resolve(workingDir, config.prdPath);
  const learningsPath = resolveLearningsPath(config.learningsPath, workingDir, prdPath);
  const iterationTimeoutMs = config.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS;
  const gateTimeoutMs = config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  validatePositiveInts({
    maxConsecutiveFailures,
    maxIterations,
    iterationTimeoutMs,
    gateTimeoutMs,
  });
  return {
    prdPath,
    learningsPath,
    workingDir,
    maxIterations,
    maxLearningEntries,
    iterationTimeoutMs,
    gateTimeoutMs,
    maxConsecutiveFailures,
  };
}

function resolveLearningsPath(
  configPath: string | undefined,
  workingDir: string,
  prdPath: string,
): string {
  if (configPath === undefined) {
    return join(dirname(prdPath), "learnings.json");
  }
  return isAbsolute(configPath) ? configPath : resolve(workingDir, configPath);
}

function validatePositiveInts(values: {
  readonly maxConsecutiveFailures: number;
  readonly maxIterations: number;
  readonly iterationTimeoutMs: number;
  readonly gateTimeoutMs: number;
}): void {
  // Validate destructive numeric config upfront. A non-integer, NaN, or
  // < 1 value would let the FIRST failed verification flip skipped:true
  // into the PRD source of truth — silently dropping work that an
  // operator may not notice for a long time. Reject at construction.
  requirePositiveInt("maxConsecutiveFailures", values.maxConsecutiveFailures);
  requirePositiveInt("maxIterations", values.maxIterations);
  // Both timeouts feed AbortSignal.timeout(); negative or NaN values throw
  // TypeError at run time mid-loop, which corrupts the iteration record
  // mid-flight. Reject upfront with a structured error so the operator
  // sees a deterministic config failure instead of a stack trace from a
  // half-complete iteration.
  requirePositiveInt("iterationTimeoutMs", values.iterationTimeoutMs);
  requirePositiveInt("gateTimeoutMs", values.gateTimeoutMs);
}

function requirePositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`VerifiedLoopConfig.${name} must be a positive integer (got ${String(value)})`);
  }
}
