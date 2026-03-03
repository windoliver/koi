/**
 * Color-coded ProcessState badge for agent cards.
 */

import type { DashboardAgentSummary } from "@koi/dashboard-types";

const STATE_STYLES: Readonly<
  Record<string, { readonly bg: string; readonly text: string }>
> = {
  created: { bg: "bg-[var(--color-muted)]/20", text: "text-[var(--color-muted)]" },
  running: { bg: "bg-[var(--color-success)]/20", text: "text-[var(--color-success)]" },
  waiting: { bg: "bg-[var(--color-warning)]/20", text: "text-[var(--color-warning)]" },
  suspended: { bg: "bg-[var(--color-warning)]/20", text: "text-[var(--color-warning)]" },
  terminated: { bg: "bg-[var(--color-error)]/20", text: "text-[var(--color-error)]" },
};

const DEFAULT_STYLE = { bg: "bg-[var(--color-muted)]/20", text: "text-[var(--color-muted)]" };

export function AgentStatusBadge({
  state,
}: {
  readonly state: DashboardAgentSummary["state"];
}): React.ReactElement {
  const style = STATE_STYLES[state] ?? DEFAULT_STYLE;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      {state}
    </span>
  );
}
