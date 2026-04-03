/**
 * SessionViewer — renders session snapshot files.
 *
 * Shows session metadata (state, turns, timestamps) and the message history
 * in a chat-like timeline format.
 */

import { MessageSquare, Clock } from "lucide-react";

interface SessionData {
  readonly agentId?: string;
  readonly state?: string;
  readonly turns?: number;
  readonly startedAt?: number;
  readonly lastActivityAt?: number;
  readonly messages?: readonly SessionMessage[];
  readonly [key: string]: unknown;
}

interface SessionMessage {
  readonly role?: string;
  readonly content?: string;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SessionViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let session: SessionData;
  try {
    session = JSON.parse(content) as SessionData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse session data: {path}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <MessageSquare className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        {session.state !== undefined && (
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {session.state}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Metadata */}
        <div className="mb-4 flex flex-wrap gap-4 text-xs text-[var(--color-muted)]">
          {session.turns !== undefined && (
            <span>Turns: {session.turns}</span>
          )}
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

        {/* Messages */}
        {session.messages !== undefined && session.messages.length > 0 ? (
          <div className="flex flex-col gap-2">
            {session.messages.map((msg, i) => (
              <div
                key={i}
                className={`rounded-lg border border-[var(--color-border)] p-3 ${
                  msg.role === "assistant"
                    ? "ml-4 bg-[var(--color-primary)]/5"
                    : "mr-4"
                }`}
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
