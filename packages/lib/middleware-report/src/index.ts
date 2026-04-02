/**
 * @koi/middleware-report — Activity reporting middleware.
 */

export type { Accumulator, AccumulatorSnapshot } from "./accumulator.js";
export { createAccumulator } from "./accumulator.js";
export type {
  ProgressCallback,
  ReportCallback,
  ReportFormatter,
  ReportMiddlewareConfig,
} from "./config.js";
export { DEFAULT_MAX_ACTIONS, DEFAULT_MAX_REPORTS, validateReportConfig } from "./config.js";
export { mapReportToMarkdown } from "./formatter.js";
export { createReportMiddleware } from "./report.js";
export type { ProgressSnapshot, ReportHandle } from "./types.js";
