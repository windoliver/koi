/**
 * Loading skeleton — animated placeholder for content.
 */

export function LoadingSkeleton({
  className = "",
}: {
  readonly className?: string;
}): React.ReactElement {
  return (
    <div
      className={`animate-pulse rounded-md bg-[var(--color-border)] ${className}`}
    />
  );
}

/** Grid of skeleton cards for the agents page. */
export function AgentCardSkeleton(): React.ReactElement {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <div className="flex items-center justify-between">
        <LoadingSkeleton className="h-5 w-32" />
        <LoadingSkeleton className="h-5 w-16" />
      </div>
      <div className="mt-3 space-y-2">
        <LoadingSkeleton className="h-4 w-24" />
        <LoadingSkeleton className="h-4 w-40" />
        <LoadingSkeleton className="h-4 w-20" />
      </div>
    </div>
  );
}
