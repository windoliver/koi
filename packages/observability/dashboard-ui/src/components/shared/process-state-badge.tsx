/**
 * Process state badge — colored dot + label for agent process states.
 */

const STATE_CONFIG: Readonly<
  Record<string, { readonly dot: string; readonly text: string }>
> = {
  created: { dot: "bg-[var(--color-muted)]", text: "text-[var(--color-muted)]" },
  running: { dot: "bg-[var(--color-success)]", text: "text-[var(--color-success)]" },
  waiting: { dot: "bg-[var(--color-warning)]", text: "text-[var(--color-warning)]" },
  suspended: { dot: "bg-orange-500", text: "text-orange-500" },
  terminated: { dot: "bg-[var(--color-error)]", text: "text-[var(--color-error)]" },
  failed: { dot: "bg-[var(--color-error)]", text: "text-[var(--color-error)]" },
  degraded: { dot: "bg-orange-500", text: "text-orange-500" },
};

const DEFAULT_CONFIG = {
  dot: "bg-[var(--color-muted)]",
  text: "text-[var(--color-muted)]",
} as const;

export function ProcessStateBadge({
  state,
}: {
  readonly state: string;
}): React.ReactElement {
  const config = STATE_CONFIG[state] ?? DEFAULT_CONFIG;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${config.text}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${config.dot}`} />
      {state}
    </span>
  );
}
