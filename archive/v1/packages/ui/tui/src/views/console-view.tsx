/**
 * Console view — chat interface with message history and text input.
 *
 * Uses ScrollBox for auto-scrolling message list, Markdown for assistant
 * messages (with streaming support), and Textarea for user input.
 *
 * Enter submits via useKeyboard (global key listener) rather than the
 * textarea's onSubmit prop, because OpenTUI's React reconciler drops
 * onSubmit updates for non-Input renderables on re-render.
 */

import type { KeyEvent, SyntaxStyle, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useRef } from "react";
import { PanelChrome } from "../components/panel-chrome.js";
import type { SessionState } from "../state/types.js";
import { COLORS, separator } from "../theme.js";
import { MessageRow } from "./message-row.js";

/** Props for the console view. */
export interface ConsoleViewProps {
  readonly session: SessionState | null;
  readonly pendingText: string;
  readonly onSubmit: (text: string) => void;
  readonly focused: boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
  readonly cols?: number | undefined;
}

/** Console view with scrollable message list and text input. */
export function ConsoleView(props: ConsoleViewProps): React.ReactNode {
  const textareaRef = useRef<TextareaRenderable | null>(null);

  const handleSubmit = useCallback((): void => {
    if (textareaRef.current === null) return;
    const text = textareaRef.current.plainText.trim();
    if (text === "") return;
    props.onSubmit(text);
    textareaRef.current.setText("");
  }, [props.onSubmit]);

  // Handle Enter key via global listener — fires before the textarea's
  // renderable handler, so we preventDefault to suppress the newline.
  useKeyboard(useCallback((key: KeyEvent): void => {
    if (!props.focused) return;
    if (key.name === "return" && !key.ctrl && !key.meta && !key.shift) {
      key.preventDefault();
      handleSubmit();
    }
  }, [props.focused, handleSubmit]));

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
        <text fg={COLORS.dim}>{separator(props.cols ?? 120)}</text>
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
      />
    </PanelChrome>
  );
}
