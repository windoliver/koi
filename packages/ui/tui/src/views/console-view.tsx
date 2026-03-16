/**
 * Console view — chat interface with message history and text input.
 *
 * Uses ScrollBox for auto-scrolling message list, Markdown for assistant
 * messages (with streaming support), and Textarea for user input.
 */

import { type SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useCallback, useRef, useState } from "react";
import { PanelChrome } from "../components/panel-chrome.js";
import type { SessionState } from "../state/types.js";
import { COLORS } from "../theme.js";
import { MessageRow } from "./message-row.js";

/** Props for the console view. */
export interface ConsoleViewProps {
  readonly session: SessionState | null;
  readonly pendingText: string;
  readonly onSubmit: (text: string) => void;
  readonly focused: boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

/** Console view with scrollable message list and text input. */
export function ConsoleView(props: ConsoleViewProps): React.ReactNode {
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const [inputText, setInputText] = useState("");

  const handleSubmit = useCallback((): void => {
    const text = inputText.trim();
    if (text === "") return;
    props.onSubmit(text);
    setInputText("");
    if (textareaRef.current !== null) {
      textareaRef.current.setText("");
    }
  }, [inputText, props.onSubmit]);

  const messages = props.session?.messages ?? [];
  const hasPending = props.pendingText.length > 0;

  return (
    <PanelChrome
      title="Console"
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={props.session === null}
      emptyMessage="Select an agent from the Agents panel to start a conversation."
      emptyHint="Use ↑↓ to navigate, Enter to select."
    >
      {/* Message history */}
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        scrollY={true}
      >
        <box flexDirection="column" gap={1}>
          {messages.map((message, i) => (
            <MessageRow key={i} message={message} syntaxStyle={props.syntaxStyle} />
          ))}

          {hasPending && (
            <MessageRow
              message={{
                kind: "assistant",
                text: props.pendingText,
                timestamp: Date.now(),
              }}
              isStreaming={true}
              syntaxStyle={props.syntaxStyle}
            />
          )}
        </box>
      </scrollbox>

      {/* Separator */}
      <box height={1} backgroundColor={COLORS.bg}>
        <text fg={COLORS.dim}>{"─".repeat(80)}</text>
      </box>

      {/* Text input */}
      <textarea
        ref={(el: TextareaRenderable) => { textareaRef.current = el; }}
        height={3}
        focused={props.focused}
        placeholder="Type a message... (Enter to send, / for commands)"
        placeholderColor={COLORS.dim}
        backgroundColor={COLORS.bg}
        textColor={COLORS.white}
        focusedBackgroundColor="#001a33"
        focusedTextColor={COLORS.white}
        onContentChange={() => {
          if (textareaRef.current !== null) {
            setInputText(textareaRef.current.plainText);
          }
        }}
        onSubmit={handleSubmit}
      />
    </PanelChrome>
  );
}
