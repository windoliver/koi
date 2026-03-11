/**
 * Message row — renders a single ChatMessage in the console view.
 *
 * Dispatches on message.kind to render user input, assistant markdown,
 * tool calls, and lifecycle events with appropriate styling.
 */

import type { ChatMessage } from "@koi/dashboard-client";
import type { SyntaxStyle } from "@opentui/core";
import { COLORS } from "../theme.js";

/** Maximum characters to show for tool call args/result inline. */
const MAX_INLINE_LENGTH = 200;

/** Props for rendering a single message. */
export interface MessageRowProps {
  readonly message: ChatMessage;
  readonly isStreaming?: boolean | undefined;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

/** Truncate a string to maxLen with ellipsis. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

/** Render a single chat message row. */
export function MessageRow(props: MessageRowProps): React.ReactNode {
  const msg = props.message;

  if (msg.kind === "user") {
    return (
      <box flexDirection="row">
        <text fg={COLORS.green}><b>{"❯ "}</b></text>
        <text fg={COLORS.white}>{msg.text}</text>
      </box>
    );
  }

  if (msg.kind === "assistant") {
    if (props.syntaxStyle !== undefined) {
      return (
        <markdown
          content={msg.text}
          streaming={props.isStreaming === true}
          syntaxStyle={props.syntaxStyle}
        />
      );
    }
    return <text fg={COLORS.white}>{msg.text}</text>;
  }

  if (msg.kind === "tool_call") {
    return (
      <box flexDirection="column">
        <box flexDirection="row">
          <text fg={COLORS.dim}>{"⚙ "}</text>
          <text fg={COLORS.cyan}>{msg.name}</text>
          <text fg={COLORS.dim}>{`(${truncate(msg.args, MAX_INLINE_LENGTH)})`}</text>
        </box>
        {msg.result !== undefined && (
          <text fg={COLORS.dim}>{`  → ${truncate(msg.result, MAX_INLINE_LENGTH)}`}</text>
        )}
      </box>
    );
  }

  if (msg.kind === "lifecycle") {
    return (
      <text fg={COLORS.yellow}>
        <i>{`  ${msg.event}`}</i>
      </text>
    );
  }

  // Exhaustive — should never reach here
  return <></>;
}
