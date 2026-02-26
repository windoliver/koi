/**
 * Empty state — shown when there's no data to display.
 */

export function EmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-sm font-medium text-[var(--color-muted)]">{title}</p>
      {description !== undefined && (
        <p className="text-xs text-[var(--color-muted)]/60">{description}</p>
      )}
    </div>
  );
}
