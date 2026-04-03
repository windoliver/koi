/**
 * SnapshotNodeViewer — renders individual snapshot node files.
 *
 * Shows snapshot hash, parent, timestamp, metadata, and full content
 * as formatted JSON.
 */

import { GitCommit, Clock, Hash } from "lucide-react";

interface SnapshotNodeData {
  readonly hash?: string;
  readonly parentHash?: string;
  readonly timestamp?: number;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
  readonly content?: unknown;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

export function SnapshotNodeViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let node: SnapshotNodeData;
  try {
    node = JSON.parse(content) as SnapshotNodeData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse snapshot node: {path}
      </div>
    );
  }

  // Determine the content payload (could be in `content` or `data` field)
  const { hash, parentHash, timestamp, label, metadata, content: nodeContent, data: nodeData, ...rest } = node;
  const payload = nodeContent ?? nodeData ?? (Object.keys(rest).length > 0 ? rest : undefined);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <GitCommit className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {hash !== undefined ? shortHash(hash) : path.split("/").pop()}
        </span>
        {label !== undefined && (
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {label}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Node metadata card */}
        <div className="mb-4 rounded-lg border border-[var(--color-border)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {hash !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <Hash className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">Hash:</span>
                <span className="font-mono font-medium">{hash}</span>
              </div>
            )}
            {parentHash !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <Hash className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">Parent:</span>
                <span className="font-mono font-medium">{parentHash}</span>
              </div>
            )}
            {timestamp !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">Timestamp:</span>
                <span className="font-medium">{formatTimestamp(timestamp)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Metadata */}
        {metadata !== undefined && Object.keys(metadata).length > 0 && (
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Metadata</h3>
            <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          </div>
        )}

        {/* Full content */}
        {payload !== undefined && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Content</h3>
            <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
