/**
 * MessageRow — renders a single conversation turn.
 *
 * Routes to the correct renderer based on message kind (user/assistant/system).
 * Wrapped in React.memo — only re-renders when the message object changes
 * by reference. The reducer preserves references for unchanged messages.
 */

import React, { memo, type ReactNode } from "react";
import type { SyntaxStyle } from "@opentui/core";
import type { ContentBlock } from "@koi/core/message";
import type { TuiAssistantBlock, TuiMessage } from "../state/types.js";
import { ErrorBlock } from "./error-block.js";
import { TextBlock } from "./text-block.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCallBlock } from "./tool-call-block.js";

interface MessageRowProps {
  readonly message: TuiMessage;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

function AssistantBlock({
  block,
  syntaxStyle,
}: {
  readonly block: TuiAssistantBlock;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}): ReactNode {
  switch (block.kind) {
    case "text":
      return <TextBlock text={block.text} syntaxStyle={syntaxStyle} />;
    case "thinking":
      return <ThinkingBlock text={block.text} />;
    case "tool_call":
      return <ToolCallBlock block={block} />;
    case "error":
      return <ErrorBlock block={block} />;
  }
}

function UserContentBlock({ block }: { readonly block: ContentBlock }): ReactNode {
  switch (block.kind) {
    case "text":
      return <text>{block.text}</text>;
    case "file":
      return <text fg="cyan">[file: {block.name ?? block.url}]</text>;
    case "image":
      return <text fg="cyan">[image: {block.alt ?? block.url}]</text>;
    case "button":
      return <text fg="cyan">[{block.label}]</text>;
    case "custom":
      return <text fg="gray">[{block.type}]</text>;
  }
}

function UserMessage({ message }: { readonly message: TuiMessage & { readonly kind: "user" } }): ReactNode {
  return (
    <box flexDirection="column">
      <text fg="blue">
        <b>You:</b>
      </text>
      <box flexDirection="column" paddingLeft={2}>
        {message.blocks.map((block, i) => (
          <UserContentBlock key={`${block.kind}-${String(i)}`} block={block} />
        ))}
      </box>
    </box>
  );
}

function AssistantMessage({
  message,
  syntaxStyle,
}: {
  readonly message: TuiMessage & { readonly kind: "assistant" };
  readonly syntaxStyle?: SyntaxStyle | undefined;
}): ReactNode {
  return (
    <box flexDirection="column">
      {message.blocks.map((block, i) => (
        <AssistantBlock
          key={block.kind === "tool_call" ? block.callId : `${block.kind}-${String(i)}`}
          block={block}
          syntaxStyle={syntaxStyle}
        />
      ))}
    </box>
  );
}

function SystemMessage({ message }: { readonly message: TuiMessage & { readonly kind: "system" } }): ReactNode {
  return (
    <text fg="yellow">
      <i>{message.text}</i>
    </text>
  );
}

function MessageRowInner({ message, syntaxStyle }: MessageRowProps): ReactNode {
  switch (message.kind) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return <AssistantMessage message={message} syntaxStyle={syntaxStyle} />;
    case "system":
      return <SystemMessage message={message} />;
  }
}

export const MessageRow: React.NamedExoticComponent<MessageRowProps> = memo(MessageRowInner);
