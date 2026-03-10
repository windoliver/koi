/**
 * AgentOverviewViewer — renders agent namespace root overview.
 *
 * Shows agent name, type, state badges, middleware chain, channels,
 * child agent count, and action buttons (suspend/resume/terminate).
 */

import { useCallback } from "react";
import {
  GitBranch,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Settings,
  User,
  XCircle,
} from "lucide-react";
import { useCommand } from "../../hooks/use-command.js";
import { resumeAgent, suspendAgent, terminateAgent } from "../../lib/api-client.js";

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
  return (
    STATE_COLORS[state.toLowerCase()] ??
    "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
  );
}

/** Extract agent ID from a Nexus namespace path like /agents/<id>/overview.json */
function extractAgentId(path: string): string | undefined {
  const segments = path.split("/");
  const agentsIdx = segments.indexOf("agents");
  if (agentsIdx >= 0) {
    return segments[agentsIdx + 1];
  }
  return undefined;
}

export function AgentOverviewViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
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

  const agentId = extractAgentId(path) ?? data.name ?? "";
  const childCount = data.childAgentCount ?? data.childAgents?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
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
          <span
            className={`rounded px-2 py-0.5 text-xs ${stateColorClass(data.state)}`}
          >
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
                    <span className="shrink-0 text-[var(--color-muted)]">
                      {i + 1}.
                    </span>
                    <span className="rounded bg-[var(--color-muted)]/10 px-2 py-0.5">
                      {mw}
                    </span>
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
        <AgentActions agentId={agentId} />

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

/** Action buttons wired to real API commands. Extracted to satisfy hooks rules. */
function AgentActions({
  agentId,
}: {
  readonly agentId: string;
}): React.ReactElement {
  const resumeCmd = useCommand(
    useCallback(() => resumeAgent(agentId), [agentId]),
  );
  const suspendCmd = useCommand(
    useCallback(() => suspendAgent(agentId), [agentId]),
  );
  const terminateCmd = useCommand(
    useCallback(() => terminateAgent(agentId), [agentId]),
  );

  const anyExecuting =
    resumeCmd.isExecuting ||
    suspendCmd.isExecuting ||
    terminateCmd.isExecuting;
  const error =
    resumeCmd.error ?? suspendCmd.error ?? terminateCmd.error;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={anyExecuting}
          onClick={() => void resumeCmd.execute()}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-muted)]/10 disabled:opacity-50"
        >
          {resumeCmd.isExecuting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Resume
        </button>
        <button
          type="button"
          disabled={anyExecuting}
          onClick={() => void suspendCmd.execute()}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-muted)]/10 disabled:opacity-50"
        >
          {suspendCmd.isExecuting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Pause className="h-3.5 w-3.5" />
          )}
          Suspend
        </button>
        <button
          type="button"
          disabled={anyExecuting}
          onClick={() => void terminateCmd.execute()}
          className="flex items-center gap-1 rounded border border-red-500/30 px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50"
        >
          {terminateCmd.isExecuting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
          Terminate
        </button>
      </div>
      {error !== null && (
        <div className="mt-2 text-xs text-red-500">{error.message}</div>
      )}
    </div>
  );
}
