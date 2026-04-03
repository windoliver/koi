/**
 * MemoryEntityViewer — renders individual memory entity files.
 *
 * Shows content, category badge, relevance score (as progress bar),
 * token count, and timestamps.
 */

import { Brain, Tag, Clock, Hash } from "lucide-react";

interface MemoryEntityData {
  readonly content?: string;
  readonly category?: string;
  readonly relevance?: number;
  readonly tokenCount?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly entityId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function MemoryEntityViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let entity: MemoryEntityData;
  try {
    entity = JSON.parse(content) as MemoryEntityData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse memory entity: {path}
      </div>
    );
  }

  const relevancePercent = entity.relevance !== undefined
    ? Math.round(Math.min(1, Math.max(0, entity.relevance)) * 100)
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Brain className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {entity.entityId ?? path.split("/").pop()}
        </span>
        {entity.category !== undefined && (
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {entity.category}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Content */}
        {entity.content !== undefined && (
          <div className="mb-4 rounded-lg border border-[var(--color-border)] p-3">
            <div className="whitespace-pre-wrap text-sm">{entity.content}</div>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Relevance score */}
          {relevancePercent !== null && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <Tag className="h-3.5 w-3.5" />
                Relevance
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{relevancePercent}%</span>
                </div>
                <div className="mt-1 h-2 w-full rounded-full bg-[var(--color-muted)]/10">
                  <div
                    className="h-2 rounded-full bg-[var(--color-primary)]"
                    style={{ width: `${relevancePercent}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Token count */}
          {entity.tokenCount !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <Hash className="h-3.5 w-3.5" />
                Token Count
              </div>
              <div className="mt-1 text-lg font-medium font-mono">
                {entity.tokenCount.toLocaleString()}
              </div>
            </div>
          )}

          {/* Timestamps */}
          {entity.createdAt !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <Clock className="h-3.5 w-3.5" />
                Created
              </div>
              <div className="mt-1 text-sm font-medium">
                {formatTimestamp(entity.createdAt)}
              </div>
            </div>
          )}

          {entity.updatedAt !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <Clock className="h-3.5 w-3.5" />
                Updated
              </div>
              <div className="mt-1 text-sm font-medium">
                {formatTimestamp(entity.updatedAt)}
              </div>
            </div>
          )}
        </div>

        {/* Metadata */}
        {entity.metadata !== undefined && Object.keys(entity.metadata).length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
              Metadata
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {JSON.stringify(entity.metadata, null, 2)}
            </pre>
          </details>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
            Raw JSON
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(entity, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
