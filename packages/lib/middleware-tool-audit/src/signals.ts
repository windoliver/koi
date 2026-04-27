/**
 * Pure lifecycle signal analysis — computes per-tool signals from audit snapshot.
 */

import type { ToolAuditConfig } from "./config.js";
import type { ToolAuditResult, ToolAuditSnapshot, ToolUsageRecord } from "./types.js";

const DEFAULT_UNUSED_THRESHOLD_SESSIONS = 50;
const DEFAULT_LOW_ADOPTION_THRESHOLD = 0.05;
const DEFAULT_HIGH_FAILURE_THRESHOLD = 0.5;
const DEFAULT_HIGH_VALUE_SUCCESS_THRESHOLD = 0.9;
const DEFAULT_HIGH_VALUE_MIN_CALLS = 20;
const DEFAULT_MIN_CALLS_FOR_FAILURE = 5;
const DEFAULT_MIN_SESSIONS_FOR_ADOPTION = 10;

function computeConfidence(sampleSize: number, threshold: number): number {
  return Math.min(1, sampleSize / (threshold * 2));
}

function checkUnused(record: ToolUsageRecord, threshold: number): ToolAuditResult | undefined {
  if (record.callCount !== 0 || record.sessionsAvailable < threshold) return undefined;
  return {
    toolName: record.toolName,
    signal: "unused",
    confidence: computeConfidence(record.sessionsAvailable, threshold),
    details: `Tool "${record.toolName}" has never been called across ${record.sessionsAvailable} sessions`,
    record,
  };
}

function checkLowAdoption(
  record: ToolUsageRecord,
  threshold: number,
  minSessions: number,
): ToolAuditResult | undefined {
  if (record.sessionsAvailable < minSessions) return undefined;
  const adoptionRate =
    record.sessionsAvailable > 0 ? record.sessionsUsed / record.sessionsAvailable : 0;
  if (adoptionRate >= threshold) return undefined;
  return {
    toolName: record.toolName,
    signal: "low_adoption",
    confidence: computeConfidence(record.sessionsAvailable, minSessions),
    details: `Tool "${record.toolName}" used in ${(adoptionRate * 100).toFixed(1)}% of sessions (${record.sessionsUsed}/${record.sessionsAvailable})`,
    record,
  };
}

function checkHighFailure(
  record: ToolUsageRecord,
  threshold: number,
  minCalls: number,
): ToolAuditResult | undefined {
  if (record.callCount < minCalls) return undefined;
  const failureRate = record.failureCount / record.callCount;
  if (failureRate <= threshold) return undefined;
  return {
    toolName: record.toolName,
    signal: "high_failure",
    confidence: computeConfidence(record.callCount, minCalls),
    details: `Tool "${record.toolName}" fails ${(failureRate * 100).toFixed(1)}% of calls (${record.failureCount}/${record.callCount})`,
    record,
  };
}

function checkHighValue(
  record: ToolUsageRecord,
  threshold: number,
  minCalls: number,
): ToolAuditResult | undefined {
  if (record.callCount < minCalls) return undefined;
  const successRate = record.successCount / record.callCount;
  if (successRate < threshold) return undefined;
  return {
    toolName: record.toolName,
    signal: "high_value",
    confidence: computeConfidence(record.callCount, minCalls),
    details: `Tool "${record.toolName}" succeeds ${(successRate * 100).toFixed(1)}% of calls (${record.successCount}/${record.callCount})`,
    record,
  };
}

function analyzeToolSignals(
  record: ToolUsageRecord,
  config: ToolAuditConfig,
): readonly ToolAuditResult[] {
  const unusedThreshold = config.unusedThresholdSessions ?? DEFAULT_UNUSED_THRESHOLD_SESSIONS;
  const lowAdoptionThreshold = config.lowAdoptionThreshold ?? DEFAULT_LOW_ADOPTION_THRESHOLD;
  const highFailureThreshold = config.highFailureThreshold ?? DEFAULT_HIGH_FAILURE_THRESHOLD;
  const highValueSuccessThreshold =
    config.highValueSuccessThreshold ?? DEFAULT_HIGH_VALUE_SUCCESS_THRESHOLD;
  const highValueMinCalls = config.highValueMinCalls ?? DEFAULT_HIGH_VALUE_MIN_CALLS;
  const minCallsForFailure = config.minCallsForFailure ?? DEFAULT_MIN_CALLS_FOR_FAILURE;
  const minSessionsForAdoption = config.minSessionsForAdoption ?? DEFAULT_MIN_SESSIONS_FOR_ADOPTION;

  return [
    checkUnused(record, unusedThreshold),
    checkLowAdoption(record, lowAdoptionThreshold, minSessionsForAdoption),
    checkHighFailure(record, highFailureThreshold, minCallsForFailure),
    checkHighValue(record, highValueSuccessThreshold, highValueMinCalls),
  ].filter((s): s is ToolAuditResult => s !== undefined);
}

/** Compute lifecycle signals for all tools in the snapshot. Pure function. */
export function computeLifecycleSignals(
  snapshot: ToolAuditSnapshot,
  config: ToolAuditConfig,
): readonly ToolAuditResult[] {
  return Object.values(snapshot.tools).flatMap((record) => analyzeToolSignals(record, config));
}
