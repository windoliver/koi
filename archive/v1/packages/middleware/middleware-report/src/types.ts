/**
 * Package-internal types for @koi/middleware-report.
 */

import type { KoiMiddleware, RunReport } from "@koi/core";
import type { ProgressSnapshot } from "./config.js";

/** Handle returned by createReportMiddleware for report retrieval. */
export interface ReportHandle {
  readonly middleware: KoiMiddleware;
  readonly getReport: (sessionId?: string) => RunReport | undefined;
  readonly getProgress: (sessionId?: string) => ProgressSnapshot;
}
