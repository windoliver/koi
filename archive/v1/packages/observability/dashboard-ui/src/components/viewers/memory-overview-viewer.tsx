/**
 * MemoryOverviewViewer — renders memory directory root overview.
 *
 * Shows total entities, total tokens, context budget usage as a progress bar
 * (used/total), and entity list summary.
 */

import { Brain, Hash, Database } from "lucide-react";

interface MemoryOverviewData {
  readonly totalEntities?: number;
  readonly totalTokens?: number;
  readonly contextBudget?: number;
  readonly contextUsed?: number;
  readonly entities?: readonly MemoryOverviewEntry[];
  readonly [key: string]: unknown;
}

interface MemoryOverviewEntry {
  readonly entityId?: string;
  readonly category?: string;
  readonly relevance?: number;
  readonly tokenCount?: number;
  readonly [key: string]: unknown;
}

export function MemoryOverviewViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: MemoryOverviewData;
  try {
    data = JSON.parse(content) as MemoryOverviewData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse memory overview: {path}
      </div>
    );
  }

  const budgetUsedPercent = data.contextBudget !== undefined && data.contextBudget > 0 && data.contextUsed !== undefined
    ? Math.round(Math.min(1, data.contextUsed / data.contextBudget) * 100)
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Brain className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">Memory Overview</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Stats grid */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Total entities */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <Database className="h-3.5 w-3.5" />
              Total Entities
            </div>
            <div className="mt-1 text-lg font-medium">
              {data.totalEntities ?? data.entities?.length ?? 0}
            </div>
          </div>

          {/* Total tokens */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <Hash className="h-3.5 w-3.5" />
              Total Tokens
            </div>
            <div className="mt-1 text-lg font-medium font-mono">
              {data.totalTokens !== undefined ? data.totalTokens.toLocaleString() : "-"}
            </div>
          </div>
        </div>

        {/* Context budget */}
        {budgetUsedPercent !== null && data.contextUsed !== undefined && data.contextBudget !== undefined && (
          <div className="mt-4 rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--color-muted)]">Context Budget</span>
              <span className="font-medium">
                {data.contextUsed.toLocaleString()} / {data.contextBudget.toLocaleString()} tokens
              </span>
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-[var(--color-muted)]/10">
              <div
                className={`h-2 rounded-full ${
                  budgetUsedPercent > 90
                    ? "bg-red-500"
                    : budgetUsedPercent > 70
                      ? "bg-yellow-500"
                      : "bg-[var(--color-primary)]"
                }`}
                style={{ width: `${budgetUsedPercent}%` }}
              />
            </div>
            <div className="mt-1 text-right text-xs text-[var(--color-muted)]">
              {budgetUsedPercent}% used
            </div>
          </div>
        )}

        {/* Entity summary list */}
        {data.entities !== undefined && data.entities.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">
              Entities ({data.entities.length})
            </h3>
            <div className="divide-y divide-[var(--color-border)]/50 rounded-lg border border-[var(--color-border)]">
              {data.entities.map((entity, i) => (
                <div
                  key={entity.entityId ?? i}
                  className="flex items-center gap-3 px-3 py-2 text-xs"
                >
                  <span className="flex-1 font-mono font-medium">
                    {entity.entityId ?? `entity-${i}`}
                  </span>
                  {entity.category !== undefined && (
                    <span className="rounded bg-[var(--color-primary)]/10 px-1.5 py-0.5 text-[var(--color-primary)]">
                      {entity.category}
                    </span>
                  )}
                  {entity.tokenCount !== undefined && (
                    <span className="text-[var(--color-muted)]">
                      {entity.tokenCount.toLocaleString()} tokens
                    </span>
                  )}
                  {entity.relevance !== undefined && (
                    <span className="text-[var(--color-muted)]">
                      {Math.round(entity.relevance * 100)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
            Raw JSON
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
