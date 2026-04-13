/**
 * ThinkingBlock — renders the model's thinking/reasoning text.
 *
 * Displayed with a left border and dimmed styling (like opencode's
 * ReasoningPart) to visually distinguish reasoning from the assistant's
 * direct response. Supports streaming — content grows incrementally as
 * thinking_delta events arrive.
 *
 * The `streaming` prop tells the markdown renderer that content is
 * incomplete, enabling markdown healing (closing unclosed fences, bold,
 * etc.) so partial reasoning renders correctly mid-stream.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { healMarkdown } from "../streaming/heal-markdown.js";

interface ThinkingBlockProps {
  readonly text: string;
  readonly streaming?: boolean | undefined;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function ThinkingBlock(props: ThinkingBlockProps): JSX.Element {
  const healed = () => (props.streaming ? healMarkdown(props.text) : props.text);

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      border={["left"]}
      borderColor="gray"
    >
      <text fg="gray">
        <i>Thinking:</i>
      </text>
      <Show
        when={props.syntaxStyle}
        fallback={
          <text fg="gray" selectable>
            <i>{healed()}</i>
          </text>
        }
      >
        {(style: () => SyntaxStyle) => (
          <markdown
            content={healed()}
            syntaxStyle={style()}
            streaming={props.streaming ?? false}
            fg="gray"
          />
        )}
      </Show>
    </box>
  );
}
