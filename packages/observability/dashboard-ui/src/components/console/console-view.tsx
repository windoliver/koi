/**
 * ConsoleView — main interactive agent console.
 *
 * Wires the AG-UI chat hook, chat store, session history, message list,
 * and composer into a full interactive console layout with session
 * persistence, retry, and reconnection handling.
 */

import { memo, useCallback, useEffect, useState } from "react";
import { useAguiChat } from "../../hooks/use-agui-chat.js";
import { useSessionHistory } from "../../hooks/use-session-history.js";
import { useAgentById } from "../../stores/agents-store.js";
import {
  useChatAgentTerminated,
  useChatError,
  useChatIsStreaming,
  useChatStore,
  useLastUserMessage,
} from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { Composer } from "./composer.js";
import { ConsoleHeader } from "./console-header.js";
import { MessageList } from "./message-list.js";
import { SessionPicker } from "./session-picker.js";

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
  const lastUserMessage = useLastUserMessage();
  const agentTerminated = useChatAgentTerminated();
  const connectionStatus = useConnectionStore((s) => s.status);
  const [showSessions, setShowSessions] = useState(true);

  const { sessions, isLoading: sessionsLoading, loadSession, refresh, persistCurrentSession } =
    useSessionHistory(agentId);

  const { sendMessage, cancel, retry } = useAguiChat({
    agentId,
    onStreamEnd: persistCurrentSession,
  });

  // Initialize session when agentId changes
  useEffect(() => {
    useChatStore.getState().setSession({
      agentId,
      sessionId: `sess-${Date.now().toString(36)}`,
      threadId: `thread-${Date.now().toString(36)}`,
    });

    return () => {
      // Persist before unmounting
      void persistCurrentSession();
      useChatStore.getState().setSession(null);
    };
  }, [agentId, persistCurrentSession]);

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  const handleRetry = useCallback(() => {
    retry();
  }, [retry]);

  const handleDismissError = useCallback(() => {
    useChatStore.getState().setError(null);
  }, []);

  const handleNewSession = useCallback(() => {
    // Persist current session before starting new one
    void persistCurrentSession().then(() => {
      useChatStore.getState().setSession({
        agentId,
        sessionId: `sess-${Date.now().toString(36)}`,
        threadId: `thread-${Date.now().toString(36)}`,
      });
      refresh();
    });
  }, [agentId, persistCurrentSession, refresh]);

  const handleSelectSession = useCallback(
    (entry: { readonly sessionId: string; readonly path: string; readonly modifiedAt: number; readonly size: number }) => {
      // Persist current session first, then load selected
      void persistCurrentSession().then(() => {
        void loadSession(entry);
      });
    },
    [persistCurrentSession, loadSession],
  );

  const currentSessionId = useChatStore((s) => s.session?.sessionId ?? null);
  const canRetry = error !== null && lastUserMessage !== null && !isStreaming;

  return (
    <div className="flex h-full">
      {/* Session sidebar */}
      {showSessions && (
        <SessionPicker
          sessions={sessions}
          isLoading={sessionsLoading}
          currentSessionId={currentSessionId}
          onSelect={handleSelectSession}
          onNewSession={handleNewSession}
        />
      )}

      {/* Main console area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ConsoleHeader
          agent={agent}
          onBack={onBack}
          connectionStatus={connectionStatus}
          agentTerminated={agentTerminated}
        />

        {/* Error banner with retry */}
        {error !== null && (
          <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-500">
            <span className="flex-1">{error}</span>
            {canRetry && (
              <button
                type="button"
                onClick={handleRetry}
                className="rounded bg-red-500/20 px-2 py-0.5 font-medium hover:bg-red-500/30"
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={handleDismissError}
              className="underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Terminated banner */}
        {agentTerminated && error === null && (
          <div className="border-b border-yellow-500/20 bg-yellow-500/10 px-4 py-2 text-xs text-yellow-600">
            Agent has been terminated. Start a new session or switch to a different agent.
          </div>
        )}

        <MessageList />

        <Composer
          onSend={handleSend}
          onCancel={cancel}
          isStreaming={isStreaming}
          disabled={agentTerminated}
        />
      </div>
    </div>
  );
});
