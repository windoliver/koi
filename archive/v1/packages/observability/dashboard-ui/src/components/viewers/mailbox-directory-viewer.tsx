/**
 * MailboxDirectoryViewer — command-backed mailbox listing.
 *
 * When a /mailbox/ directory is selected, fetches messages via the
 * listMailbox() command API instead of reading files from the filesystem.
 */

import { useQuery } from "@tanstack/react-query";
import { Clock, Mail } from "lucide-react";
import { listMailbox } from "../../lib/api-client.js";
import { useTreeStore } from "../../stores/tree-store.js";

interface MailboxMessage {
  readonly from?: string;
  readonly to?: string;
  readonly timestamp?: number;
  readonly content?: string;
  readonly subject?: string;
  readonly [key: string]: unknown;
}

function extractAgentId(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  const agentsIdx = segments.indexOf("agents");
  if (agentsIdx < 0) return "";
  return segments[agentsIdx + 1] ?? "";
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

export function MailboxDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const agentId = extractAgentId(path);
  const lastInvalidatedAt = useTreeStore((s) => s.lastInvalidatedAt);

  const query = useQuery({
    queryKey: ["mailbox-list", agentId, lastInvalidatedAt],
    queryFn: () => listMailbox(agentId),
    enabled: agentId.length > 0,
    staleTime: 5_000,
    refetchInterval: 5_000,
  });

  if (query.isLoading) {
    return (
      <div className="p-4 text-sm text-[var(--color-muted)]">
        Loading mailbox...
      </div>
    );
  }

  if (query.error !== null) {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to load mailbox
        {query.error instanceof Error ? `: ${query.error.message}` : ""}
      </div>
    );
  }

  const messages = (query.data ?? []) as readonly MailboxMessage[];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Mail className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {agentId.length > 0 ? `${agentId} Mailbox` : "Mailbox"}
        </span>
        <span className="text-xs text-[var(--color-muted)]">
          {messages.length} messages
        </span>
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
                      <span className="text-[var(--color-muted)]">
                        {"\u2192"}
                      </span>
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
