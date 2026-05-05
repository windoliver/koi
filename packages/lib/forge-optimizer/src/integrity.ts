/**
 * Out-of-band integrity surface for `BrickFitnessMetrics`.
 *
 * `recordUsage` heals corrupt prior fitness silently so one bad
 * deserialization payload does not freeze telemetry forever for a
 * brick. This file exposes the parallel detection surface — run it
 * alongside (or before) `recordUsage` to drive a quarantine / repair
 * pipeline so corruption is observable without aborting writes.
 */

import type { BrickFitnessMetrics } from "@koi/core";

/** Out-of-band integrity finding for a persisted fitness snapshot. */
export interface FitnessIntegrityIssue {
  readonly field: "successCount" | "errorCount" | "lastUsedAt" | "latency";
  readonly value: unknown;
  readonly reason: string;
}

function detectCounterIssue(
  field: "successCount" | "errorCount",
  value: number,
): FitnessIntegrityIssue | undefined {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return {
      field,
      value,
      reason: `${field} must be a finite non-negative integer; got ${String(value)}`,
    };
  }
  return undefined;
}

function detectSamplesIssue(samples: unknown): FitnessIntegrityIssue | undefined {
  if (!Array.isArray(samples)) {
    return { field: "latency", value: samples, reason: "latency.samples is not an array" };
  }
  let prev = -Infinity;
  for (const s of samples) {
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0) {
      return {
        field: "latency",
        value: s,
        reason: "latency.samples contains a non-finite or negative value",
      };
    }
    if (s < prev) {
      return {
        field: "latency",
        value: samples,
        reason: "latency.samples is not sorted ascending",
      };
    }
    prev = s;
  }
  return undefined;
}

function detectCountIssue(count: unknown, samplesLen: number): FitnessIntegrityIssue | undefined {
  if (
    typeof count !== "number" ||
    !Number.isFinite(count) ||
    count < 0 ||
    !Number.isInteger(count)
  ) {
    return {
      field: "latency",
      value: count,
      reason: "latency.count must be a finite non-negative integer",
    };
  }
  if (count < samplesLen) {
    return {
      field: "latency",
      value: count,
      reason: `latency.count (${String(count)}) is less than samples.length (${String(samplesLen)})`,
    };
  }
  return undefined;
}

function detectCapIssue(cap: unknown, samplesLen: number): FitnessIntegrityIssue | undefined {
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1 || !Number.isInteger(cap)) {
    return { field: "latency", value: cap, reason: "latency.cap must be a finite integer >= 1" };
  }
  if (samplesLen > cap) {
    return {
      field: "latency",
      value: samplesLen,
      reason: `latency.samples.length (${String(samplesLen)}) exceeds cap (${String(cap)})`,
    };
  }
  return undefined;
}

function detectSamplerIssue(
  latency: BrickFitnessMetrics["latency"],
): FitnessIntegrityIssue | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: traversing possibly-malformed deserialized record
  const l = latency as any;
  return (
    detectSamplesIssue(l.samples) ??
    detectCountIssue(l.count, Array.isArray(l.samples) ? l.samples.length : 0) ??
    detectCapIssue(l.cap, Array.isArray(l.samples) ? l.samples.length : 0)
  );
}

/**
 * Pure check for persisted-fitness corruption. Returns ALL issues found
 * (multiple corrupt fields surface together so a repair pipeline does
 * not whack-a-mole one issue at a time and miss the rest).
 *
 * Top-level malformed `fitness` (null, primitive, array) is reported as
 * a single `latency`-keyed issue and does not throw, so this helper is
 * safe to call on any deserialized payload.
 */
export function detectFitnessIntegrity(
  // biome-ignore lint/suspicious/noExplicitAny: accept any deserialized payload at the integrity boundary
  fitness: BrickFitnessMetrics | any,
): readonly FitnessIntegrityIssue[] {
  if (fitness === null || typeof fitness !== "object" || Array.isArray(fitness)) {
    return [
      { field: "latency", value: fitness, reason: `fitness is not an object (${String(fitness)})` },
    ];
  }
  const issues: FitnessIntegrityIssue[] = [];
  const successIssue = detectCounterIssue("successCount", fitness.successCount);
  if (successIssue !== undefined) issues.push(successIssue);
  const errorIssue = detectCounterIssue("errorCount", fitness.errorCount);
  if (errorIssue !== undefined) issues.push(errorIssue);
  const ts = fitness.lastUsedAt;
  if (!Number.isFinite(ts) || ts < 0) {
    issues.push({ field: "lastUsedAt", value: ts, reason: "lastUsedAt is non-finite or negative" });
  }
  const latency = fitness.latency;
  if (latency === null || typeof latency !== "object") {
    issues.push({
      field: "latency",
      value: latency,
      reason: "latency sampler is missing or wrong-typed",
    });
  } else {
    const sampler = detectSamplerIssue(latency);
    if (sampler !== undefined) issues.push(sampler);
  }
  return issues;
}
