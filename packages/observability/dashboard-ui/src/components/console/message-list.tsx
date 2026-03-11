/**
 * MessageList — windowed rendering of chat messages.
 *
 * Renders the last MAX_RENDERED_MESSAGES messages with auto-scroll
 * to bottom on new messages. Shows "Load earlier messages" when
 * total message count exceeds the rendered window.
 */

import { memo, useCallback, useEffect, useRef } from "react";
import {
  type ChatMessage,
  MAX_RENDERED_MESSAGES,
  useChatStore,
  useRenderedMessages,
} from "../../stores/chat-store.js";
import { MessageBubble } from "./message-bubble.js";
import { StreamingIndicator } from "./streaming-indicator.js";

export const MessageList = memo(function MessageList(): React.ReactElement {
  const messages = useRenderedMessages();
  const totalCount = useChatStore((s) => s.messages.length);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingText = useChatStore((s) => s.pendingText);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Track whether user has scrolled up
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distanceFromBottom < 50;
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingText]);

  const hasEarlier = totalCount > MAX_RENDERED_MESSAGES;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto p-4"
    >
      {hasEarlier && (
        <div className="mb-4 text-center text-xs text-[var(--color-muted)]">
          {totalCount - MAX_RENDERED_MESSAGES} earlier messages not shown
        </div>
      )}

      {messages.length === 0 && !isStreaming && (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
          Send a message to start the conversation
        </div>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((msg, i) => (
          <MessageBubble key={messageKey(msg, i)} message={msg} />
        ))}
      </div>

      {isStreaming && pendingText !== "" && (
        <StreamingIndicator text={pendingText} />
      )}

      {isStreaming && pendingText === "" && messages.length > 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-muted)]">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
          Thinking...
        </div>
      )}
    </div>
  );
});

/** Generate a stable key for a message. */
function messageKey(msg: ChatMessage, index: number): string {
  return `${msg.kind}-${String(msg.timestamp)}-${String(index)}`;
}
