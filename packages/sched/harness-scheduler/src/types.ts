import type { KoiError, Result } from "@koi/core";

export interface SchedulableHarness {
  readonly status: () => { readonly phase: string };
  readonly resume: () => Promise<Result<unknown, KoiError>>;
}

export interface HarnessSchedulerConfig {
  readonly harness: SchedulableHarness;
  readonly pollIntervalMs?: number | undefined;
  readonly backoffBaseMs?: number | undefined;
  readonly backoffCapMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
  readonly onResumed?: ((resumeResult: unknown) => Promise<void>) | undefined;
}

export type SchedulerPhase = "idle" | "running" | "stopped" | "failed";

export interface HarnessSchedulerStatus {
  readonly phase: SchedulerPhase;
  readonly retriesRemaining: number;
  readonly lastError?: KoiError | undefined;
  readonly totalResumes: number;
}

export interface HarnessScheduler {
  readonly start: () => void;
  readonly stop: () => void;
  readonly status: () => HarnessSchedulerStatus;
  readonly dispose: () => Promise<void>;
}
