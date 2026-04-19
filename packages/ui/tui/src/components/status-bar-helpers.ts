/**
 * Pure formatting helpers for StatusBar — re-exported from @koi/core
 * so tests can import them without triggering the JSX runtime.
 */

import type { GovernanceSnapshot, SensorReading } from "@koi/core/governance";

export { formatCost, formatTokens } from "@koi/core/cost-tracker";

// ---------------------------------------------------------------------------
// Governance chip (gov-9)
// ---------------------------------------------------------------------------

/**
 * Pick the single most-stressed reading from a governance snapshot.
 * Returns null when the snapshot is null or has no readings — caller hides
 * the chip in that case.
 */
export function mostStressedSensor(snapshot: GovernanceSnapshot | null): SensorReading | null {
  if (snapshot === null) return null;
  let top: SensorReading | null = null;
  for (const r of snapshot.readings) {
    if (top === null || r.utilization > top.utilization) top = r;
  }
  return top;
}

/** Compact "k" formatter for token-style counts (< 1000 → no suffix; >= 1000 → "12.5k"). */
function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // Whole-thousand values render as `100k` not `100.0k` — token limits
    // are almost always round numbers; the `.0` suffix is noise.
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(2);
}

/**
 * Render a single SensorReading as a status-bar chip body. Per-variable
 * format hooks: the well-known sensors get hand-tuned forms; everything
 * else falls back to "name 60%".
 */
export function formatGovernanceChip(reading: SensorReading): string {
  switch (reading.name) {
    case "turn_count":
      return `turn ${reading.current}/${reading.limit}`;
    case "spawn_count":
      return `spawn ${reading.current}/${reading.limit}`;
    case "spawn_depth":
      return `depth ${reading.current}/${reading.limit}`;
    case "cost_usd":
      return `cost $${reading.current.toFixed(2)}/$${reading.limit.toFixed(2)}`;
    case "token_usage":
      return `tokens ${formatCount(reading.current)}/${formatCount(reading.limit)}`;
    default:
      return `${reading.name} ${Math.round(reading.utilization * 100)}%`;
  }
}

/**
 * Color tier for chip display. Boundaries are half-open intervals on
 * utilization:
 *   - `[0, 0.5)` → "ok"      (textMuted in renderer)
 *   - `[0.5, 0.8)` → "warn"  (amber in renderer)
 *   - `[0.8, ∞)` → "danger"  (red + ⚠ prefix in renderer)
 *
 * Setpoints set exactly at 0.5 / 0.8 land in the higher tier
 * (warn / danger) — checking `>=` not `>`.
 */
export function chipTier(util: number): "ok" | "warn" | "danger" {
  if (util >= 0.8) return "danger";
  if (util >= 0.5) return "warn";
  return "ok";
}
