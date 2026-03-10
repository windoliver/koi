/**
 * GatewayNodeViewer — renders gateway node files.
 *
 * Shows node ID, type, connections list, and health status.
 */

import { Network, Activity } from "lucide-react";

interface GatewayNodeData {
  readonly nodeId?: string;
  readonly type?: string;
  readonly nodeType?: string;
  readonly health?: string;
  readonly status?: string;
  readonly connections?: readonly GatewayNodeConnection[];
  readonly metadata?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface GatewayNodeConnection {
  readonly targetId?: string;
  readonly channelId?: string;
  readonly type?: string;
  readonly active?: boolean;
  readonly [key: string]: unknown;
}

const HEALTH_COLORS: Readonly<Record<string, string>> = {
  healthy: "bg-green-500/10 text-green-600",
  degraded: "bg-yellow-500/10 text-yellow-600",
  unhealthy: "bg-red-500/10 text-red-600",
  unknown: "bg-[var(--color-muted)]/10 text-[var(--color-muted)]",
};

function healthColorClass(health: string): string {
  return HEALTH_COLORS[health.toLowerCase()] ?? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]";
}

export function GatewayNodeViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: GatewayNodeData;
  try {
    data = JSON.parse(content) as GatewayNodeData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse gateway node: {path}
      </div>
    );
  }

  const healthStatus = data.health ?? data.status ?? "unknown";
  const nodeType = data.type ?? data.nodeType;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Network className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.nodeId ?? path.split("/").pop()}
        </span>
        {nodeType !== undefined && (
          <span className="rounded bg-[var(--color-muted)]/10 px-2 py-0.5 text-xs text-[var(--color-muted)]">
            {nodeType}
          </span>
        )}
        <span className={`rounded px-2 py-0.5 text-xs ${healthColorClass(healthStatus)}`}>
          {healthStatus}
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Node ID */}
          {data.nodeId !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Node ID</div>
              <div className="mt-1 text-sm font-mono font-medium">{data.nodeId}</div>
            </div>
          )}

          {/* Type */}
          {nodeType !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Type</div>
              <div className="mt-1 text-sm font-medium">{nodeType}</div>
            </div>
          )}

          {/* Health */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <Activity className="h-3.5 w-3.5" />
              Health
            </div>
            <div className="mt-1 text-sm font-medium capitalize">{healthStatus}</div>
          </div>
        </div>

        {/* Connections */}
        {data.connections !== undefined && data.connections.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">
              Connections ({data.connections.length})
            </h3>
            <div className="divide-y divide-[var(--color-border)]/50 rounded-lg border border-[var(--color-border)]">
              {data.connections.map((conn, i) => (
                <div
                  key={conn.targetId ?? conn.channelId ?? i}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      conn.active !== false ? "bg-green-500" : "bg-red-500"
                    }`}
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium">
                      {conn.targetId ?? conn.channelId ?? `Connection #${i}`}
                    </span>
                    {conn.type !== undefined && (
                      <span className="ml-2 text-xs text-[var(--color-muted)]">({conn.type})</span>
                    )}
                  </div>
                  <span className="text-xs text-[var(--color-muted)]">
                    {conn.active !== false ? "Active" : "Inactive"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        {data.metadata !== undefined && Object.keys(data.metadata).length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
              Metadata
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {JSON.stringify(data.metadata, null, 2)}
            </pre>
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
