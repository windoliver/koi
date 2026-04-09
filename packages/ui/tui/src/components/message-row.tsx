/**
 * MessageRow — renders a single conversation turn.
 */

import type { SyntaxStyle, TreeSitterClient } from "@opentui/core";
import type { ContentBlock } from "@koi/core/message";
import type { Accessor, JSX } from "solid-js";
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import type { TuiAssistantBlock, TuiMessage } from "../state/types.js";
import { ErrorBlock } from "./error-block.js";
import { DEFAULT_SPINNER } from "./spinners.js";
import { TextBlock } from "./text-block.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCallBlock } from "./tool-call-block.js";

type TextBlock_ = TuiAssistantBlock & { readonly kind: "text" };
type ThinkingBlock_ = TuiAssistantBlock & { readonly kind: "thinking" };
type ToolCallBlock_ = TuiAssistantBlock & { readonly kind: "tool_call" };
type ErrorBlock_ = TuiAssistantBlock & { readonly kind: "error" };

interface MessageRowProps {
  readonly message: TuiMessage;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
  /** Accessor so only the leaf StatusIndicator subscribes — not every MessageRow. */
  readonly spinnerFrame: Accessor<number>;
}

function AssistantBlock(props: {
  readonly block: TuiAssistantBlock;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
  readonly streaming?: boolean | undefined;
  readonly spinnerFrame: Accessor<number>;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.block.kind === "text" ? (props.block as TextBlock_) : undefined}>
        {(b: Accessor<TextBlock_>) => (
          <TextBlock
            text={b().text}
            syntaxStyle={props.syntaxStyle}
            streaming={props.streaming}
          />
        )}
      </Match>
      <Match when={props.block.kind === "thinking" ? (props.block as ThinkingBlock_) : undefined}>
        {(b: Accessor<ThinkingBlock_>) => <ThinkingBlock text={b().text} />}
      </Match>
      <Match when={props.block.kind === "tool_call" ? (props.block as ToolCallBlock_) : undefined}>
        {(b: Accessor<ToolCallBlock_>) => (
          <ToolCallBlock
            block={b()}
            spinnerFrame={props.spinnerFrame}
            syntaxStyle={props.syntaxStyle}
          />
        )}
      </Match>
      <Match when={props.block.kind === "error" ? (props.block as ErrorBlock_) : undefined}>
        {(b: Accessor<ErrorBlock_>) => <ErrorBlock block={b()} />}
      </Match>
    </Switch>
  );
}

type TextContent = ContentBlock & { readonly kind: "text" };
type FileContent = ContentBlock & { readonly kind: "file" };
type ImageContent = ContentBlock & { readonly kind: "image" };
type ButtonContent = ContentBlock & { readonly kind: "button" };
type CustomContent = ContentBlock & { readonly kind: "custom" };

function UserContentBlock(props: { readonly block: ContentBlock }): JSX.Element {
  return (
    <Switch>
      <Match when={props.block.kind === "text" ? (props.block as TextContent) : undefined}>
        {(b: Accessor<TextContent>) => <text>{b().text}</text>}
      </Match>
      <Match when={props.block.kind === "file" ? (props.block as FileContent) : undefined}>
        {(b: Accessor<FileContent>) => <text fg="cyan">[file: {b().name ?? b().url}]</text>}
      </Match>
      <Match when={props.block.kind === "image" ? (props.block as ImageContent) : undefined}>
        {(b: Accessor<ImageContent>) => <text fg="cyan">[image: {b().alt ?? b().url}]</text>}
      </Match>
      <Match when={props.block.kind === "button" ? (props.block as ButtonContent) : undefined}>
        {(b: Accessor<ButtonContent>) => <text fg="cyan">[{b().label}]</text>}
      </Match>
      <Match when={props.block.kind === "custom" ? (props.block as CustomContent) : undefined}>
        {(b: Accessor<CustomContent>) => <text fg="gray">[{b().type}]</text>}
      </Match>
    </Switch>
  );
}

