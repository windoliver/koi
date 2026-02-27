/**
 * Report middleware configuration and validation.
 */

import type {
  ActionEntry,
  ArtifactRef,
  IssueEntry,
  ReportSummary,
  RunCost,
  RunDuration,
  RunReport,
} from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

/** Snapshot of cost data from an external provider. */
export interface CostSnapshot {
  readonly estimatedCostUsd: number;
}

/** Data passed to the summarizer callback. */
export interface ReportData {
  readonly objective?: string | undefined;
  readonly actions: readonly ActionEntry[];
  readonly artifacts: readonly ArtifactRef[];
  readonly issues: readonly IssueEntry[];
  readonly duration: RunDuration;
  readonly cost: RunCost;
}

/** Async callback that produces a human-readable summary + recommendations. */
export type ReportSummarizer = (data: ReportData) => Promise<ReportSummary>;

/** Async callback that returns the current cost snapshot. */
export type CostProvider = () => CostSnapshot | Promise<CostSnapshot>;

/** Custom formatter that converts a RunReport to a string. */
export type ReportFormatter = (report: RunReport) => string;

/** Callback invoked when a report is finalized. */
export type ReportCallback = (report: RunReport, formatted: string) => void | Promise<void>;

/** Live progress snapshot emitted after each turn. */
export interface ProgressSnapshot {
  readonly turnIndex: number;
  readonly totalActions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly issueCount: number;
  readonly elapsedMs: number;
  readonly truncated: boolean;
}

/** Callback invoked after each turn with live progress data. */
export type ProgressCallback = (progress: ProgressSnapshot) => void | Promise<void>;

/** Configuration for createReportMiddleware. */
export interface ReportConfig {
  readonly objective?: string | undefined;
  readonly summarizer?: ReportSummarizer | undefined;
  readonly summarizerTimeoutMs?: number | undefined;
  readonly costProvider?: CostProvider | undefined;
  readonly formatter?: ReportFormatter | undefined;
  readonly maxActions?: number | undefined;
  readonly onReport?: ReportCallback | undefined;
  readonly onProgress?: ProgressCallback | undefined;
}

const DEFAULT_MAX_ACTIONS = 500;
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 30_000;

export { DEFAULT_MAX_ACTIONS, DEFAULT_SUMMARIZER_TIMEOUT_MS };

export function validateReportConfig(config: unknown): Result<ReportConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (c.maxActions !== undefined) {
    if (typeof c.maxActions !== "number" || c.maxActions <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxActions must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.summarizerTimeoutMs !== undefined) {
    if (typeof c.summarizerTimeoutMs !== "number" || c.summarizerTimeoutMs <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "summarizerTimeoutMs must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as ReportConfig };
}
