/**
 * SnapshotDag — React Flow DAG for snapshot chains.
 *
 * Renders snapshots as nodes in a vertical layout with edges from
 * child to parent. Root nodes (no parentHash) are highlighted.
 */

import { memo, useMemo } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import type { Edge, Node } from "reactflow";
import "reactflow/dist/style.css";

interface SnapshotEntry {
  readonly hash?: string;
  readonly parentHash?: string;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

interface SnapshotDagProps {
  readonly nodes: readonly SnapshotEntry[];
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 50;
const VERTICAL_GAP = 80;

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function truncateHash(hash: string): string {
  return hash.length > 8 ? hash.slice(0, 8) : hash;
}

const ROOT_NODE_STYLE = {
  background: "var(--color-primary, #89b4fa)",
  border: "2px solid var(--color-primary, #89b4fa)",
  borderRadius: "6px",
  padding: "8px 12px",
  fontSize: "11px",
  color: "var(--color-card, #1e1e2e)",
  fontWeight: 600,
  width: NODE_WIDTH,
} as const;

const CHILD_NODE_STYLE = {
  background: "var(--color-card, #1e1e2e)",
  border: "1px solid var(--color-border, #444)",
  borderRadius: "6px",
  padding: "8px 12px",
  fontSize: "11px",
  color: "var(--color-foreground, #cdd6f4)",
  width: NODE_WIDTH,
} as const;

function computeDag(entries: readonly SnapshotEntry[]): {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
} {
  // Sort by timestamp ascending so oldest is at top
  const sorted = [...entries].sort((a, b) => {
    const aTs = a.timestamp ?? 0;
    const bTs = b.timestamp ?? 0;
    return aTs - bTs;
  });

  const flowNodes: readonly Node[] = sorted.map((entry, i) => {
    const isRoot = entry.parentHash === undefined;
    const hashLabel = entry.hash !== undefined ? truncateHash(entry.hash) : `node-${String(i)}`;
    const tsLabel = entry.timestamp !== undefined ? formatTimestamp(entry.timestamp) : "";
    const label = tsLabel.length > 0 ? `${hashLabel}\n${tsLabel}` : hashLabel;

    return {
      id: entry.hash ?? `node-${String(i)}`,
      type: "default",
      position: { x: 100, y: i * (NODE_HEIGHT + VERTICAL_GAP) },
      data: { label },
      style: isRoot ? { ...ROOT_NODE_STYLE } : { ...CHILD_NODE_STYLE },
    };
  });

  // Build a set of known node IDs for edge validation
  const knownIds = new Set(flowNodes.map((n) => n.id));

  const flowEdges: readonly Edge[] = sorted
    .filter(
      (entry): entry is SnapshotEntry & { readonly hash: string; readonly parentHash: string } =>
        entry.hash !== undefined && entry.parentHash !== undefined && knownIds.has(entry.parentHash),
    )
    .map((entry) => ({
      id: `edge-${entry.hash}-${entry.parentHash}`,
      source: entry.hash,
      target: entry.parentHash,
      style: {
        stroke: "var(--color-border, #555)",
        strokeWidth: 2,
      },
      animated: false,
    }));

  return { nodes: [...flowNodes], edges: [...flowEdges] };
}

export const SnapshotDag = memo(function SnapshotDag({ nodes: entries }: SnapshotDagProps): React.ReactElement {
  const { nodes, edges } = useMemo(() => computeDag(entries), [entries]);

  if (entries.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center text-sm text-[var(--color-muted)]">
        No snapshots
      </div>
    );
  }

  const flow: React.ReactElement = (
    // @ts-expect-error — React 19 JSX type mismatch with library's React 18 declarations (same as CodeMirror)
    <ReactFlow nodes={nodes as Node[]} edges={edges as Edge[]} fitView>
      <Background />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );

  return (
    <div className="h-[400px] w-full rounded border border-[var(--color-border)]">
      {flow}
    </div>
  );
});
