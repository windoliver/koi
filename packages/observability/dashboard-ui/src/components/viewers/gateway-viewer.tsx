/**
 * GatewayViewer — renders gateway configuration and connection files.
 */

import { Network } from "lucide-react";
import { TopologyDiagram } from "../shared/topology-diagram.js";

interface GatewayData {
  readonly connections?: readonly GatewayConnectionEntry[];
  readonly nodeCount?: number;
  readonly [key: string]: unknown;
}

interface GatewayConnectionEntry {
  readonly channelId?: string;
  readonly channelType?: string;
  readonly connected?: boolean;
  readonly agentId?: string;
}

export function GatewayViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: GatewayData;
  try {
    data = JSON.parse(content) as GatewayData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">Failed to parse gateway data: {path}</div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Network className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        {data.nodeCount !== undefined && (
          <span className="text-xs text-[var(--color-muted)]">{data.nodeCount} nodes</span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {data.connections !== undefined && data.connections.length > 0 ? (
          <div className="grid gap-2">
            {data.connections.map((conn, i) => (
              <div
                key={conn.channelId ?? i}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3"
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    conn.connected === true ? "bg-green-500" : "bg-red-500"
                  }`}
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {conn.channelId ?? "Unknown"}
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {conn.channelType ?? "unknown"}{" "}
                    {conn.agentId !== undefined && `→ ${conn.agentId}`}
                  </div>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    conn.connected === true
                      ? "bg-green-500/10 text-green-600"
                      : "bg-red-500/10 text-red-600"
                  }`}
                >
                  {conn.connected === true ? "Connected" : "Disconnected"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}

        {data.connections !== undefined && data.connections.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
              Topology Diagram
            </summary>
            <div className="mt-2">
              <TopologyDiagram connections={data.connections} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
