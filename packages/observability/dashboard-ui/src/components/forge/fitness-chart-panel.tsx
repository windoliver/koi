/**
 * Fitness chart panel — per-brick sparklines showing fitness over time.
 */

import { sparkline } from "../../lib/sparkline.js";
import { useBricksList, useForgeStore } from "../../stores/forge-store.js";

export function FitnessChartPanel(): React.ReactElement {
  const bricks = useBricksList();
  const sparklineData = useForgeStore((s) => s.sparklineData);

  if (bricks.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <h3 className="mb-2 text-sm font-semibold">Fitness</h3>
        <p className="text-xs text-[var(--color-muted)]">No fitness data available.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <h3 className="mb-3 text-sm font-semibold">Fitness</h3>
      <div className="space-y-2">
        {bricks.map((brick) => {
          const data = sparklineData[brick.brickId] ?? [];
          return (
            <div key={brick.brickId} className="flex items-center gap-2 text-xs">
              <span className="w-24 truncate font-medium">{brick.name}</span>
              <span className="font-mono tracking-tight">
                {data.length > 0 ? sparkline(data) : "—"}
              </span>
              <span className="text-[var(--color-muted)]">
                {brick.lastFitness > 0 ? `${(brick.lastFitness * 100).toFixed(0)}%` : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
