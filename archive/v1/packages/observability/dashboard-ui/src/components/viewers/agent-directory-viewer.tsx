/**
 * AgentDirectoryViewer — full agent root directory overview.
 *
 * Per admin-panel.md contract: /agents/{id}/ → AgentOverviewViewer.
 * Combines runtime procfs data, middleware chain, channels, namespace
 * contents, and action controls (suspend/resume/terminate).
 */

import { useQuery } from "@tanstack/react-query";
import type { AgentProcfs, MiddlewareChain } from "@koi/dashboard-types";
import {
  Activity,
  Clock,
  Folder,
  GitBranch,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Settings,
  User,
  XCircle,
} from "lucide-react";
import { useCallback } from "react";
import { useFileTree } from "../../hooks/use-file-tree.js";
import {
  useCommand,
  useResumeAgent,
  useSuspendAgent,
} from "../../hooks/use-command.js";
import {
  fetchAgentProcfs,
  fetchMiddlewareChain,
  terminateAgent,
} from "../../lib/api-client.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { useViewStore } from "../../stores/view-store.js";
import { ProcessStateBadge } from "../shared/process-state-badge.js";

function extractAgentId(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  const agentsIdx = segments.indexOf("agents");
  if (agentsIdx < 0) return "";
  return segments[agentsIdx + 1] ?? "";
}

function formatUptime(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function AgentDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const agentId = extractAgentId(path);
  const globPattern = useViewStore((s) => s.activeView.globPattern);
  const { entries, isLoading: treeLoading } = useFileTree(
    path,
    globPattern !== undefined ? { glob: globPattern } : undefined,
  );
  const select = useTreeStore((s) => s.select);
  const setExpanded = useTreeStore((s) => s.setExpanded);

  const procfs = useQuery({
    queryKey: ["agent-procfs", agentId],
    queryFn: () => fetchAgentProcfs(agentId),
    enabled: agentId.length > 0,
    staleTime: 10_000,
    retry: 1,
  });

  const middlewareQuery = useQuery({
    queryKey: ["middleware-chain", agentId],
    queryFn: () => fetchMiddlewareChain(agentId),
    enabled: agentId.length > 0,
    staleTime: 30_000,
    retry: 1,
  });

  const agent: AgentProcfs | undefined =
    procfs.data !== undefined ? procfs.data : undefined;
  const chain: MiddlewareChain | undefined =
    middlewareQuery.data !== undefined ? middlewareQuery.data : undefined;

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <User className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {agent?.name ?? agentId}
        </span>
        {agent !== undefined && (
          <>
            <ProcessStateBadge state={agent.state} />
            <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 font-mono text-xs font-medium uppercase tracking-wider text-[var(--color-primary)]">
              {agent.agentType}
            </span>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* Runtime overview card */}
        {agent !== undefined && (
          <div className="mb-4 grid gap-3 rounded-lg border border-[var(--color-border)] p-4 sm:grid-cols-2 lg:grid-cols-4">
            {agent.model !== undefined && (
              <div className="text-xs">
                <span className="text-[var(--color-muted)]">Model</span>
                <div className="mt-0.5 font-medium">{agent.model}</div>
              </div>
            )}
            <div className="text-xs">
              <span className="text-[var(--color-muted)]">Uptime</span>
              <div className="mt-0.5 flex items-center gap-1 font-medium">
                <Clock className="h-3 w-3" />
                {formatUptime(agent.startedAt)}
              </div>
            </div>
            <div className="text-xs">
              <span className="text-[var(--color-muted)]">Turns</span>
              <div className="mt-0.5 flex items-center gap-1 font-medium">
                <Activity className="h-3 w-3" />
                {agent.turns}
              </div>
            </div>
            <div className="text-xs">
              <span className="text-[var(--color-muted)]">Tokens</span>
              <div className="mt-0.5 font-medium">
                {formatTokens(agent.tokenCount)}
              </div>
            </div>
          </div>
        )}

        {procfs.error !== null && !procfs.isLoading && (
          <div className="mb-4 rounded border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted)]">
            Runtime data unavailable
          </div>
        )}

        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          {/* Channels */}
          {agent !== undefined && agent.channels.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <MessageSquare className="h-3.5 w-3.5" />
                Channels ({agent.channels.length})
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {agent.channels.map((ch) => (
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

          {/* Middleware chain */}
          {chain !== undefined && chain.entries.length > 0 && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <Settings className="h-3.5 w-3.5" />
                Middleware Chain ({chain.entries.length})
              </div>
              <ol className="mt-2 space-y-1">
                {chain.entries.map((mw, i) => (
                  <li key={mw.name} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 text-[var(--color-muted)]">
                      {i + 1}.
                    </span>
                    <span className="rounded bg-[var(--color-muted)]/10 px-2 py-0.5">
                      {mw.name}
                    </span>
                    <span className="text-[var(--color-muted)]">{mw.phase}</span>
                    {!mw.enabled && (
                      <span className="text-yellow-500">disabled</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Children */}
          {agent !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <GitBranch className="h-3.5 w-3.5" />
                Child Agents
              </div>
              <div className="mt-1 text-sm font-medium">{agent.childCount}</div>
            </div>
          )}
        </div>

        {/* Actions */}
        <AgentActions agentId={agentId} />

        {/* Namespace contents */}
        <h3 className="mb-2 mt-6 flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)]">
          <Folder className="h-3.5 w-3.5" />
          Namespace Contents
          {!treeLoading && (
            <span className="font-normal">({entries.length} items)</span>
          )}
        </h3>

        {treeLoading ? (
          <div className="text-xs text-[var(--color-muted)]">Loading...</div>
        ) : sorted.length === 0 ? (
          <div className="text-xs italic text-[var(--color-muted)]">
            Empty namespace
          </div>
        ) : (
          <div className="grid gap-1">
            {sorted.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-muted)]/10"
                onClick={() => {
                  if (entry.isDirectory) {
                    setExpanded(entry.path, true);
                  }
                  select(entry.path, entry.isDirectory);
                }}
              >
                <Folder className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                <span>{entry.name}</span>
              </button>
            ))}
          </div>
        )}
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
  const resumeCmd = useResumeAgent(agentId);
  const suspendCmd = useSuspendAgent(agentId);
  const terminateCmd = useCommand(
    useCallback(() => terminateAgent(agentId), [agentId]),
  );

  const anyExecuting =
    resumeCmd.isExecuting || suspendCmd.isExecuting || terminateCmd.isExecuting;
  const error = resumeCmd.error ?? suspendCmd.error ?? terminateCmd.error;

  return (
    <div className="mb-4">
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
