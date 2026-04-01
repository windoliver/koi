/**
 * MessageBubble — renders a single ChatMessage in the console.
 *
 * Handles all message kinds: user, assistant, tool_call, lifecycle.
 * Assistant messages are rendered as markdown via react-markdown.
 */

import { ChevronDown, ChevronRight, Terminal, User, Wrench } from "lucide-react";
import { memo, useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage } from "../../stores/chat-store.js";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function UserBubble({ message }: { readonly message: Extract<ChatMessage, { readonly kind: "user" }> }): React.ReactElement {
  return (
    <div className="mr-8 rounded-lg border border-[var(--color-border)] p-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <User className="h-3 w-3" />
        <span className="font-medium">You</span>
        <span>{formatTime(message.timestamp)}</span>
      </div>
      <div className="whitespace-pre-wrap text-sm">{message.text}</div>
    </div>
  );
}

function AssistantBubble({ message }: { readonly message: Extract<ChatMessage, { readonly kind: "assistant" }> }): React.ReactElement {
  return (
    <div className="ml-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-primary)]/5 p-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <Terminal className="h-3 w-3" />
        <span className="font-medium">Assistant</span>
        <span>{formatTime(message.timestamp)}</span>
      </div>
      <div className="prose prose-sm max-w-none dark:prose-invert text-sm">
        <Markdown>{message.text}</Markdown>
      </div>
    </div>
  );
}

function ToolCallBubble({ message }: { readonly message: Extract<ChatMessage, { readonly kind: "tool_call" }> }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ml-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/5 p-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        onClick={() => { setExpanded((prev) => !prev); }}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Wrench className="h-3 w-3" />
        <span className="font-mono font-medium">{message.name}</span>
        <span>{formatTime(message.timestamp)}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div>
            <div className="text-xs font-medium text-[var(--color-muted)]">Arguments</div>
            <pre className="mt-1 overflow-auto rounded bg-[var(--color-muted)]/10 p-2 font-mono text-xs">
              {formatJson(message.args)}
            </pre>
          </div>
          {message.result !== undefined && (
            <div>
              <div className="text-xs font-medium text-[var(--color-muted)]">Result</div>
              <pre className="mt-1 overflow-auto rounded bg-[var(--color-muted)]/10 p-2 font-mono text-xs max-h-48">
                {formatJson(message.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LifecycleBubble({ message }: { readonly message: Extract<ChatMessage, { readonly kind: "lifecycle" }> }): React.ReactElement {
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-xs italic text-[var(--color-muted)]">
      <span>{message.event}</span>
      <span>{formatTime(message.timestamp)}</span>
    </div>
  );
}

/** Try to pretty-print JSON, fall back to raw string. */
function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Render a ChatMessage based on its kind. */
export const MessageBubble = memo(function MessageBubble({
  message,
}: {
  readonly message: ChatMessage;
}): React.ReactElement {
  switch (message.kind) {
    case "user":
      return <UserBubble message={message} />;
    case "assistant":
      return <AssistantBubble message={message} />;
    case "tool_call":
      return <ToolCallBubble message={message} />;
    case "lifecycle":
      return <LifecycleBubble message={message} />;
  }
});
