/**
 * Pure collusion detection functions — 4 deterministic signal detectors.
 *
 * No side effects. All state passed as arguments. Each detector returns
 * a CollusionSignal or null.
 *
 * Detectors:
 * 1. Synchronous Move — agents shifting tool usage in the same direction
 * 2. Variance Collapse — cross-agent behavior becoming suspiciously uniform
 * 3. Concentration — resource access dominated by few agents (high HHI)
 * 4. Specialization — agents dividing the market (each agent uses different tools)
 */

import type { AgentId } from "@koi/core/ecs";
import type { AgentObservation, CollusionSignal, CollusionThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Math utilities
// ---------------------------------------------------------------------------

/** Compute mean of values. Returns 0 for empty arrays. */
export function computeMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  // let: accumulator for sum
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/** Compute standard deviation given pre-computed mean. Returns 0 for empty/single-element arrays. */
export function computeStddev(values: readonly number[], mean: number): number {
  if (values.length <= 1) return 0;
  // let: accumulator for variance sum
  let varianceSum = 0;
  for (const v of values) {
    const diff = v - mean;
    varianceSum += diff * diff;
  }
  return Math.sqrt(varianceSum / values.length);
}

/** Compute coefficient of variation (stddev / mean). Returns 0 when mean is 0. */
export function computeCV(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const mean = computeMean(values);
  if (mean === 0) return 0;
  const stddev = computeStddev(values, mean);
  return stddev / Math.abs(mean);
}

/**
 * Compute Herfindahl-Hirschman Index (HHI).
 * Sum of squared market shares where shares are fractions summing to 1.
 * - 0 = perfect competition
 * - 1 = monopoly
 *
 * Input: raw counts (not shares). Normalizes internally.
 * Returns 0 for empty arrays. Returns 1 for single-element arrays.
 */
export function computeHHI(counts: readonly number[]): number {
  if (counts.length === 0) return 0;
  // let: accumulator for total
  let total = 0;
  for (const c of counts) {
    total += c;
  }
  if (total === 0) return 0;

  // let: accumulator for HHI
  let hhi = 0;
  for (const c of counts) {
    const share = c / total;
    hhi += share * share;
  }
  return hhi;
}

// ---------------------------------------------------------------------------
// Helper: extract total tool call counts per agent from observations
// ---------------------------------------------------------------------------

function totalToolCalls(obs: AgentObservation): number {
  // let: accumulator
  let total = 0;
  for (const count of obs.toolCallCounts.values()) {
    total += count;
  }
  return total;
}

function totalResourceAccess(obs: AgentObservation): number {
  // let: accumulator
  let total = 0;
  for (const count of obs.resourceAccessCounts.values()) {
    total += count;
  }
  return total;
}

/** Extract unique sorted rounds from observations. */
function extractSortedRounds(observations: readonly AgentObservation[]): readonly number[] {
  return [...new Set(observations.map((o) => o.round))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Signal 1: Synchronous Move
// ---------------------------------------------------------------------------

/**
 * Detect synchronous tool usage shifts across agents.
 *
 * Compares the latest round to the previous round. If >= K agents
 * shift their total tool call count by >= X% in the same direction, flag.
 *
 * Requires at least 2 rounds of observations.
 */
export function detectSyncMove(
  observations: readonly AgentObservation[],
  thresholds: CollusionThresholds,
): CollusionSignal | null {
  if (observations.length === 0) return null;

  const rounds = extractSortedRounds(observations);
  if (rounds.length < 2) return null;

  const prevRound = rounds[rounds.length - 2];
  const currRound = rounds[rounds.length - 1];
  if (prevRound === undefined || currRound === undefined) return null;

  const prevByAgent = new Map(
    observations
      .filter((o) => o.round === prevRound)
      .map((o) => [o.agentId, totalToolCalls(o)] as const),
  );
  const currByAgent = new Map(
    observations
      .filter((o) => o.round === currRound)
      .map((o) => [o.agentId, totalToolCalls(o)] as const),
  );

  const commonAgents = [...prevByAgent.keys()].filter((id) => currByAgent.has(id));
  if (commonAgents.length < thresholds.syncMoveMinAgents) return null;

  return computeSyncSignal(commonAgents, prevByAgent, currByAgent, thresholds, currRound);
}

function computeSyncSignal(
  commonAgents: readonly string[],
  prevByAgent: ReadonlyMap<string, number>,
  currByAgent: ReadonlyMap<string, number>,
  thresholds: CollusionThresholds,
  currRound: number,
): CollusionSignal | null {
  // let: counters for agents shifting up/down
  let upCount = 0;
  let downCount = 0;
  const evidence = new Map<string, number>();

  for (const id of commonAgents) {
    const prevTotal = prevByAgent.get(id);
    const currTotal = currByAgent.get(id);
    if (prevTotal === undefined || currTotal === undefined || prevTotal === 0) continue;

    const changePct = (currTotal - prevTotal) / prevTotal;
    evidence.set(id, changePct);

    if (changePct >= thresholds.syncMoveChangePct) upCount += 1;
    if (changePct <= -thresholds.syncMoveChangePct) downCount += 1;
  }

  const syncAgents = Math.max(upCount, downCount);
  if (syncAgents >= thresholds.syncMoveMinAgents) {
    const direction = upCount >= downCount ? "increase" : "decrease";
    return {
      kind: "sync_move",
      severity: "warning",
      evidence,
      round: currRound,
      timestamp: Date.now(),
      message: `${syncAgents} agents synchronously ${direction}d tool usage by >= ${thresholds.syncMoveChangePct * 100}%`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signal 2: Variance Collapse
// ---------------------------------------------------------------------------

/**
 * Detect cross-agent variance collapse in tool usage.
 *
 * Computes the coefficient of variation (CV) of total tool calls across agents
 * for recent rounds. If CV stays below threshold for N consecutive rounds, flag.
 */
export function detectVarianceCollapse(
  observations: readonly AgentObservation[],
  thresholds: CollusionThresholds,
): CollusionSignal | null {
  if (observations.length === 0) return null;

  const rounds = extractSortedRounds(observations);
  if (rounds.length < thresholds.varianceCollapseMinRounds) return null;

  const recentRounds = rounds.slice(-thresholds.varianceCollapseMinRounds);

  for (const round of recentRounds) {
    const roundObs = observations.filter((o) => o.round === round);
    if (roundObs.length <= 1) return null;

    const totals = roundObs.map(totalToolCalls);
    const cv = computeCV(totals);

    if (cv > thresholds.varianceCollapseMaxCv) return null;
  }

  const lastRound = recentRounds[recentRounds.length - 1];
  if (lastRound === undefined) return null;

  const lastRoundObs = observations.filter((o) => o.round === lastRound);
  const evidence = new Map(lastRoundObs.map((o) => [o.agentId, totalToolCalls(o)] as const));

  return {
    kind: "variance_collapse",
    severity: "warning",
    evidence,
    round: lastRound,
    timestamp: Date.now(),
    message: `Cross-agent tool usage variance collapsed (CV < ${thresholds.varianceCollapseMaxCv}) for ${thresholds.varianceCollapseMinRounds} consecutive rounds`,
  };
}

// ---------------------------------------------------------------------------
// Signal 3: Concentration (HHI)
// ---------------------------------------------------------------------------

/**
 * Detect resource access concentration via Herfindahl-Hirschman Index.
 *
 * Computes HHI of resource access counts across agents in the latest round.
 * HHI > threshold indicates market concentration (few agents dominating).
 */
export function detectConcentration(
  observations: readonly AgentObservation[],
  thresholds: CollusionThresholds,
): CollusionSignal | null {
  if (observations.length === 0) return null;

  const latestRound = Math.max(...observations.map((o) => o.round));
  const roundObs = observations.filter((o) => o.round === latestRound);
  if (roundObs.length <= 1) return null;

  const accessCounts = roundObs.map(totalResourceAccess);
  const hhi = computeHHI(accessCounts);

  if (hhi > thresholds.concentrationHhiThreshold) {
    const evidence = new Map(roundObs.map((o) => [o.agentId, totalResourceAccess(o)] as const));

    return {
      kind: "concentration",
      severity: "warning",
      evidence,
      round: latestRound,
      timestamp: Date.now(),
      message: `Resource access concentration detected (HHI=${hhi.toFixed(3)} > ${thresholds.concentrationHhiThreshold})`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signal 4: Specialization (Market Division)
// ---------------------------------------------------------------------------

/**
 * Detect market division via per-agent tool specialization.
 *
 * Computes each agent's CV across their tool usage distribution.
 * High CV = agent is specialized in few tools. If the mean per-agent CV
 * exceeds the threshold, flag potential market division.
 */
export function detectSpecialization(
  observations: readonly AgentObservation[],
  thresholds: CollusionThresholds,
): CollusionSignal | null {
  if (observations.length === 0) return null;

  const latestRound = Math.max(...observations.map((o) => o.round));
  const roundObs = observations.filter((o) => o.round === latestRound);
  if (roundObs.length <= 1) return null;

  const agentCVPairs: readonly { readonly agentId: AgentId; readonly cv: number }[] = roundObs
    .map((obs) => {
      const counts = [...obs.toolCallCounts.values()];
      if (counts.length <= 1) return null;
      return { agentId: obs.agentId, cv: computeCV(counts) };
    })
    .filter((pair): pair is NonNullable<typeof pair> => pair !== null);

  if (agentCVPairs.length === 0) return null;

  const meanCV = computeMean(agentCVPairs.map((p) => p.cv));

  if (meanCV >= thresholds.specializationCvMin) {
    const evidence = new Map(agentCVPairs.map((p) => [p.agentId, p.cv] as const));

    return {
      kind: "specialization",
      severity: "warning",
      evidence,
      round: latestRound,
      timestamp: Date.now(),
      message: `Agent specialization detected (mean per-agent CV=${meanCV.toFixed(3)} >= ${thresholds.specializationCvMin})`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// detectAll — run all 4 detectors
// ---------------------------------------------------------------------------

/** Run all 4 collusion detectors and return non-null signals. */
export function detectAll(
  observations: readonly AgentObservation[],
  thresholds: CollusionThresholds,
): readonly CollusionSignal[] {
  return [
    detectSyncMove(observations, thresholds),
    detectVarianceCollapse(observations, thresholds),
    detectConcentration(observations, thresholds),
    detectSpecialization(observations, thresholds),
  ].filter((s): s is CollusionSignal => s !== null);
}
