/**
 * Report middleware types.
 */

import type { KoiMiddleware, RunReport, SessionId } from "@koi/core";

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

/** Handle returned by createReportMiddleware — middleware + query methods. */
export interface ReportHandle {
  readonly middleware: KoiMiddleware;
  readonly getReport: (sessionId: SessionId) => RunReport | undefined;
  readonly getProgress: (sessionId: SessionId) => ProgressSnapshot;
}
