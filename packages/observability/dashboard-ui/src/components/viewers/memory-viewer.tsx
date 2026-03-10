/**
 * MemoryViewer — renders agent memory/knowledge files.
 *
 * Shows key-value pairs from memory snapshots in a structured card layout.
 */

import { Brain } from "lucide-react";

export function MemoryViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Non-JSON memory files (e.g., markdown) — show as text
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
          <Brain className="h-4 w-4 text-[var(--color-muted)]" />
          <span className="text-sm font-medium">{path.split("/").pop()}</span>
        </div>
        <div className="flex-1 overflow-auto p-4 whitespace-pre-wrap font-mono text-sm">
          {content}
        </div>
      </div>
    );
  }

  const entries = Object.entries(data);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Brain className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        <span className="text-xs text-[var(--color-muted)]">{entries.length} entries</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-3">
          {entries.map(([key, value]) => (
            <div
              key={key}
              className="rounded-lg border border-[var(--color-border)] p-3"
            >
              <div className="mb-1 text-xs font-medium text-[var(--color-primary)]">
                {key}
              </div>
              <div className="font-mono text-xs text-[var(--color-muted)]">
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
