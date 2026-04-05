/**
 * ConversationView — the "conversation" screen (activeView === "conversation").
 *
 * Composes MessageList (read-only scroll) + InputArea (text input). This is
 * the only substantive view in Phase 2j-5. Sessions/doctor/help are stubs —
 * they will be replaced in future phases.
 *
 * Decision 7A: create ConversationView wrapper now; honest 1-line stubs for
 * the three remaining views rather than leaving them undefined.
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

// ---------------------------------------------------------------------------
// Placeholder views — Phase 2j-5 stubs, replaced in future phases
// ---------------------------------------------------------------------------

export function SessionsPlaceholder(): JSX.Element {
  return <text fg="#64748B">{"[sessions view — coming in a future phase]"}</text>;
}

export function DoctorPlaceholder(): JSX.Element {
  return <text fg="#64748B">{"[doctor view — coming in a future phase]"}</text>;
}

export function HelpPlaceholder(): JSX.Element {
  return <text fg="#64748B">{"[help view — coming in a future phase]"}</text>;
}
