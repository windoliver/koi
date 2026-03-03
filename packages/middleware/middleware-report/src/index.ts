/**
 * @koi/middleware-report — Structured run report generation (Layer 2)
 *
 * Generates human-readable summaries of autonomous agent runs.
 * Depends on @koi/core only (plus @koi/errors and @koi/resolve for descriptor).
 */

export type {
  CostProvider,
  CostSnapshot,
  ProgressCallback,
  ProgressSnapshot,
  ReportCallback,
  ReportConfig,
  ReportData,
  ReportFormatter,
  ReportSummarizer,
} from "./config.js";
export { validateReportConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { mapReportToJson, mapReportToMarkdown } from "./formatters.js";
export { createReportMiddleware } from "./report.js";
export type { ReportHandle } from "./types.js";
