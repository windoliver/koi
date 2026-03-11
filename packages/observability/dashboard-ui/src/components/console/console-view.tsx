/**
 * ConsoleView — main interactive agent console.
 *
 * Wires the AG-UI chat hook, chat store, message list, and composer
 * into a full interactive console layout.
 */

import { memo, useCallback, useEffect } from "react";
import { useAguiChat } from "../../hooks/use-agui-chat.js";
import { useAgentById } from "../../stores/agents-store.js";
import { useChatError, useChatIsStreaming, useChatStore } from "../../stores/chat-store.js";
import { Composer } from "./composer.js";
import { ConsoleHeader } from "./console-header.js";
import { MessageList } from "./message-list.js";

export interface ConsoleViewProps {
  /** The agent ID to chat with. */
  readonly agentId: string;
  /** Called when the user clicks "Back". */
  readonly onBack: () => void;
}

export const ConsoleView = memo(function ConsoleView({
  agentId,
  onBack,
}: ConsoleViewProps): React.ReactElement {
  const agent = useAgentById(agentId);
  const isStreaming = useChatIsStreaming();
  const error = useChatError();
  const { sendMessage, cancel } = useAguiChat({ agentId });

  // Initialize session when agentId changes
  useEffect(() => {
    useChatStore.getState().setSession({
      agentId,
      sessionId: `sess-${Date.now().toString(36)}`,
      threadId: `thread-${Date.now().toString(36)}`,
    });

    return () => {
      useChatStore.getState().setSession(null);
    };
  }, [agentId]);

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  return (
    <div className="flex h-full flex-col">
      <ConsoleHeader agent={agent} onBack={onBack} />

      {error !== null && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-500">
          {error}
          <button
            type="button"
            onClick={() => { useChatStore.getState().setError(null); }}
            className="ml-2 underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <MessageList />

      <Composer
        onSend={handleSend}
        onCancel={cancel}
        isStreaming={isStreaming}
      />
    </div>
  );
});
