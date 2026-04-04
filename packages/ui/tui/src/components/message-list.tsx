/**
 * MessageList — scrollable conversation display.
 *
 * Renders all messages in a <scrollbox> with sticky-scroll pinned to
 * the bottom (newest messages visible during streaming). Relies on
 * the reducer's 1000-message compaction to bound the render tree.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { For } from "solid-js";
import { useTuiStore } from "../store-context.js";
import { MessageRow } from "./message-row.js";

interface MessageListProps {
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function MessageList(props: MessageListProps): JSX.Element {
  const messages = useTuiStore((s) => s.messages);

  return (
    <scrollbox flexGrow={1} stickyScroll>
      <box flexDirection="column" gap={1}>
        <For each={messages()}>
          {(msg) => <MessageRow message={msg} syntaxStyle={props.syntaxStyle} />}
        </For>
      </box>
    </scrollbox>
  );
}
