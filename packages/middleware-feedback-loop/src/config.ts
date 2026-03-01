/**
 * FeedbackLoopConfig definition and validation.
 *
 * Uses Zod for data validation (retry budgets) and manual duck-typing
 * for runtime interfaces (validators, gates, repair strategies).
 */

import type { DemotionCriteria, ForgeStore, SnapshotStore } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { z } from "zod";
import type {
  DiscoveryMissRecord,
  RepairStrategy,
  RetryConfig,
  TrustDemotionEvent,
  ValidationError,
  Validator,
} from "./types.js";

/** Configuration for forge tool runtime health tracking. */
export interface ForgeHealthConfig {
  /** Resolves a toolId to its brick ID. Returns undefined for non-forged tools. */
  readonly resolveBrickId: (toolId: string) => string | undefined;
  /** Forge store for brick lifecycle updates. */
  readonly forgeStore: ForgeStore;
  /** Snapshot store for quarantine event recording. */
  readonly snapshotStore: SnapshotStore;
  /** Error rate threshold to trigger quarantine (0-1). Default: 0.5. */
  readonly quarantineThreshold?: number;
  /** Size of the sliding window for error rate calculation. Default: 10. */
  readonly windowSize?: number;
  /** Maximum recent failures to retain per tool. Default: 5. */
  readonly maxRecentFailures?: number;
  /** Callback fired when a tool is quarantined. Wire to forgeProvider.invalidate(). */
  readonly onQuarantine?: (brickId: string) => void | Promise<void>;
  /** Demotion criteria overrides (merged with DEFAULT_DEMOTION_CRITERIA). */
  readonly demotionCriteria?: Partial<DemotionCriteria>;
  /** Callback fired when a tool's trust tier is demoted. */
  readonly onDemotion?: (event: TrustDemotionEvent) => void | Promise<void>;
  /** Injectable clock for testing. Default: Date.now. */
  readonly clock?: () => number;
  /** Number of invocations before flushing fitness data to ForgeStore. Default: 10. */
  readonly flushThreshold?: number;
  /** Error rate delta that triggers an early flush (0-1). Default: 0.05. */
  readonly errorRateDeltaThreshold?: number;
  /** Callback fired when a fitness flush fails. */
  readonly onFlushError?: (toolId: string, error: unknown) => void;
  /** Callback fired when a demotion check fails (replaces empty catch). */
  readonly onDemotionError?: (toolId: string, error: unknown) => void;
}

/** Configuration for the feedback-loop middleware. */
export interface FeedbackLoopConfig {
  /** Model call validators — failure triggers retry with error feedback. */
  readonly validators?: readonly Validator[];
  /** Model call gates — failure halts without retry. */
  readonly gates?: readonly Validator[];
  /** Tool call input validators — failure rejects before execution. */
  readonly toolValidators?: readonly Validator[];
  /** Tool call output gates — failure halts after execution. */
  readonly toolGates?: readonly Validator[];
  /** Category-aware retry budget configuration. */
  readonly retry?: RetryConfig;
  /** Custom repair strategy (default appends errors as user message). */
  readonly repairStrategy?: RepairStrategy;
  /** Called on each validation retry attempt. */
  readonly onRetry?: (attempt: number, errors: readonly ValidationError[]) => void;
  /** Called when a gate check fails. */
  readonly onGateFail?: (gateName: string, errors: readonly ValidationError[]) => void;
  /** Forge tool runtime health tracking configuration. */
  readonly forgeHealth?: ForgeHealthConfig;
  /** Called when discovery miss count exceeds threshold. */
  readonly onDiscoveryMiss?: (record: DiscoveryMissRecord) => void;
  /** Number of misses before emitting a suggestion. Default: 3. */
  readonly missThreshold?: number;
}

// ---------------------------------------------------------------------------
// Zod schema for the serializable parts of config (retry budgets)
// ---------------------------------------------------------------------------

