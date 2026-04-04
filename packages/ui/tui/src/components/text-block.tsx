/**
 * TextBlock — renders a text block.
 *
 * Uses <text> for reliable baseline rendering. When syntaxStyle is provided
 * (indicating tree-sitter is available), upgrades to <markdown> for rich
 * rendering with syntax-highlighted code fences.
 */

import type { SyntaxStyle } from "@opentui/core";
import type { JSX } from "solid-js";
import { Show } from "solid-js";

interface TextBlockProps {
  readonly text: string;
  readonly syntaxStyle?: SyntaxStyle | undefined;
}

export function TextBlock(props: TextBlockProps): JSX.Element {
  return (
    <Show
      when={props.syntaxStyle !== undefined ? props.syntaxStyle : undefined}
      fallback={<text>{props.text}</text>}
    >
      {(style: () => SyntaxStyle) => <markdown content={props.text} syntaxStyle={style()} />}
    </Show>
  );
}
