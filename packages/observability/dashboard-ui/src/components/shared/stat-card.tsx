/**
 * Stat card — metric display with icon, label, value, and optional trend.
 */

import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import type { ElementType } from "react";

interface StatCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly icon?: ElementType;
  readonly trend?: "up" | "down" | "neutral";
}

const TREND_CONFIG = {
  up: { Icon: TrendingUp, color: "text-[var(--color-success)]" },
  down: { Icon: TrendingDown, color: "text-[var(--color-error)]" },
  neutral: { Icon: Minus, color: "text-[var(--color-muted)]" },
} as const;

export function StatCard({ label, value, icon: Icon, trend }: StatCardProps): React.ReactElement {
  const trendConfig = trend !== undefined ? TREND_CONFIG[trend] : undefined;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--color-muted)]">{label}</span>
        {Icon !== undefined && (
          <Icon className="h-4 w-4 text-[var(--color-muted)]" />
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-[var(--color-foreground)]">{value}</span>
        {trendConfig !== undefined && (
          <trendConfig.Icon className={`h-4 w-4 ${trendConfig.color}`} />
        )}
      </div>
    </div>
  );
}
