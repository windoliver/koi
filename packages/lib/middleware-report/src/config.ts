/**
 * Report middleware configuration and validation.
 */

import type { KoiError, Result, RunReport } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

import type { ProgressSnapshot } from "./types.js";

export type ReportFormatter = (report: RunReport) => string;
export type ReportCallback = (report: RunReport, formatted: string) => void | Promise<void>;
export type ProgressCallback = (snapshot: ProgressSnapshot) => void | Promise<void>;

export interface ReportMiddlewareConfig {
  /** Agent's objective — included in the final report. */
  readonly objective?: string | undefined;
  /** Max actions to store in ring buffer. Default: 500. */
  readonly maxActions?: number | undefined;
  /** Output formatter. Default: mapReportToMarkdown. */
  readonly formatter?: ReportFormatter | undefined;
  /** Push notification at session end. */
  readonly onReport?: ReportCallback | undefined;
  /** Push notification after each turn. */
  readonly onProgress?: ProgressCallback | undefined;
  /** Max completed reports to retain in memory. Default: 100. Oldest evicted first. */
  readonly maxReports?: number | undefined;
}

export const DEFAULT_MAX_ACTIONS = 500;
export const DEFAULT_MAX_REPORTS = 100;

export function validateReportConfig(input: unknown): Result<ReportMiddlewareConfig, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ReportMiddlewareConfig must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = input as Record<string, unknown>;

  if (c.maxActions !== undefined && (typeof c.maxActions !== "number" || c.maxActions < 1)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "ReportMiddlewareConfig.maxActions must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input as ReportMiddlewareConfig };
}
