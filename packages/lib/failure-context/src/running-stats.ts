/**
 * Bridge between @koi/welford-stats and RunningStats.
 */

import type { WelfordState } from "@koi/welford-stats";
import { welfordStddev } from "@koi/welford-stats";
import type { RunningStats } from "./types.js";

/**
 * Convert WelfordState into a RunningStats snapshot.
 */
export function computeRunningStats(state: WelfordState): RunningStats {
  return {
    count: state.count,
    mean: state.mean,
    stddev: welfordStddev(state),
  };
}
