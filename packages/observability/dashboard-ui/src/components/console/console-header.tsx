/**
 * ConsoleHeader — agent info, connection status, and navigation.
 */

import { ArrowLeft, CircleDot, MessageSquare, TerminalSquare, Wifi, WifiOff } from "lucide-react";
import { memo } from "react";
import type { DashboardAgentSummary } from "@koi/dashboard-types";
import type { SseConnectionState } from "../../lib/sse-client.js";

export interface ConsoleHeaderProps {
  readonly agent: DashboardAgentSummary | undefined;
  readonly onBack: () => void;
  readonly connectionStatus: SseConnectionState;
  readonly agentTerminated: boolean;
  /** Whether terminal mode is active (show terminal vs chat). */
  readonly terminalMode: boolean;
  /** Callback to toggle between chat and terminal modes. */
  readonly onToggleTerminal: () => void;
}

/** Map agent state to status indicator color. */
function stateColor(state: string, terminated: boolean): string {
  if (terminated) return "text-red-500";
  switch (state) {
    case "running":
      return "text-green-500";
    case "suspended":
      return "text-yellow-500";
    case "error":
      return "text-red-500";
    default:
      return "text-[var(--color-muted)]";
  }
}

export const ConsoleHeader = memo(function ConsoleHeader({
  agent,
  onBack,
  connectionStatus,
  agentTerminated,
  terminalMode,
  onToggleTerminal,
}: ConsoleHeaderProps): React.ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
      >
        <ArrowLeft className="h-3 w-3" />
        Back
      </button>

      <div className="h-4 w-px bg-[var(--color-border)]" />

      {agent !== undefined ? (
        <>
          <CircleDot className={`h-3 w-3 ${stateColor(agent.state, agentTerminated)}`} />
          <span className="text-sm font-medium">{agent.name}</span>
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {agentTerminated ? "terminated" : agent.state}
          </span>
          {agent.model !== undefined && (
            <span className="text-xs text-[var(--color-muted)]">{agent.model}</span>
          )}
        </>
      ) : (
        <span className="text-sm text-[var(--color-muted)]">No agent selected</span>
      )}

      {/* Mode toggle — switch between chat and terminal */}
      <button
        type="button"
        onClick={onToggleTerminal}
        className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-primary)]/10 hover:text-[var(--color-foreground)]"
        title={terminalMode ? "Switch to Chat" : "Switch to Terminal"}
      >
        {terminalMode ? (
          <>
            <MessageSquare className="h-3 w-3" />
            Chat
          </>
        ) : (
          <>
            <TerminalSquare className="h-3 w-3" />
            Terminal
          </>
        )}
      </button>

      {/* Connection status indicator */}
      <div className="flex items-center gap-1.5 text-xs">
        {connectionStatus === "connected" && (
          <span className="flex items-center gap-1 text-green-500">
            <Wifi className="h-3 w-3" />
            Connected
          </span>
        )}
        {connectionStatus === "reconnecting" && (
          <span className="flex items-center gap-1 text-yellow-500">
            <Wifi className="h-3 w-3 animate-pulse" />
            Reconnecting...
          </span>
        )}
        {connectionStatus === "disconnected" && (
          <span className="flex items-center gap-1 text-red-500">
            <WifiOff className="h-3 w-3" />
            Disconnected
          </span>
        )}
      </div>
    </div>
  );
});
