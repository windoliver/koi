/**
 * GatewaySessionViewer — renders gateway session files.
 *
 * Shows session ID, channel type, agent binding, connection status,
 * and timestamps.
 */

import { Network, Clock } from "lucide-react";

interface GatewaySessionData {
  readonly sessionId?: string;
  readonly channelType?: string;
  readonly channelId?: string;
  readonly agentId?: string;
  readonly connected?: boolean;
  readonly status?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly metadata?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function GatewaySessionViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: GatewaySessionData;
  try {
    data = JSON.parse(content) as GatewaySessionData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse gateway session: {path}
      </div>
    );
  }

  const isConnected = data.connected === true || data.status === "connected";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Network className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.sessionId ?? path.split("/").pop()}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
            isConnected
              ? "bg-green-500/10 text-green-600"
              : "bg-red-500/10 text-red-600"
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-500"
            }`}
          />
          {isConnected ? "Connected" : "Disconnected"}
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Session ID */}
          {data.sessionId !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Session ID</div>
              <div className="mt-1 text-sm font-mono font-medium">{data.sessionId}</div>
            </div>
          )}

          {/* Channel type */}
          {data.channelType !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Channel Type</div>
              <div className="mt-1 text-sm font-medium">{data.channelType}</div>
            </div>
          )}

          {/* Channel ID */}
          {data.channelId !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Channel ID</div>
              <div className="mt-1 text-sm font-mono font-medium">{data.channelId}</div>
            </div>
          )}

          {/* Agent binding */}
          {data.agentId !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Agent Binding</div>
              <div className="mt-1 text-sm font-mono font-medium">{data.agentId}</div>
            </div>
          )}

          {/* Created at */}
          {data.createdAt !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                <Clock className="h-3 w-3" />
                Created
              </div>
              <div className="mt-1 text-sm font-medium">{formatTimestamp(data.createdAt)}</div>
            </div>
          )}

          {/* Last activity */}
          {data.lastActivityAt !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                <Clock className="h-3 w-3" />
                Last Activity
              </div>
              <div className="mt-1 text-sm font-medium">{formatTimestamp(data.lastActivityAt)}</div>
            </div>
          )}
        </div>

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
