/**
 * ThinkingBlock — renders the model's thinking/reasoning content.
 *
 * Always visible with left border + dimmed styling (like opencode's
 * ReasoningPart with showThinking=true). Content streams in during
 * generation and remains visible after completion so the user can
 * review the model's reasoning.
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
  const content = () => (props.streaming ? healMarkdown(props.text) : props.text);

  return (
    <box flexDirection="column" paddingLeft={1} border={["left"]} borderColor="gray">
      <text fg="gray">
        <i>Thinking:</i>
      </text>
      <Show
        when={props.syntaxStyle}
        fallback={
          <text fg="gray" selectable>
            <i>{content()}</i>
          </text>
        }
      >
        {(style: () => SyntaxStyle) => (
          <markdown
            content={content()}
            syntaxStyle={style()}
            streaming={props.streaming ?? false}
            fg="gray"
          />
        )}
      </Show>
    </box>
  );
}