const retryBudgetSchema = z.object({
  validation: z
    .object({
      maxAttempts: z.number().nonnegative().optional(),
      delayMs: z.number().nonnegative().optional(),
    })
    .optional(),
  transport: z
    .object({
      maxAttempts: z.number().nonnegative().optional(),
      baseDelayMs: z.number().nonnegative().optional(),
      maxDelayMs: z.number().nonnegative().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Duck-type checks for runtime interfaces (can't be validated with Zod)
// ---------------------------------------------------------------------------

function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

function isValidatorLike(v: unknown): boolean {
  if (v === null || v === undefined || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.validate === "function";
}

function checkValidatorArray(arr: unknown, fieldName: string): KoiError | undefined {
  if (!Array.isArray(arr)) {
    return validationError(`${fieldName} must be an array`);
  }
  for (const item of arr as readonly unknown[]) {
    if (!isValidatorLike(item)) {
      return validationError(
        `Each entry in ${fieldName} must have a string 'name' and a 'validate' function`,
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public validation
// ---------------------------------------------------------------------------

/** Validates a config object and returns a typed Result. */
export function validateFeedbackLoopConfig(config: unknown): Result<FeedbackLoopConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return { ok: false, error: validationError("Config must be a non-null object") };
  }

  const c = config as Record<string, unknown>;

  // Validate validator/gate arrays (duck-type check for runtime interfaces)
  const arrayFields = ["validators", "gates", "toolValidators", "toolGates"] as const;
  for (const field of arrayFields) {
    if (c[field] !== undefined) {
      const err = checkValidatorArray(c[field], field);
      if (err) return { ok: false, error: err };
    }
  }

  // Validate retry config with Zod
  if (c.retry !== undefined) {
    const parsed = retryBudgetSchema.safeParse(c.retry);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i: z.core.$ZodIssue) => {
          const path = i.path.length > 0 ? `retry.${i.path.join(".")}` : "retry";
          return `${path}: ${i.message}`;
        })
        .join("; ");
      return { ok: false, error: validationError(msg) };
    }
  }

  // Validate forgeHealth config
  if (c.forgeHealth !== undefined) {
    if (typeof c.forgeHealth !== "object" || c.forgeHealth === null) {
      return { ok: false, error: validationError("forgeHealth must be a non-null object") };
    }
    const fh = c.forgeHealth as Record<string, unknown>;
    if (typeof fh.resolveBrickId !== "function") {
      return {
        ok: false,
        error: validationError("forgeHealth.resolveBrickId must be a function"),
      };
    }
    if (typeof fh.forgeStore !== "object" || fh.forgeStore === null) {
      return {
        ok: false,
        error: validationError("forgeHealth.forgeStore must be a non-null object"),
      };
    }
    if (typeof fh.snapshotStore !== "object" || fh.snapshotStore === null) {
      return {
        ok: false,
        error: validationError("forgeHealth.snapshotStore must be a non-null object"),
      };
    }
    if (fh.quarantineThreshold !== undefined) {
      if (
        typeof fh.quarantineThreshold !== "number" ||
        fh.quarantineThreshold < 0 ||
        fh.quarantineThreshold > 1
      ) {
        return {
          ok: false,
          error: validationError(
            "forgeHealth.quarantineThreshold must be a number between 0 and 1",
          ),
        };
      }
    }
    if (fh.windowSize !== undefined) {
      if (
        typeof fh.windowSize !== "number" ||
        fh.windowSize < 1 ||
        !Number.isInteger(fh.windowSize)
      ) {
        return {
          ok: false,
          error: validationError("forgeHealth.windowSize must be a positive integer"),
        };
      }
    }
    if (fh.maxRecentFailures !== undefined) {
      if (
        typeof fh.maxRecentFailures !== "number" ||
        fh.maxRecentFailures < 0 ||
        !Number.isInteger(fh.maxRecentFailures)
      ) {
        return {
          ok: false,
          error: validationError("forgeHealth.maxRecentFailures must be a non-negative integer"),
        };
      }
    }
    if (fh.flushThreshold !== undefined) {
      if (
        typeof fh.flushThreshold !== "number" ||
        fh.flushThreshold < 1 ||
        !Number.isInteger(fh.flushThreshold)
      ) {
        return {
          ok: false,
          error: validationError("forgeHealth.flushThreshold must be a positive integer"),
        };
      }
    }
    if (fh.errorRateDeltaThreshold !== undefined) {
      if (
        typeof fh.errorRateDeltaThreshold !== "number" ||
        fh.errorRateDeltaThreshold < 0 ||
        fh.errorRateDeltaThreshold > 1
      ) {
        return {
          ok: false,
          error: validationError(
            "forgeHealth.errorRateDeltaThreshold must be a number between 0 and 1",
          ),
        };
      }
    }
  }

  // Validate repairStrategy (duck-type)
  if (c.repairStrategy !== undefined) {
    if (
      typeof c.repairStrategy !== "object" ||
      c.repairStrategy === null ||
      typeof (c.repairStrategy as Record<string, unknown>).buildRetryRequest !== "function"
    ) {
      return {
        ok: false,
        error: validationError("repairStrategy must have a 'buildRetryRequest' function"),
      };
    }
  }

  return { ok: true, value: config as FeedbackLoopConfig };
}