type UserMessage_ = TuiMessage & { readonly kind: "user" };
type AssistantMessage_ = TuiMessage & { readonly kind: "assistant" };
type SystemMessage_ = TuiMessage & { readonly kind: "system" };

function UserMessage(props: { readonly message: UserMessage_ }): JSX.Element {
  return (
    <box flexDirection="column">
      <text fg="blue">
        <b>You:</b>
      </text>
      <box flexDirection="column" paddingLeft={2}>
        <For each={props.message.blocks}>
          {(block) => <UserContentBlock block={block} />}
        </For>
      </box>
    </box>
  );
}

/** Duration after which "thought for Xs" label auto-hides. */
const THOUGHT_LABEL_HIDE_MS = 3000;

function AssistantMessage(props: {
  readonly message: AssistantMessage_;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly treeSitterClient?: TreeSitterClient | undefined;
  readonly spinnerFrame: Accessor<number>;
}): JSX.Element {
  // Show thinking indicator while streaming with no content yet
  const isThinking = () =>
    props.message.streaming && props.message.blocks.length === 0;

  // Track thinking duration (like Claude Code's "thought for 3s")
  // `let` justified: mutable timestamp for duration calculation
  let thinkingStartedAt = 0;
  const [thoughtDuration, setThoughtDuration] = createSignal<number | null>(null);

  // When thinking starts, record timestamp
  createEffect(
    on(isThinking, (thinking: boolean, wasThinking: boolean | undefined) => {
      if (thinking && !wasThinking) {
        thinkingStartedAt = Date.now();
        setThoughtDuration(null);
      }
      if (!thinking && wasThinking && thinkingStartedAt > 0) {
        const duration = Math.round((Date.now() - thinkingStartedAt) / 1000);
        if (duration >= 1) {
          setThoughtDuration(duration);
          // Auto-hide after 3 seconds
          setTimeout(() => setThoughtDuration(null), THOUGHT_LABEL_HIDE_MS);
        }
        thinkingStartedAt = 0;
      }
    }),
  );

  return (
    <box flexDirection="column">
      <Show when={isThinking()}>
        <text fg="gray">
          {DEFAULT_SPINNER.frames[props.spinnerFrame() % DEFAULT_SPINNER.frames.length] ?? " "}{" "}
          <i>Thinking…</i>
        </text>
      </Show>
      <Show when={thoughtDuration() !== null}>
        <text fg="gray">
          <i>∴ thought for {thoughtDuration()}s</i>
        </text>
      </Show>
      <For each={props.message.blocks}>
        {(block) => (
          <AssistantBlock
            block={block}
            syntaxStyle={props.syntaxStyle}
            treeSitterClient={props.treeSitterClient}
            streaming={props.message.streaming}
            spinnerFrame={props.spinnerFrame}
          />
        )}
      </For>
    </box>
  );
}

function SystemMessage(props: { readonly message: SystemMessage_ }): JSX.Element {
  return (
    <text fg="yellow">
      <i>{props.message.text}</i>
    </text>
  );
}

export function MessageRow(props: MessageRowProps): JSX.Element {
  return (
    <Switch>
      <Match when={props.message.kind === "user" ? (props.message as UserMessage_) : undefined}>
        {(msg: Accessor<UserMessage_>) => <UserMessage message={msg()} />}
      </Match>
      <Match
        when={
          props.message.kind === "assistant"
            ? (props.message as AssistantMessage_)
            : undefined
        }
      >
        {(msg: Accessor<AssistantMessage_>) => (
          <AssistantMessage
            message={msg()}
            syntaxStyle={props.syntaxStyle}
            treeSitterClient={props.treeSitterClient}
            spinnerFrame={props.spinnerFrame}
          />
        )}
      </Match>
      <Match when={props.message.kind === "system" ? (props.message as SystemMessage_) : undefined}>
        {(msg: Accessor<SystemMessage_>) => <SystemMessage message={msg()} />}
      </Match>
    </Switch>
  );
}
