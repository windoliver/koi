/**
 * SessionListViewer — renders session directory listings as a table.
 *
 * Shows sessions with columns: ID, State, Turns, Last Activity.
 */

import { MessageSquare } from "lucide-react";

interface SessionListEntry {
  readonly sessionId?: string;
  readonly id?: string;
  readonly state?: string;
  readonly turns?: number;
  readonly lastActivityAt?: number;
  readonly [key: string]: unknown;
}

const STATE_COLORS: Readonly<Record<string, string>> = {
  active: "bg-green-500/10 text-green-600",
  completed: "bg-blue-500/10 text-blue-600",
  suspended: "bg-yellow-500/10 text-yellow-600",
  failed: "bg-red-500/10 text-red-600",
  idle: "bg-[var(--color-muted)]/10 text-[var(--color-muted)]",
};

function stateColorClass(state: string): string {
  return STATE_COLORS[state.toLowerCase()] ?? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]";
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function SessionListViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let sessions: readonly SessionListEntry[];
  try {
    const parsed: unknown = JSON.parse(content);
    sessions = Array.isArray(parsed) ? (parsed as readonly SessionListEntry[]) : [];
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse session list: {path}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <MessageSquare className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        <span className="text-xs text-[var(--color-muted)]">{sessions.length} sessions</span>
      </div>
      <div className="flex-1 overflow-auto">
        {sessions.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]">
                <th className="px-4 py-2 text-left font-medium">ID</th>
                <th className="px-4 py-2 text-left font-medium">State</th>
                <th className="px-4 py-2 text-left font-medium">Turns</th>
                <th className="px-4 py-2 text-left font-medium">Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => {
                const id = s.sessionId ?? s.id ?? `session-${i}`;
                return (
                  <tr
                    key={id}
                    className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-muted)]/5"
                  >
                    <td className="px-4 py-2 font-mono text-xs">{id}</td>
                    <td className="px-4 py-2">
                      {s.state !== undefined ? (
                        <span className={`rounded px-2 py-0.5 text-xs ${stateColorClass(s.state)}`}>
                          {s.state}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-muted)]">-</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
                      {s.turns !== undefined ? s.turns : "-"}
                    </td>
                    <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
                      {s.lastActivityAt !== undefined ? formatTimestamp(s.lastActivityAt) : "-"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
            No sessions found
          </div>
        )}
      </div>
    </div>
  );
}
