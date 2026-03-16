/**
 * ConsoleView — main interactive agent console.
 *
 * Wires the AG-UI chat hook, chat store, session history, message list,
 * and composer into a full interactive console layout with session
 * persistence, retry, and reconnection handling.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ChatHistoryMessage } from "@koi/dashboard-types";
import { useAguiChat } from "../../hooks/use-agui-chat.js";
import { useSessionHistory } from "../../hooks/use-session-history.js";
import { useAgentById } from "../../stores/agents-store.js";
import {
  type ChatMessage,
  useChatAgentTerminated,
  useChatError,
  useChatIsStreaming,
  useChatStore,
  useLastUserMessage,
} from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { usePtyBuffer, useTerminalActive, useTerminalStore } from "../../stores/terminal-store.js";
import { AgentTerminal } from "./agent-terminal.js";
import { Composer } from "./composer.js";
import { ConsoleHeader } from "./console-header.js";
import { MessageList } from "./message-list.js";
import { SessionPicker } from "./session-picker.js";

/** Convert stored ChatMessages to AG-UI history format for context continuity. */
function buildChatHistory(messages: readonly ChatMessage[]): readonly ChatHistoryMessage[] {
  const history: ChatHistoryMessage[] = [];
  for (const msg of messages) {
    if (msg.kind === "user" || msg.kind === "assistant") {
      history.push({
        id: `hist-${String(history.length)}`,
        role: msg.kind,
        content: msg.text,
      });
    }
  }
  return history;
}

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
  const terminalMode = useTerminalActive(agentId);
  const ptyData = usePtyBuffer(agentId);
  const [showSessions, setShowSessions] = useState(true);

  const { sessions, isLoading: sessionsLoading, loadSession, refresh, persistCurrentSession } =
    useSessionHistory(agentId);

  const { sendMessage, cancel, retry } = useAguiChat({
    agentId,
    onStreamEnd: persistCurrentSession,
  });

  // Guard against concurrent session operations
  const switchingRef = useRef(false);

  // Initialize session when agentId changes.
  // Use a single ID for both sessionId and threadId so the browser and
  // server persist to the same file (fixes split-brain issue).
  useEffect(() => {
    const id = `chat-${Date.now().toString(36)}`;
    const store = useChatStore.getState();
    store.setSession({
      agentId,
      sessionId: id,
      threadId: id,
    });
    // Sync terminated state from the agent store — prevents re-enabling
    // the composer for an already-terminated agent.
    store.setAgentTerminated(agent?.state === "terminated");

    return () => {
      // Persist before unmounting
      void persistCurrentSession();
      cancel();
      useChatStore.getState().setSession(null);
    };
  }, [agentId, agent?.state, persistCurrentSession, cancel]);

  const handleSend = useCallback(
    (text: string) => {
      // Pass existing messages as history so the agent has prior context
      const history = buildChatHistory(useChatStore.getState().messages);
      sendMessage(text, history);
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
    if (switchingRef.current) return;
    switchingRef.current = true;
    // Abort any in-flight stream before switching
    cancel();
    void persistCurrentSession().then(() => {
      const newId = `chat-${Date.now().toString(36)}`;
      useChatStore.getState().setSession({
        agentId,
        sessionId: newId,
        threadId: newId,
      });
      refresh();
      switchingRef.current = false;
    });
  }, [agentId, persistCurrentSession, refresh, cancel]);

  const handleSelectSession = useCallback(
    (entry: { readonly sessionId: string; readonly path: string; readonly modifiedAt: number; readonly size: number }) => {
      if (switchingRef.current) return;
      switchingRef.current = true;
      // Abort any in-flight stream before switching
      cancel();
      void persistCurrentSession().then(() => {
        void loadSession(entry).then(() => {
          switchingRef.current = false;
        });
      });
    },
    [persistCurrentSession, loadSession, cancel],
  );

  const handleToggleTerminal = useCallback(() => {
    useTerminalStore.getState().setTerminalActive(agentId, !terminalMode);
  }, [agentId, terminalMode]);

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
          terminalMode={terminalMode}
          onToggleTerminal={handleToggleTerminal}
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

        {terminalMode ? (
          <AgentTerminal agentId={agentId} ptyData={ptyData} />
        ) : (
          <>
            <MessageList />

            <Composer
              onSend={handleSend}
              onCancel={cancel}
              isStreaming={isStreaming}
              disabled={agentTerminated}
            />
          </>
        )}
      </div>
    </div>
  );
});
