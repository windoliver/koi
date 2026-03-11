/**
 * Console view — chat interface with message history and text input.
 *
 * Uses ScrollBox for auto-scrolling message list, Markdown for assistant
 * messages (with streaming support), and Textarea for user input.
 */

import { type SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { type Accessor, For, Show, createSignal } from "solid-js";
import { COLORS } from "../theme.js";
import type { SessionState } from "../state/types.js";
import { MessageRow } from "./message-row.js";

/** Props for the console view. */
export interface ConsoleViewProps {
  readonly session: Accessor<SessionState | null>;
  readonly pendingText: Accessor<string>;
  readonly onSubmit: (text: string) => void;
  readonly focused: boolean;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

/** Console view with scrollable message list and text input. */
export function ConsoleView(props: ConsoleViewProps): JSX.Element {
  let textareaRef: TextareaRenderable | null = null;
  const [inputText, setInputText] = createSignal("");

  function handleSubmit(): void {
    const text = inputText().trim();
    if (text === "") return;
    props.onSubmit(text);
    setInputText("");
    if (textareaRef !== null) {
      textareaRef.setText("");
    }
  }

  const messages = () => props.session()?.messages ?? [];
  const hasPending = () => props.pendingText().length > 0;

  return (
    <box flexGrow={1} flexDirection="column">
      {/* Message history */}
      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        scrollY={true}
      >
        <box flexDirection="column" gap={1}>
          <For each={messages()}>
            {(message) => <MessageRow message={message} syntaxStyle={props.syntaxStyle} />}
          </For>

          <Show when={hasPending()}>
            <MessageRow
              message={{
                kind: "assistant",
                text: props.pendingText(),
                timestamp: Date.now(),
              }}
              isStreaming={true}
              syntaxStyle={props.syntaxStyle}
            />
          </Show>
        </box>
      </scrollbox>

      {/* Separator */}
      <box height={1} backgroundColor={COLORS.bg}>
        <text fg={COLORS.dim}>{"─".repeat(80)}</text>
      </box>

      {/* Text input */}
      <textarea
        ref={(el: TextareaRenderable) => { textareaRef = el; }}
        height={3}
        focused={props.focused}
        placeholder="Type a message... (Enter to send, / for commands)"
        placeholderColor={COLORS.dim}
        backgroundColor={COLORS.bg}
        textColor={COLORS.white}
        focusedBackgroundColor="#001a33"
        focusedTextColor={COLORS.white}
        onContentChange={() => {
          if (textareaRef !== null) {
            setInputText(textareaRef.plainText);
          }
        }}
        onSubmit={handleSubmit}
      />
    </box>
  );
}
