/**
 * AceConfig definition and validation.
 *
 * Uses duck-typing for store interfaces and range validation for numeric config.
 * No Zod dependency — all fields are interfaces or primitives.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CuratorAdapter } from "./curator.js";
import type { ReflectorAdapter } from "./reflector.js";
import type { PlaybookStore, StructuredPlaybookStore, TrajectoryStore } from "./stores.js";
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
  readonly onLlmPipelineError?: (error: unknown, sessionId: string) => void;

  // 3-agent ACE pipeline (optional — stat-based pipeline used when absent)
  readonly reflector?: ReflectorAdapter;
  readonly curator?: CuratorAdapter;
  readonly structuredPlaybookStore?: StructuredPlaybookStore;
  readonly playbookTokenBudget?: number;
  readonly estimateTokens?: (text: string) => number;

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

function validateOptionalNumber(
  c: Record<string, unknown>,
  field: string,
  opts: {
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
    readonly message: string;
  },
): { readonly ok: false; readonly error: KoiError } | undefined {
  const value = c[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: validationError(opts.message) };
  }
  if (opts.min !== undefined && value < opts.min) {
    return { ok: false, error: validationError(opts.message) };
  }
  if (opts.max !== undefined && value > opts.max) {
    return { ok: false, error: validationError(opts.message) };
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    return { ok: false, error: validationError(opts.message) };
  }
  return undefined;
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

  // Optional numerics
  const numericChecks: readonly {
    readonly field: string;
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
    readonly message: string;
  }[] = [
    {
      field: "maxInjectionTokens",
      min: 0,
      message: "maxInjectionTokens must be a non-negative finite number",
    },
    {
      field: "minPlaybookConfidence",
      min: 0,
      max: 1,
      message: "minPlaybookConfidence must be a number between 0 and 1",
    },
    {
      field: "maxBufferEntries",
      min: 1,
      integer: true,
      message: "maxBufferEntries must be a positive integer",
    },
    {
      field: "minCurationScore",
      min: 0,
      max: 1,
      message: "minCurationScore must be a number between 0 and 1",
    },
    {
      field: "recencyDecayLambda",
      min: 0,
      message: "recencyDecayLambda must be a non-negative finite number",
    },
    {
      field: "playbookTokenBudget",
      min: 1,
      integer: true,
      message: "playbookTokenBudget must be a positive integer",
    },
  ];

  for (const check of numericChecks) {
    const err = validateOptionalNumber(c, check.field, check);
    if (err !== undefined) return err;
  }

  // Optional store: structuredPlaybookStore
  if (c.structuredPlaybookStore !== undefined) {
    if (!isStoreLike(c.structuredPlaybookStore, ["get", "list", "save", "remove"])) {
      return {
        ok: false,
        error: validationError(
          "structuredPlaybookStore must implement get, list, save, and remove",
        ),
      };
    }
  }

  // Optional adapter: reflector
  if (c.reflector !== undefined) {
    if (!isStoreLike(c.reflector, ["analyze"])) {
      return {
        ok: false,
        error: validationError("reflector must implement analyze"),
      };
    }
  }

  // Optional adapter: curator (the LLM curator, not stats-aggregator)
  if (c.curator !== undefined) {
    if (!isStoreLike(c.curator, ["curate"])) {
      return {
        ok: false,
        error: validationError("curator must implement curate"),
      };
    }
  }

  // Optional function: estimateTokens
  if (c.estimateTokens !== undefined && typeof c.estimateTokens !== "function") {
    return {
      ok: false,
      error: validationError("estimateTokens must be a function"),
    };
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
  const callbackFields = [
    "onRecord",
    "onCurate",
    "onInject",
    "onBufferEvict",
    "onLlmPipelineError",
  ] as const;
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
