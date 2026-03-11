/**
 * ConsoleHeader — agent info, status, and navigation.
 */

import { ArrowLeft, CircleDot } from "lucide-react";
import { memo } from "react";
import type { DashboardAgentSummary } from "@koi/dashboard-types";

export interface ConsoleHeaderProps {
  readonly agent: DashboardAgentSummary | undefined;
  readonly onBack: () => void;
}

export const ConsoleHeader = memo(function ConsoleHeader({
  agent,
  onBack,
}: ConsoleHeaderProps): React.ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
      >
        <ArrowLeft className="h-3 w-3" />
        Back
      </button>

      <div className="h-4 w-px bg-[var(--color-border)]" />

      {agent !== undefined ? (
        <>
          <CircleDot className="h-3 w-3 text-green-500" />
          <span className="text-sm font-medium">{agent.name}</span>
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {agent.state}
          </span>
          {agent.model !== undefined && (
            <span className="text-xs text-[var(--color-muted)]">{agent.model}</span>
          )}
        </>
      ) : (
        <span className="text-sm text-[var(--color-muted)]">No agent selected</span>
      )}
    </div>
  );
});
