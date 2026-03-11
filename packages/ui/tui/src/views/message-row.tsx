/**
 * Message row — renders a single ChatMessage in the console view.
 *
 * Dispatches on message.kind to render user input, assistant markdown,
 * tool calls, and lifecycle events with appropriate styling.
 */

import type { ChatMessage } from "@koi/dashboard-client";
import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";
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

/** Extract text from user or assistant message, empty string otherwise. */
function messageText(msg: ChatMessage): string {
  if (msg.kind === "user" || msg.kind === "assistant") return msg.text;
  return "";
}

/** Render a single chat message row. */
export function MessageRow(props: MessageRowProps): JSX.Element {
  return (
    <>
      <Show when={props.message.kind === "user"}>
        <box flexDirection="row">
          <text fg={COLORS.green}><b>{"❯ "}</b></text>
          <text fg={COLORS.white}>{messageText(props.message)}</text>
        </box>
      </Show>

      <Show when={props.message.kind === "assistant"}>
        {props.syntaxStyle !== undefined ? (
          <markdown
            content={messageText(props.message)}
            streaming={props.isStreaming === true}
            syntaxStyle={props.syntaxStyle}
          />
        ) : (
          <text fg={COLORS.white}>{messageText(props.message)}</text>
        )}
      </Show>

      <Show when={props.message.kind === "tool_call"}>
        {(() => {
          const m = props.message;
          if (m.kind !== "tool_call") return null;
          return (
            <box flexDirection="column">
              <box flexDirection="row">
                <text fg={COLORS.dim}>{"⚙ "}</text>
                <text fg={COLORS.cyan}>{m.name}</text>
                <text fg={COLORS.dim}>{`(${truncate(m.args, MAX_INLINE_LENGTH)})`}</text>
              </box>
              <Show when={m.result !== undefined}>
                <text fg={COLORS.dim}>{`  → ${truncate(m.result ?? "", MAX_INLINE_LENGTH)}`}</text>
              </Show>
            </box>
          );
        })()}
      </Show>

      <Show when={props.message.kind === "lifecycle"}>
        {(() => {
          const m = props.message;
          if (m.kind !== "lifecycle") return null;
          return (
            <text fg={COLORS.yellow}>
              <i>{`  ${m.event}`}</i>
            </text>
          );
        })()}
      </Show>
    </>
  );
}
