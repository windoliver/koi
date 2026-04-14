/**
 * ThinkingBlock — renders the model's thinking/reasoning content.
 *
 * Behavior (matches opencode's ReasoningPart pattern):
 * - **During streaming**: expanded, shows thinking content as it arrives
 *   with left border + gray styling
 * - **After streaming**: collapsed to a single summary line showing
 *   character count — saves vertical space for the actual response
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
  const charCount = () => props.text.length;

  return (
    <box flexDirection="column" paddingLeft={1} border={["left"]} borderColor="gray">
      <Show
        when={props.streaming}
        fallback={
          <text fg="gray">
            <i>∴ Thinking ({charCount()} chars) ▸</i>
          </text>
        }
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
              streaming={true}
              fg="gray"
            />
          )}
        </Show>
      </Show>
    </box>
  );
}
