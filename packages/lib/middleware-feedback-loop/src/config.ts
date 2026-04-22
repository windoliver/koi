import type { SnapshotChainStore } from "@koi/core";
import type { BrickId, BrickSnapshot } from "@koi/core/brick-snapshot";
import type { ForgeStore } from "@koi/core/brick-store";
import type {
  DemotionCriteria,
  Gate,
  HealthTransitionErrorEvent,
  RepairStrategy,
  TrustDemotionEvent,
  ValidationError,
  Validator,
} from "./types.js";

export interface RetryConfig {
  readonly validation?:
    | {
        readonly maxAttempts?: number | undefined;
      }
    | undefined;
  readonly transport?:
    | {
        readonly maxAttempts?: number | undefined;
      }
    | undefined;
}

export interface ForgeHealthConfig {
  readonly resolveBrickId: (toolId: string) => BrickId | undefined;
  readonly forgeStore: ForgeStore;
  readonly snapshotChainStore: SnapshotChainStore<BrickSnapshot>;
  readonly quarantineThreshold?: number | undefined; // default: 0.5
  readonly windowSize?: number | undefined; // quarantine window default: 10
  readonly maxRecentFailures?: number | undefined; // default: 5
  readonly onQuarantine?: ((brickId: BrickId) => void) | undefined;
  readonly demotionCriteria?: Partial<DemotionCriteria> | undefined;
  readonly onDemotion?: ((event: TrustDemotionEvent) => void) | undefined;
  readonly onHealthTransitionError?: ((event: HealthTransitionErrorEvent) => void) | undefined;
  readonly clock?: (() => number) | undefined; // default: Date.now
  readonly flushThreshold?: number | undefined; // default: 10
  readonly errorRateDeltaThreshold?: number | undefined; // default: 0.05
  readonly maxConsecutiveFlushFailures?: number | undefined; // default: 5
  readonly flushSuspensionCooldownMs?: number | undefined; // default: 60_000
  readonly flushTimeoutMs?: number | undefined; // default: 2_000
  readonly onFlushError?: ((toolId: string, error: unknown) => void) | undefined;
}

export interface FeedbackLoopConfig {
  readonly validators?: readonly Validator[] | undefined;
  readonly gates?: readonly Gate[] | undefined;
  readonly toolGates?: readonly Gate[] | undefined;
  readonly retry?: RetryConfig | undefined;
  readonly repairStrategy?: RepairStrategy | undefined;
  readonly onRetry?: ((attempt: number, errors: readonly ValidationError[]) => void) | undefined;
  readonly onGateFail?: ((gate: Gate, errors: readonly ValidationError[]) => void) | undefined;
  readonly forgeHealth?: ForgeHealthConfig | undefined;
}

export const DEFAULT_DEMOTION_CRITERIA: DemotionCriteria = {
  errorRateThreshold: 0.3,
  windowSize: 20,
  minSampleSize: 10,
  gracePeriodMs: 3_600_000,
  demotionCooldownMs: 1_800_000,
};
