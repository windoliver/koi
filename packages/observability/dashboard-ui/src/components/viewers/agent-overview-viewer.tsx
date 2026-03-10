/**
 * AgentOverviewViewer — renders agent namespace root overview.
 *
 * Shows agent name, type, state badges, middleware chain, channels,
 * child agent count, and placeholder action buttons.
 */

import { useState } from "react";
import { User, Settings, MessageSquare, GitBranch, Play, Pause, XCircle } from "lucide-react";

interface AgentOverviewData {
  readonly name?: string;
  readonly agentType?: string;
  readonly state?: string;
  readonly middleware?: readonly string[];
  readonly channels?: readonly string[];
  readonly childAgents?: readonly string[];
  readonly childAgentCount?: number;
  readonly [key: string]: unknown;
}

const STATE_COLORS: Readonly<Record<string, string>> = {
  running: "bg-green-500/10 text-green-600",
  suspended: "bg-yellow-500/10 text-yellow-600",
  terminated: "bg-red-500/10 text-red-600",
  idle: "bg-[var(--color-muted)]/10 text-[var(--color-muted)]",
};

function stateColorClass(state: string): string {
  return STATE_COLORS[state.toLowerCase()] ?? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]";
}

export function AgentOverviewViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  const [actionLog, setActionLog] = useState<string | null>(null);

  let data: AgentOverviewData;
  try {
    data = JSON.parse(content) as AgentOverviewData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse agent overview: {path}
      </div>
    );
  }

  const childCount = data.childAgentCount ?? data.childAgents?.length ?? 0;

  const handleAction = (action: string): void => {
    console.log(`[AgentOverview] Action: ${action} for agent "${data.name ?? "unknown"}"`);
    setActionLog(`${action} triggered`);
    setTimeout(() => setActionLog(null), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <User className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.name ?? path.split("/").pop()}
        </span>
        {data.agentType !== undefined && (
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {data.agentType}
          </span>
        )}
        {data.state !== undefined && (
          <span className={`rounded px-2 py-0.5 text-xs ${stateColorClass(data.state)}`}>
            {data.state}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Middleware chain */}
          {data.middleware !== undefined && data.middleware.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <Settings className="h-3.5 w-3.5" />
                Middleware Chain ({data.middleware.length})
              </div>
              <ol className="mt-2 space-y-1">
                {data.middleware.map((mw, i) => (
                  <li key={mw} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 text-[var(--color-muted)]">{i + 1}.</span>
                    <span className="rounded bg-[var(--color-muted)]/10 px-2 py-0.5">{mw}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Channels */}
          {data.channels !== undefined && data.channels.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <MessageSquare className="h-3.5 w-3.5" />
                Channels ({data.channels.length})
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {data.channels.map((ch) => (
                  <span
                    key={ch}
                    className="rounded bg-[var(--color-muted)]/10 px-2 py-0.5 text-xs"
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Child agents */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <GitBranch className="h-3.5 w-3.5" />
              Child Agents
            </div>
            <div className="mt-1 text-sm font-medium">{childCount}</div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="mt-6 flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleAction("resume")}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-muted)]/10"
          >
            <Play className="h-3.5 w-3.5" />
            Resume
          </button>
          <button
            type="button"
            onClick={() => handleAction("suspend")}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-muted)]/10"
          >
            <Pause className="h-3.5 w-3.5" />
            Suspend
          </button>
          <button
            type="button"
            onClick={() => handleAction("terminate")}
            className="flex items-center gap-1 rounded border border-red-500/30 px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10"
          >
            <XCircle className="h-3.5 w-3.5" />
            Terminate
          </button>
          {actionLog !== null && (
            <span className="text-xs text-[var(--color-muted)]">{actionLog}</span>
          )}
        </div>

        <details className="mt-6">
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
