/**
 * SessionRecordViewer — enhanced session viewer with checkpoint and message details.
 *
 * Shows session state, checkpoint count, message history with role-colored
 * messages, and pending frames count.
 */

import { MessageSquare, Clock, Layers, Inbox } from "lucide-react";

interface SessionRecordData {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly state?: string;
  readonly checkpointCount?: number;
  readonly checkpoints?: readonly unknown[];
  readonly pendingFramesCount?: number;
  readonly pendingFrames?: readonly unknown[];
  readonly messages?: readonly SessionRecordMessage[];
  readonly startedAt?: number;
  readonly lastActivityAt?: number;
  readonly [key: string]: unknown;
}

interface SessionRecordMessage {
  readonly role?: string;
  readonly content?: string;
  readonly timestamp?: number;
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

const ROLE_COLORS: Readonly<Record<string, string>> = {
  user: "mr-8 border-blue-500/30 bg-blue-500/5",
  assistant: "ml-8 border-green-500/30 bg-green-500/5",
  system: "border-yellow-500/30 bg-yellow-500/5",
  tool: "ml-4 border-purple-500/30 bg-purple-500/5",
};

function roleColorClass(role: string): string {
  return ROLE_COLORS[role.toLowerCase()] ?? "";
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SessionRecordViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let session: SessionRecordData;
  try {
    session = JSON.parse(content) as SessionRecordData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse session record: {path}
      </div>
    );
  }

  const checkpointCount = session.checkpointCount ?? session.checkpoints?.length ?? 0;
  const pendingCount = session.pendingFramesCount ?? session.pendingFrames?.length ?? 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <MessageSquare className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {session.sessionId ?? path.split("/").pop()}
        </span>
        {session.state !== undefined && (
          <span className={`rounded px-2 py-0.5 text-xs ${stateColorClass(session.state)}`}>
            {session.state}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Stats bar */}
        <div className="mb-4 flex flex-wrap gap-4 text-xs text-[var(--color-muted)]">
          {session.agentId !== undefined && (
            <span>Agent: {session.agentId}</span>
          )}
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            Checkpoints: {checkpointCount}
          </span>
          <span className="flex items-center gap-1">
            <Inbox className="h-3 w-3" />
            Pending Frames: {pendingCount}
          </span>
          {session.startedAt !== undefined && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Started: {formatTime(session.startedAt)}
            </span>
          )}
          {session.lastActivityAt !== undefined && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last: {formatTime(session.lastActivityAt)}
            </span>
          )}
        </div>

        {/* Message history */}
        {session.messages !== undefined && session.messages.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-[var(--color-muted)]">
              Messages ({session.messages.length})
            </h3>
            {session.messages.map((msg, i) => (
              <div
                key={i}
                className={`rounded-lg border p-3 ${roleColorClass(msg.role ?? "unknown")}`}
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                  <span className="font-medium">{msg.role ?? "unknown"}</span>
                  {msg.timestamp !== undefined && (
                    <span>{formatTime(msg.timestamp)}</span>
                  )}
                </div>
                <div className="whitespace-pre-wrap text-sm">
                  {msg.content ?? JSON.stringify(msg)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <details>
            <summary className="cursor-pointer text-xs text-[var(--color-muted)]">
              Raw data
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {JSON.stringify(session, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
