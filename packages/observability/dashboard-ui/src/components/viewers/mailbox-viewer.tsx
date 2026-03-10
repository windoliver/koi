/**
 * MailboxViewer — renders mailbox data files.
 *
 * Shows list of messages with from, to, timestamp, and content preview.
 * If no messages, shows an empty state.
 */

import { Mail, Clock } from "lucide-react";

interface MailboxData {
  readonly messages?: readonly MailboxMessage[];
  readonly mailboxId?: string;
  readonly [key: string]: unknown;
}

interface MailboxMessage {
  readonly from?: string;
  readonly to?: string;
  readonly timestamp?: number;
  readonly content?: string;
  readonly subject?: string;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function contentPreview(text: string): string {
  return text.length > 150 ? `${text.slice(0, 150)}...` : text;
}

export function MailboxViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: MailboxData;
  try {
    const parsed: unknown = JSON.parse(content);
    // Support both { messages: [...] } and direct array format
    if (Array.isArray(parsed)) {
      data = { messages: parsed as readonly MailboxMessage[] };
    } else {
      data = parsed as MailboxData;
    }
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse mailbox data: {path}
      </div>
    );
  }

  const messages = data.messages ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Mail className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.mailboxId ?? path.split("/").pop()}
        </span>
        <span className="text-xs text-[var(--color-muted)]">{messages.length} messages</span>
      </div>
      <div className="flex-1 overflow-auto">
        {messages.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]/50">
            {messages.map((msg, i) => (
              <div key={i} className="px-4 py-3 hover:bg-[var(--color-muted)]/5">
                <div className="flex items-center gap-3 text-xs">
                  {msg.from !== undefined && (
                    <span className="font-medium">{msg.from}</span>
                  )}
                  {msg.to !== undefined && (
                    <>
                      <span className="text-[var(--color-muted)]">→</span>
                      <span className="font-medium">{msg.to}</span>
                    </>
                  )}
                  {msg.timestamp !== undefined && (
                    <span className="ml-auto flex items-center gap-1 text-[var(--color-muted)]">
                      <Clock className="h-3 w-3" />
                      {formatTimestamp(msg.timestamp)}
                    </span>
                  )}
                </div>
                {msg.subject !== undefined && (
                  <div className="mt-1 text-sm font-medium">{msg.subject}</div>
                )}
                {msg.content !== undefined && (
                  <div className="mt-1 text-xs text-[var(--color-muted)]">
                    {contentPreview(msg.content)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <Mail className="mb-2 h-8 w-8 text-[var(--color-muted)]/30" />
            <div className="text-sm text-[var(--color-muted)]">No messages</div>
          </div>
        )}
      </div>
    </div>
  );
}
