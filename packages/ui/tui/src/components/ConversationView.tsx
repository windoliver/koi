/**
 * ConversationView — the "conversation" screen (activeView === "conversation").
 *
 * Composes MessageList (read-only scroll) + InputArea (text input).
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { InputArea } from "./InputArea.js";
import { MessageList } from "./message-list.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationViewProps {
  /** Called when the user submits a message (Enter). */
  readonly onSubmit: (text: string) => void;
  /** Called when a slash command prefix is typed. Null = no active prefix. */
  readonly onSlashDetected: (query: string | null) => void;
  /** Whether this view has keyboard focus (false when any modal is open). */
  readonly focused: boolean;
  /** Optional syntax highlighting style for code blocks in messages. */
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

// ---------------------------------------------------------------------------
// Conversation view
// ---------------------------------------------------------------------------

export function ConversationView(props: ConversationViewProps): JSX.Element {
  return (
    <box flexDirection="column" flexGrow={1}>
      <MessageList syntaxStyle={props.syntaxStyle} />
      <InputArea
        onSubmit={props.onSubmit}
        onSlashDetected={props.onSlashDetected}
        focused={props.focused}
      />
    </box>
  );
}

