/**
 * TextBlock — renders a text block.
 *
 * Uses <text> for reliable baseline rendering. When syntaxStyle is provided
 * (indicating tree-sitter is available), upgrades to <markdown> for rich
 * rendering with syntax-highlighted code fences.
 *
 * The streaming prop prevents <markdown> from finalizing incomplete syntax
 * (e.g., unclosed backtick fences) during LLM streaming. Set streaming=true
 * while the message is still receiving deltas; false (default) when complete.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { Show } from "solid-js";

interface TextBlockProps {
  readonly text: string;
  readonly syntaxStyle?: SyntaxStyle | undefined;
  readonly streaming?: boolean | undefined;
}

export function TextBlock(props: TextBlockProps): JSX.Element {
  return (
    <Show
      when={props.syntaxStyle}
      fallback={<text>{props.text}</text>}
    >
      {(style: () => SyntaxStyle) => (
        <markdown
          content={props.text}
          syntaxStyle={style()}
          streaming={props.streaming ?? false}
        />
      )}
    </Show>
  );
}
