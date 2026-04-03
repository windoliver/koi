/**
 * TaskDagTab — React Flow DAG with status-colored nodes.
 *
 * Decision 14A: React.memo on nodes, fitView on mount only, updateNodeData for live updates.
 */

import type { TaskBoardNode, TaskBoardSnapshot } from "@koi/dashboard-types";
import React, { memo, useCallback, useMemo, useState } from "react";
import ReactFlow, { Background, Controls } from "reactflow";
import type { Edge, Node, NodeProps } from "reactflow";
import "reactflow/dist/style.css";
import { useRuntimeView } from "../../hooks/use-runtime-view.js";
import { useOrchestrationStore } from "../../stores/orchestration-store.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";
import { TaskNodeDetailPanel } from "./task-node-detail-panel.js";

// ---------------------------------------------------------------------------
// Status → color mapping
// ---------------------------------------------------------------------------

const STATUS_COLORS: Readonly<Record<string, { readonly bg: string; readonly border: string }>> = {
  completed: { bg: "#166534", border: "#22c55e" },
  running: { bg: "#0D1B2A", border: "#00CCCC" },
  pending: { bg: "#1B2838", border: "#8899AA" },
  failed: { bg: "#7f1d1d", border: "#ef4444" },
} as const;

const STATUS_ICONS: Readonly<Record<string, string>> = {
  completed: "\u2713",
  running: "\u25cf",
  pending: "\u25cb",
  failed: "\u2717",
} as const;

// ---------------------------------------------------------------------------
// Custom node component (React.memo for performance — Decision 14A)
// ---------------------------------------------------------------------------

interface TaskNodeData {
  readonly label: string;
  readonly status: string;
  readonly assignedTo?: string | undefined;
}

const DEFAULT_COLORS = { bg: "#1B2838", border: "#8899AA" } as const;

const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskNodeData>): React.ReactElement {
  const colors = STATUS_COLORS[data.status] ?? DEFAULT_COLORS;
  const icon = STATUS_ICONS[data.status] ?? "\u25cb";

  return (
    <div
      className="rounded-md px-3 py-2 text-xs"
      style={{
        background: colors.bg,
        border: `2px solid ${colors.border}`,
        minWidth: 140,
      }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: colors.border }}>{icon}</span>
        <span className="font-medium text-[var(--color-foreground,#cdd6f4)]">
          {data.label}
        </span>
      </div>
      {data.assignedTo !== undefined && (
        <div className="mt-0.5 text-[10px] text-[var(--color-muted,#888)]">
          {data.assignedTo}
        </div>
      )}
    </div>
  );
});

// Defined OUTSIDE component render for React Flow performance
const NODE_TYPES = { task: TaskNode } as const;

// ---------------------------------------------------------------------------
// DAG layout
// ---------------------------------------------------------------------------

const NODE_WIDTH = 160;
const NODE_HEIGHT = 60;
const H_GAP = 200;
const V_GAP = 80;

function computeLayout(snapshot: TaskBoardSnapshot): {
  readonly nodes: readonly Node<TaskNodeData>[];
  readonly edges: readonly Edge[];
} {
  // Build adjacency for topological layering
  const childrenOf = new Map<string, string[]>();
  const parentCount = new Map<string, number>();

  for (const node of snapshot.nodes) {
    childrenOf.set(node.taskId, []);
    parentCount.set(node.taskId, 0);
  }
  for (const edge of snapshot.edges) {
    const children = childrenOf.get(edge.from);
    if (children !== undefined) children.push(edge.to);
    parentCount.set(edge.to, (parentCount.get(edge.to) ?? 0) + 1);
  }

  // BFS layering (topological sort by layer)
  const layers: string[][] = [];
  const queue = snapshot.nodes
    .filter((node: { readonly taskId: string }) => (parentCount.get(node.taskId) ?? 0) === 0)
    .map((node: { readonly taskId: string }) => node.taskId);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const layer = [...queue];
    layers.push(layer);
    queue.length = 0;
    for (const id of layer) {
      visited.add(id);
      for (const child of childrenOf.get(id) ?? []) {
        if (!visited.has(child)) {
          const remaining = (parentCount.get(child) ?? 1) - 1;
          parentCount.set(child, remaining);
          if (remaining <= 0) queue.push(child);
        }
      }
    }
  }

  // Position nodes by layer
  type BoardNode = TaskBoardSnapshot["nodes"][number];
  const nodeMap = new Map<string, BoardNode>(
    snapshot.nodes.map((n: BoardNode): [string, BoardNode] => [n.taskId, n]),
  );
  const flowNodes: Node<TaskNodeData>[] = [];

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    if (layer === undefined) continue;
    for (let nodeIdx = 0; nodeIdx < layer.length; nodeIdx++) {
      const taskId = layer[nodeIdx];
      if (taskId === undefined) continue;
      const task = nodeMap.get(taskId);
      if (task === undefined) continue;
      flowNodes.push({
        id: taskId,
        type: "task",
        position: {
          x: layerIdx * H_GAP,
          y: nodeIdx * V_GAP,
        },
        data: {
          label: task.label,
          status: task.status,
          assignedTo: task.assignedTo,
        },
      });
    }
  }

  type BoardEdge = TaskBoardSnapshot["edges"][number];
  const flowEdges: Edge[] = snapshot.edges.map((e: BoardEdge) => ({
    id: `${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    style: { stroke: "var(--color-border,#555)", strokeWidth: 2 },
    animated: false,
  }));

  return { nodes: flowNodes, edges: flowEdges };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TaskDagTab(): React.ReactElement {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const lastInvalidatedAt = useOrchestrationStore((s) => s.lastInvalidatedAt);

  const { data: snapshot, isLoading } = useRuntimeView<TaskBoardSnapshot>(
    "/taskboard",
    { refetchInterval: 5_000, invalidationKey: lastInvalidatedAt },
  );

  const layout = useMemo(
    () => (snapshot !== undefined ? computeLayout(snapshot) : undefined),
    [snapshot],
  );

  const nodeMap = useMemo(() => {
    if (snapshot === undefined) return new Map<string, TaskBoardNode>();
    return new Map(snapshot.nodes.map((n): [string, TaskBoardNode] => [n.taskId, n]));
  }, [snapshot]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNodeId((prev) => (prev === node.id ? undefined : node.id));
  }, []);

  const selectedNode = selectedNodeId !== undefined ? nodeMap.get(selectedNodeId) : undefined;

  if (isLoading) {
    return <div className="p-4"><LoadingSkeleton /></div>;
  }

  if (layout === undefined || layout.nodes.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center text-xs text-[var(--color-muted,#888)]">
        No tasks in board
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className={`w-full p-2 ${selectedNode !== undefined ? "h-[320px]" : "h-[500px]"}`}>
        {/* @ts-expect-error — React 19 JSX type mismatch with library's React 18 declarations */}
        <ReactFlow
          nodes={layout.nodes as Node[]}
          edges={layout.edges as Edge[]}
          nodeTypes={NODE_TYPES}
          onNodeClick={handleNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {/* Task node detail panel */}
      {selectedNode !== undefined && (
        <TaskNodeDetailPanel
          node={selectedNode}
          onClose={() => setSelectedNodeId(undefined)}
        />
      )}
    </div>
  );
}
