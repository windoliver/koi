/**
 * TopologyDiagram — React Flow network graph for gateway topology.
 *
 * Renders agents as circles and channels as rectangles with edges
 * colored green (connected) or red (disconnected).
 */

import { useMemo } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import type { Edge, Node } from "reactflow";
import "reactflow/dist/style.css";

interface TopologyConnection {
  readonly channelId?: string;
  readonly channelType?: string;
  readonly agentId?: string;
  readonly connected?: boolean;
}

interface TopologyDiagramProps {
  readonly connections: readonly TopologyConnection[];
}

const CHANNEL_NODE_STYLE = {
  background: "var(--color-card, #1e1e2e)",
  border: "1px solid var(--color-border, #444)",
  borderRadius: "4px",
  padding: "8px 12px",
  fontSize: "12px",
  color: "var(--color-foreground, #cdd6f4)",
} as const;

const AGENT_NODE_STYLE = {
  background: "var(--color-primary, #89b4fa)",
  border: "1px solid var(--color-border, #444)",
  borderRadius: "50%",
  width: "60px",
  height: "60px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "11px",
  color: "var(--color-card, #1e1e2e)",
  fontWeight: 600,
} as const;

function computeNodesAndEdges(connections: readonly TopologyConnection[]): {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
} {
  const channelIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const conn of connections) {
    if (conn.channelId !== undefined) {
      channelIds.add(conn.channelId);
    }
    if (conn.agentId !== undefined) {
      agentIds.add(conn.agentId);
    }
  }

  const channelArray = [...channelIds];
  const agentArray = [...agentIds];

  const channelNodes: readonly Node[] = channelArray.map((id, i) => ({
    id: `channel-${id}`,
    type: "default",
    position: { x: 50, y: 80 * i + 40 },
    data: { label: id },
    style: { ...CHANNEL_NODE_STYLE },
  }));

  const agentNodes: readonly Node[] = agentArray.map((id, i) => ({
    id: `agent-${id}`,
    type: "default",
    position: { x: 350, y: 80 * i + 40 },
    data: { label: id.length > 8 ? id.slice(0, 8) : id },
    style: { ...AGENT_NODE_STYLE },
  }));

  const edges: readonly Edge[] = connections
    .filter(
      (conn): conn is TopologyConnection & { readonly channelId: string; readonly agentId: string } =>
        conn.channelId !== undefined && conn.agentId !== undefined,
    )
    .map((conn, i) => ({
      id: `edge-${conn.channelId}-${conn.agentId}-${String(i)}`,
      source: `channel-${conn.channelId}`,
      target: `agent-${conn.agentId}`,
      animated: conn.connected === true,
      style: {
        stroke: conn.connected === true ? "#a6e3a1" : "#f38ba8",
        strokeWidth: 2,
      },
      label: conn.channelType ?? undefined,
      labelStyle: { fontSize: 10, fill: "var(--color-muted, #888)" },
    }));

  return { nodes: [...channelNodes, ...agentNodes], edges: [...edges] };
}

export function TopologyDiagram({ connections }: TopologyDiagramProps): React.ReactElement {
  const { nodes, edges } = useMemo(() => computeNodesAndEdges(connections), [connections]);

  if (connections.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center text-sm text-[var(--color-muted)]">
        No connections
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
}
