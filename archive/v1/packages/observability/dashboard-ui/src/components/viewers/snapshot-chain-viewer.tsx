/**
 * SnapshotChainViewer — renders snapshot chain files.
 *
 * Shows chain metadata and a timeline/list of nodes. Each node displays
 * hash, parent hash, timestamp, and a "View" link.
 */

import { GitBranch, Clock, Link } from "lucide-react";
import { SnapshotDag } from "../shared/snapshot-dag.js";

interface SnapshotChainData {
  readonly chainId?: string;
  readonly name?: string;
  readonly length?: number;
  readonly latestHash?: string;
  readonly createdAt?: number;
  readonly nodes?: readonly SnapshotChainNode[];
  readonly [key: string]: unknown;
}

interface SnapshotChainNode {
  readonly hash?: string;
  readonly parentHash?: string;
  readonly timestamp?: number;
  readonly label?: string;
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

export function SnapshotChainViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: SnapshotChainData;
  try {
    data = JSON.parse(content) as SnapshotChainData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse snapshot chain: {path}
      </div>
    );
  }

  const nodeCount = data.length ?? data.nodes?.length ?? 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <GitBranch className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.name ?? data.chainId ?? path.split("/").pop()}
        </span>
        <span className="text-xs text-[var(--color-muted)]">{nodeCount} nodes</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Chain metadata */}
        <div className="mb-4 flex flex-wrap gap-4 text-xs text-[var(--color-muted)]">
          {data.chainId !== undefined && (
            <span>Chain: {data.chainId}</span>
          )}
          {data.latestHash !== undefined && (
            <span>Latest: {shortHash(data.latestHash)}</span>
          )}
          {data.createdAt !== undefined && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTimestamp(data.createdAt)}
            </span>
          )}
        </div>

        {/* Timeline of nodes */}
        {data.nodes !== undefined && data.nodes.length > 0 ? (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-3 top-0 bottom-0 w-px bg-[var(--color-border)]" />

            <div className="space-y-0">
              {data.nodes.map((node, i) => (
                <div
                  key={node.hash ?? i}
                  className="relative flex gap-4 py-2 pl-8"
                >
                  {/* Timeline dot */}
                  <div className="absolute left-2 top-4 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-primary)] bg-[var(--color-card)]" />

                  <div className="flex-1 rounded-lg border border-[var(--color-border)] p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {node.hash !== undefined && (
                          <span className="font-mono text-xs font-medium">
                            {shortHash(node.hash)}
                          </span>
                        )}
                        {node.label !== undefined && (
                          <span className="text-xs text-[var(--color-muted)]">{node.label}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => console.log(`[SnapshotChain] View node: ${node.hash ?? i}`)}
                        className="flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline"
                      >
                        <Link className="h-3 w-3" />
                        View
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                      {node.parentHash !== undefined && (
                        <span>Parent: {shortHash(node.parentHash)}</span>
                      )}
                      {node.timestamp !== undefined && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTimestamp(node.timestamp)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
            No nodes in chain
          </div>
        )}

        {data.nodes !== undefined && data.nodes.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
              Chain Visualization
            </summary>
            <div className="mt-2">
              <SnapshotDag nodes={data.nodes} />
            </div>
          </details>
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
