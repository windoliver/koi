/**
 * Variant results panel — shows optimization outcomes per brick.
 */

import { useBricksList } from "../../stores/forge-store.js";

const STATUS_STYLES: Readonly<Record<string, string>> = {
  active: "bg-green-500/10 text-green-600",
  deprecated: "bg-red-500/10 text-red-600",
  promoted: "bg-blue-500/10 text-blue-600",
  quarantined: "bg-yellow-500/10 text-yellow-600",
} as const;

export function VariantResultsPanel(): React.ReactElement {
  const bricks = useBricksList();

  if (bricks.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <h3 className="mb-2 text-sm font-semibold">Variant Results</h3>
        <p className="text-xs text-[var(--color-muted)]">No bricks forged yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <h3 className="mb-3 text-sm font-semibold">Variant Results</h3>
      <div className="space-y-2">
        {bricks.map((brick) => (
          <div key={brick.brickId} className="flex items-center gap-2 text-xs">
            <span className="w-28 truncate font-medium">{brick.name}</span>
            <span
              className={`rounded px-1.5 py-0.5 font-medium ${STATUS_STYLES[brick.status] ?? ""}`}
            >
              {brick.status}
            </span>
            {brick.lastFitness > 0 && (
              <span className="text-[var(--color-muted)]">
                fitness: {(brick.lastFitness * 100).toFixed(0)}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
