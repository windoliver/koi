/**
 * @koi/failure-context — Shared failure classification primitives (L0u)
 *
 * Provides:
 * - computeRunningStats bridge from WelfordState to RunningStats
 * - Bounded history trimming for failure records
 * - Generic FailureDetector interface
 * - Base types: FailureRecordBase, RunningStats
 */

export { trimToRecent } from "./bounded-history.js";
export type { FailureDetector } from "./failure-detector.js";
export { computeRunningStats } from "./running-stats.js";
export type { FailureRecordBase, RunningStats } from "./types.js";
