/**
 * AceConfig definition and validation.
 *
 * Uses duck-typing for store interfaces and range validation for numeric config.
 * No Zod dependency — all fields are interfaces or primitives.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { PlaybookStore, TrajectoryStore } from "./stores.js";
import type { AggregatedStats, CurationCandidate, Playbook, TrajectoryEntry } from "./types.js";

/** Configuration for the ACE middleware. */
export interface AceConfig {
  // Stores (required)
  readonly trajectoryStore: TrajectoryStore;
  readonly playbookStore: PlaybookStore;

  // Playbook injection
  readonly maxInjectionTokens?: number;
  readonly playbookTags?: readonly string[];
  readonly minPlaybookConfidence?: number;

  // Trajectory recording
  readonly maxBufferEntries?: number;

  // Curation scoring
  readonly scorer?: (
    stats: AggregatedStats,
    sessionCount: number,
    nowMs: number,
    lambda: number,
  ) => number;
  readonly minCurationScore?: number;
  readonly recencyDecayLambda?: number;

  // Consolidation
  readonly consolidate?: (
    candidates: readonly CurationCandidate[],
    existing: readonly Playbook[],
  ) => readonly Playbook[];

  // Callbacks
  readonly onRecord?: (entry: TrajectoryEntry) => void;
  readonly onCurate?: (candidates: readonly CurationCandidate[]) => void;
  readonly onInject?: (playbooks: readonly Playbook[]) => void;
  readonly onBufferEvict?: (evictedCount: number) => void;

  // Testability
  readonly clock?: () => number;
}

function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

function isStoreLike(v: unknown, requiredMethods: readonly string[]): boolean {
  if (v === null || v === undefined || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return requiredMethods.every((method) => typeof obj[method] === "function");
}

/** Validates an ACE config object and returns a typed Result. */
export function validateAceConfig(config: unknown): Result<AceConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: validationError("Config must be a non-null object"),
    };
  }

  const c = config as Record<string, unknown>;

  // Required: trajectoryStore
  if (!isStoreLike(c.trajectoryStore, ["append", "getSession", "listSessions"])) {
    return {
      ok: false,
      error: validationError("trajectoryStore must implement append, getSession, and listSessions"),
    };
  }

  // Required: playbookStore
  if (!isStoreLike(c.playbookStore, ["get", "list", "save", "remove"])) {
    return {
      ok: false,
      error: validationError("playbookStore must implement get, list, save, and remove"),
    };
  }

  // Optional numeric: maxInjectionTokens
  if (c.maxInjectionTokens !== undefined) {
    if (
      typeof c.maxInjectionTokens !== "number" ||
      c.maxInjectionTokens < 0 ||
      !Number.isFinite(c.maxInjectionTokens)
    ) {
      return {
        ok: false,
        error: validationError("maxInjectionTokens must be a non-negative finite number"),
      };
    }
  }

  // Optional numeric: minPlaybookConfidence
  if (c.minPlaybookConfidence !== undefined) {
    if (
      typeof c.minPlaybookConfidence !== "number" ||
      c.minPlaybookConfidence < 0 ||
      c.minPlaybookConfidence > 1
    ) {
      return {
        ok: false,
        error: validationError("minPlaybookConfidence must be a number between 0 and 1"),
      };
    }
  }

  // Optional numeric: maxBufferEntries
  if (c.maxBufferEntries !== undefined) {
    if (
      typeof c.maxBufferEntries !== "number" ||
      c.maxBufferEntries < 1 ||
      !Number.isInteger(c.maxBufferEntries)
    ) {
      return {
        ok: false,
        error: validationError("maxBufferEntries must be a positive integer"),
      };
    }
  }

  // Optional numeric: minCurationScore
  if (c.minCurationScore !== undefined) {
    if (
      typeof c.minCurationScore !== "number" ||
      c.minCurationScore < 0 ||
      c.minCurationScore > 1
    ) {
      return {
        ok: false,
        error: validationError("minCurationScore must be a number between 0 and 1"),
      };
    }
  }

  // Optional numeric: recencyDecayLambda
  if (c.recencyDecayLambda !== undefined) {
    if (
      typeof c.recencyDecayLambda !== "number" ||
      c.recencyDecayLambda < 0 ||
      !Number.isFinite(c.recencyDecayLambda)
    ) {
      return {
        ok: false,
        error: validationError("recencyDecayLambda must be a non-negative finite number"),
      };
    }
  }

  // Optional function: scorer
  if (c.scorer !== undefined && typeof c.scorer !== "function") {
    return {
      ok: false,
      error: validationError("scorer must be a function"),
    };
  }

  // Optional function: consolidate
  if (c.consolidate !== undefined && typeof c.consolidate !== "function") {
    return {
      ok: false,
      error: validationError("consolidate must be a function"),
    };
  }

  // Optional function: clock
  if (c.clock !== undefined && typeof c.clock !== "function") {
    return {
      ok: false,
      error: validationError("clock must be a function"),
    };
  }

  // Optional function: callbacks
  const callbackFields = ["onRecord", "onCurate", "onInject", "onBufferEvict"] as const;
  for (const field of callbackFields) {
    if (c[field] !== undefined && typeof c[field] !== "function") {
      return {
        ok: false,
        error: validationError(`${field} must be a function`),
      };
    }
  }

  return { ok: true, value: config as AceConfig };
}
