/**
 * MessageList — scrollable conversation display.
 *
 * Renders all messages in a <scrollbox> with sticky-scroll pinned to
 * the bottom (newest messages visible during streaming). Relies on
 * the reducer's 1000-message compaction to bound the render tree.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { ReactNode } from "react";
import { useTuiStore } from "../store-context.js";
import { MessageRow } from "./message-row.js";

interface MessageListProps {
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function MessageList({ syntaxStyle }: MessageListProps): ReactNode {
  const messages = useTuiStore((s) => s.messages);

  return (
    <scrollbox flexGrow={1} stickyScroll>
      <box flexDirection="column" gap={1}>
        {messages.map((msg) => (
          <MessageRow key={msg.id} message={msg} syntaxStyle={syntaxStyle} />
        ))}
      </box>
    </scrollbox>
  );
}
