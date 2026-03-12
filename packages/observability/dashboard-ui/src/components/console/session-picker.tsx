/**
 * SessionPicker — collapsible sidebar for switching between chat sessions.
 *
 * Lists previous sessions by date, allows loading history,
 * and creating new sessions.
 */

import { Clock, History, Plus } from "lucide-react";
import { memo, useCallback } from "react";
import type { SessionEntry } from "../../hooks/use-session-history.js";

export interface SessionPickerProps {
  readonly sessions: readonly SessionEntry[];
  readonly isLoading: boolean;
  readonly currentSessionId: string | null;
  readonly onSelect: (entry: SessionEntry) => void;
  readonly onNewSession: () => void;
}

function formatDate(ts: number): string {
  if (ts === 0) return "Unknown";
  const date = new Date(ts);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const SessionPicker = memo(function SessionPicker({
  sessions,
  isLoading,
  currentSessionId,
  onSelect,
  onNewSession,
}: SessionPickerProps): React.ReactElement {
  const handleSelect = useCallback(
    (entry: SessionEntry) => {
      if (entry.sessionId !== currentSessionId) {
        onSelect(entry);
      }
    },
    [currentSessionId, onSelect],
  );

  return (
    <div className="flex w-56 flex-col border-r border-[var(--color-border)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)]">
          <History className="h-3 w-3" />
          Sessions
        </div>
        <button
          type="button"
          onClick={onNewSession}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10"
          title="New session"
        >
          <Plus className="h-3 w-3" />
          New
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="px-3 py-4 text-center text-xs text-[var(--color-muted)]">Loading...</div>
        )}

        {!isLoading && sessions.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-[var(--color-muted)]">
            No previous sessions
          </div>
        )}

        {sessions.map((entry) => {
          const isActive = entry.sessionId === currentSessionId;
          return (
            <button
              key={entry.sessionId}
              type="button"
              onClick={() => {
                handleSelect(entry);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                isActive
                  ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-primary)]/5 hover:text-[var(--color-foreground)]"
              }`}
            >
              <Clock className="h-3 w-3 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono">{entry.sessionId}</div>
                <div className="text-[10px] opacity-70">{formatDate(entry.modifiedAt)}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
